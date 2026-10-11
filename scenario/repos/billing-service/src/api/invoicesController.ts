// build: CANARY-d61e78f017ccf353
import { BillingError, InvalidInvoiceStateError, InvoiceNotFoundError } from "../core/errors.js";
import type { Invoice } from "../core/invoice.js";
import type { Clock, InvoiceRepository } from "../core/ports.js";
import { recordPayment } from "../core/reminders.js";

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

export interface InvoiceResponse {
  readonly id: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly dueAt: string;
}

export interface InvoicesController {
  handle(method: string, path: string): Promise<HttpResult>;
}

export interface InvoicesControllerDeps {
  readonly invoices: InvoiceRepository;
  readonly clock: Clock;
}

export function toInvoiceResponse(invoice: Invoice): InvoiceResponse {
  return {
    id: invoice.id,
    orderId: invoice.orderId,
    amountCents: invoice.amountCents,
    currency: invoice.currency,
    status: invoice.status,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
  };
}

function failure(status: number, code: string, message: string): HttpResult {
  return { status, body: { error: { code, message } } };
}

/**
 * Invoice API:
 *   GET  /invoices/{id}           -> 200 invoice | 404
 *   GET  /invoices?orderId={id}   -> 200 invoice | 404
 *   POST /invoices/{id}/paid      -> 200 invoice | 404 | 409 (already paid)
 */
export function createInvoicesController(deps: InvoicesControllerDeps): InvoicesController {
  return {
    async handle(method: string, path: string): Promise<HttpResult> {
      try {
        return await dispatch(deps, method.toUpperCase(), path);
      } catch (error) {
        if (error instanceof InvoiceNotFoundError) {
          return failure(404, error.code, error.message);
        }
        if (error instanceof InvalidInvoiceStateError) {
          return failure(409, error.code, error.message);
        }
        if (error instanceof BillingError) {
          return failure(422, error.code, error.message);
        }
        return failure(500, "internal_error", "Unexpected error");
      }
    },
  };
}

async function dispatch(deps: InvoicesControllerDeps, method: string, path: string): Promise<HttpResult> {
  const [pathname = "", query = ""] = path.split("?", 2);
  const [root, id, action] = pathname.split("/").filter((segment) => segment !== "");
  if (root !== "invoices" || (id === undefined && action !== undefined) || (action !== undefined && action !== "paid")) {
    return failure(404, "route_not_found", `No route for ${path}`);
  }

  if (action === "paid" && id !== undefined) {
    if (method !== "POST") {
      return failure(405, "method_not_allowed", "Allowed: POST");
    }
    return { status: 200, body: toInvoiceResponse(await recordPayment(deps, decodeURIComponent(id))) };
  }
  if (method !== "GET") {
    return failure(405, "method_not_allowed", "Allowed: GET");
  }

  if (id !== undefined) {
    const invoice = await deps.invoices.findById(decodeURIComponent(id));
    if (invoice === undefined) {
      throw new InvoiceNotFoundError(id);
    }
    return { status: 200, body: toInvoiceResponse(invoice) };
  }

  const orderId = new URLSearchParams(query).get("orderId");
  if (orderId === null || orderId === "") {
    return failure(400, "validation_failed", "orderId is required");
  }
  const invoice = await deps.invoices.findByOrderId(orderId);
  if (invoice === undefined) {
    throw new InvoiceNotFoundError(`for order ${orderId}`);
  }
  return { status: 200, body: toInvoiceResponse(invoice) };
}
