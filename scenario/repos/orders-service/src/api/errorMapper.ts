import {
  DomainError,
  InvalidStateError,
  OrderNotFoundError,
  PaymentDeclinedError,
  PaymentUnavailableError,
  ValidationError,
} from "../core/errors.js";
import { errorResponse, type HttpResponse } from "./http.js";

/**
 * Maps a failure to an HTTP response. Domain errors have a stable status and code;
 * anything else is an unexpected failure and is reported as a generic 500 without leaking details.
 */
export function toErrorResponse(error: unknown): HttpResponse {
  if (error instanceof ValidationError) {
    return errorResponse(400, error.code, "The request is not valid", error.issues);
  }
  if (error instanceof OrderNotFoundError) {
    return errorResponse(404, error.code, error.message);
  }
  if (error instanceof InvalidStateError) {
    return errorResponse(409, error.code, error.message);
  }
  if (error instanceof PaymentDeclinedError) {
    return errorResponse(402, error.code, error.message);
  }
  if (error instanceof PaymentUnavailableError) {
    return errorResponse(502, error.code, "The payment provider is unavailable");
  }
  if (error instanceof DomainError) {
    return errorResponse(422, error.code, error.message);
  }
  return errorResponse(500, "internal_error", "Unexpected error");
}
