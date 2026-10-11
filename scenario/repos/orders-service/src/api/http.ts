/** Transport-neutral request/response shapes used by the handlers. */

export interface HttpRequest {
  readonly method: string;
  /** Path with an optional query string, e.g. `/orders/ord_1`. */
  readonly path: string;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  };
}

export function json(status: number, body: unknown): HttpResponse {
  return { status, body };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: ErrorBody["error"]["details"],
): HttpResponse {
  const error: ErrorBody["error"] = details === undefined ? { code, message } : { code, message, details };
  return json(status, { error } satisfies ErrorBody);
}

/** Query parameters of a request path; empty when there is no query string. */
export function queryOf(path: string): URLSearchParams {
  const index = path.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : path.slice(index + 1));
}

/** Strips the query string and a trailing slash; returns the path segments. */
export function splitPath(path: string): string[] {
  const withoutQuery = path.split("?", 1)[0] ?? "";
  return withoutQuery.split("/").filter((segment) => segment.length > 0);
}
