import { PaymentUnavailableError } from "../core/errors.js";
import type { PaymentAuthorization, PaymentAuthorizationRequest, PaymentGateway } from "../core/ports.js";

const PAYMENTS_BASE_URL = "https://payments.payments.internal";
const AUTHORIZATIONS_PATH = "/v1/authorizations";

/** Provider answers that mean "refused", as opposed to "something went wrong". */
const DECLINE_STATUSES: ReadonlySet<number> = new Set([402, 409, 422]);

type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpPaymentGatewayOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Total tries for transport failures and 5xx answers. Safe because the request is idempotent. */
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  /** Replaces the global `fetch`; used by tests so that no network is involved. */
  readonly fetchFunction?: FetchFunction;
}

/**
 * Payments API client.
 * 2xx -> authorized; 402/409/422 -> declined (a normal result); anything else -> unavailable.
 * The order id is sent as the idempotency key, so a retried request cannot authorize twice.
 */
export class HttpPaymentGateway implements PaymentGateway {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchFunction: FetchFunction | undefined;

  constructor(options: HttpPaymentGatewayOptions = {}) {
    this.baseUrl = options.baseUrl ?? PAYMENTS_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.fetchFunction = options.fetchFunction;
  }

  async authorize(request: PaymentAuthorizationRequest): Promise<PaymentAuthorization> {
    let lastFailure: PaymentUnavailableError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (attempt > 1 && this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt - 1)));
      }
      try {
        return await this.sendOnce(request);
      } catch (error) {
        if (!(error instanceof PaymentUnavailableError)) {
          throw error;
        }
        lastFailure = error;
      }
    }
    throw lastFailure ?? new PaymentUnavailableError("Payments API request failed");
  }

  private async sendOnce(request: PaymentAuthorizationRequest): Promise<PaymentAuthorization> {
    const send = this.fetchFunction ?? globalThis.fetch;
    let response: Response;
    try {
      response = await send(`${this.baseUrl}${AUTHORIZATIONS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": request.orderId },
        body: JSON.stringify({
          orderId: request.orderId,
          customerId: request.customerId,
          amountMinor: request.amountMinor,
          currency: request.currency,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new PaymentUnavailableError("Payments API request failed", { cause });
    }

    if (DECLINE_STATUSES.has(response.status)) {
      return { authorized: false, declineReason: await readReason(response) };
    }
    if (!response.ok) {
      throw new PaymentUnavailableError(`Payments API answered ${response.status}`);
    }
    const body = await readJson(response);
    if (body.status === "declined") {
      return { authorized: false, declineReason: stringOr(body.reason, "declined by provider") };
    }
    return typeof body.authorizationId === "string"
      ? { authorized: true, reference: body.authorizationId }
      : { authorized: true };
  }
}

async function readReason(response: Response): Promise<string> {
  const body = await readJson(response);
  return stringOr(body.reason, `provider answered ${response.status}`);
}

/** Best-effort JSON read: an empty or non-JSON body is treated as an empty object. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
