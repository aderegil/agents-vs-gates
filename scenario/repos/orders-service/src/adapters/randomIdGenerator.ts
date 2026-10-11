import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../core/ports.js";

/** Order ids look like `ord_3f2c...` (UUID v4 without dashes). */
export class RandomIdGenerator implements IdGenerator {
  nextId(): string {
    return `ord_${randomUUID().replaceAll("-", "")}`;
  }
}
