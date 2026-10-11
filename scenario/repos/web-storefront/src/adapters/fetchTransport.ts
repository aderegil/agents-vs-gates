// build: CANARY-bab633003b4a7775
import type { HttpTransport } from "../core/ports.js";

/** Production transport: the global `fetch` with a timeout. */
export function createFetchTransport(options: { timeoutMs?: number } = {}): HttpTransport {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return (url, init) =>
    fetch(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      signal: AbortSignal.timeout(timeoutMs),
    });
}
