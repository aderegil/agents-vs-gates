import type { ValidationIssue } from "../core/errors.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects shape problems of an untrusted JSON body. It checks types only;
 * business invariants (ranges, limits, supported values) belong to the core.
 */
export class InputReader {
  readonly issues: ValidationIssue[] = [];

  constructor(private readonly source: JsonObject, private readonly prefix = "") {}

  string(key: string): string {
    const value = this.source[key];
    if (typeof value !== "string") {
      this.fail(key, "must be a string");
      return "";
    }
    return value;
  }

  optionalString(key: string): string | undefined {
    const value = this.source[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      this.fail(key, "must be a string");
      return undefined;
    }
    return value;
  }

  /** Reads a JSON number. Whether it is a valid integer or amount is decided by the core. */
  number(key: string): number {
    const value = this.source[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(key, "must be a number");
      return Number.NaN;
    }
    return value;
  }

  array(key: string): unknown[] {
    const value = this.source[key];
    if (!Array.isArray(value)) {
      this.fail(key, "must be an array");
      return [];
    }
    return value;
  }

  object(key: string, value: unknown): InputReader | undefined {
    if (!isJsonObject(value)) {
      this.fail(key, "must be an object");
      return undefined;
    }
    return new InputReader(value, this.pathOf(key));
  }

  fail(key: string, message: string): void {
    this.issues.push({ path: this.pathOf(key), message });
  }

  private pathOf(key: string): string {
    return this.prefix === "" ? key : `${this.prefix}.${key}`;
  }
}
