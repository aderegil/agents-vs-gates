import type { Clock } from "../core/ports.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
