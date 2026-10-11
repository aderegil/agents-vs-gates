// build: CANARY-659701fc98899bcc
import { ContractViolationError } from "./errors.js";
import { parseIsoInstant } from "./dates.js";

export type JsonObject = Record<string, unknown>;

export function describe(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Reads typed fields from an untrusted object and remembers every problem it meets. */
export class FieldReader {
  readonly issues: string[] = [];

  constructor(
    private readonly source: JsonObject,
    private readonly prefix = "",
  ) {}

  string(key: string): string {
    const value = this.source[key];
    if (typeof value !== "string" || value.trim() === "") {
      this.fail(key, `expected a non-empty string, got ${describe(value)}`);
      return "";
    }
    return value;
  }

  currency(key: string): string {
    const value = this.source[key];
    if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
      this.fail(key, `expected an ISO-4217 code, got ${describe(value)}`);
      return "";
    }
    return value;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.source[key];
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.fail(key, `expected one of ${allowed.join("|")}, got ${describe(value)}`);
      return allowed[0] as T;
    }
    return value as T;
  }

  isoInstant(key: string): Date {
    const value = this.source[key];
    const parsed = parseIsoInstant(value);
    if (parsed === undefined) {
      this.fail(key, `expected an ISO-8601 datetime, got ${describe(value)}`);
      return new Date(0);
    }
    return parsed;
  }

  positiveInteger(key: string): number {
    const value = this.source[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      this.fail(key, `expected a positive integer, got ${describe(value)}`);
      return 0;
    }
    return value;
  }

  array(key: string): unknown[] {
    const value = this.source[key];
    if (!Array.isArray(value)) {
      this.fail(key, `expected an array, got ${describe(value)}`);
      return [];
    }
    return value;
  }

  child(key: string, value: unknown): FieldReader {
    const path = this.pathOf(key);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.issues.push(`${path}: expected an object, got ${describe(value)}`);
      return new FieldReader({}, path);
    }
    return new FieldReader(value as JsonObject, path);
  }

  adopt(other: FieldReader): void {
    this.issues.push(...other.issues);
  }

  /** Throws when anything was reported. */
  assertValid(contract: string): void {
    if (this.issues.length > 0) {
      throw new ContractViolationError(contract, this.issues);
    }
  }

  private fail(key: string, message: string): void {
    this.issues.push(`${this.pathOf(key)}: ${message}`);
  }

  private pathOf(key: string): string {
    return this.prefix === "" ? key : `${this.prefix}.${key}`;
  }
}

export function asObject(contract: string, raw: unknown): JsonObject {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolationError(contract, ["event must be a JSON object"]);
  }
  return raw as JsonObject;
}
