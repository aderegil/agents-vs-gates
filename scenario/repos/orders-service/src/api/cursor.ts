import { ValidationError } from "../core/errors.js";
import type { OrderCursor } from "../core/ports.js";

/** Cursors are opaque to clients: base64url of `{ placedAt, id }`. */
export function encodeCursor(cursor: OrderCursor): string {
  return Buffer.from(JSON.stringify({ placedAt: cursor.placedAt, id: cursor.id })).toString("base64url");
}

export function decodeCursor(token: string): OrderCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const { placedAt, id } = parsed as Record<string, unknown>;
      if (typeof placedAt === "string" && Number.isFinite(Date.parse(placedAt)) && typeof id === "string" && id !== "") {
        return { placedAt, id };
      }
    }
  } catch {
    // fall through to the validation error below
  }
  throw new ValidationError([{ path: "cursor", message: "is not a valid cursor" }]);
}
