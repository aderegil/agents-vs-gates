// build: CANARY-bab633003b4a7775
import type { HttpTransport, TransportResponse } from "../src/core/ports.js";

/** A sample `GET /orders/{id}` body: 3 x $4.99 + 1 x $10.00 = $24.97. */
export function sampleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ord-1",
    status: "placed",
    placedAt: "2026-10-10T12:00:00.000Z",
    currency: "USD",
    totalCents: 2497,
    lines: [
      { sku: "CAB-1", name: "USB cable", qty: 3, unitPriceCents: 499 },
      { sku: "ADP-1", name: "Wall adapter", qty: 1, unitPriceCents: 1000 },
    ],
    ...overrides,
  };
}

export function without(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[field];
  return copy;
}

export function reply(status: number, body: unknown): TransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) {
        throw body;
      }
      return body;
    },
  };
}

/** A transport that answers from a queue and records the requested URLs. */
export function scriptedTransport(...answers: Array<TransportResponse | Error>): {
  transport: HttpTransport;
  urls: string[];
} {
  const urls: string[] = [];
  const queue = [...answers];
  const transport: HttpTransport = async (url) => {
    urls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) {
      throw new Error("scriptedTransport: no answer configured");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { transport, urls };
}
