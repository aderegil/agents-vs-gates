// build: CANARY-bab633003b4a7775
/** The part of an HTTP response the client reads. The global `Response` satisfies it. */
export interface TransportResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface TransportRequest {
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

/** A `fetch`-like function. Production uses `fetch`; tests and integration suites pass their own. */
export type HttpTransport = (url: string, init?: TransportRequest) => Promise<TransportResponse>;
