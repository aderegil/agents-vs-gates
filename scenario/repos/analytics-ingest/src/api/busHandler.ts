// build: CANARY-659701fc98899bcc
import { ContractViolationError } from "../core/errors.js";
import type { DataLake } from "../core/ports.js";
import { ingestEvent, type IngestResult } from "../ingest.js";

export const SUBSCRIBED_TOPICS = ["orders.placed", "orders.cancelled"] as const;

/** A message as delivered by the event bus: `value` is the JSON text or the already parsed event. */
export interface BusMessage {
  readonly topic: string;
  readonly value: unknown;
}

export type MessageResult =
  | { readonly status: "ingested"; readonly result: IngestResult }
  | { readonly status: "ignored"; readonly topic: string };

/**
 * Entry point for the bus subscription. Only the subscribed topics are processed.
 * A message that is not valid JSON or breaks the event contract throws, so the bus can retry or dead-letter it.
 */
export async function handleMessage(lake: DataLake, message: BusMessage): Promise<MessageResult> {
  if (!(SUBSCRIBED_TOPICS as readonly string[]).includes(message.topic)) {
    return { status: "ignored", topic: message.topic };
  }
  return { status: "ingested", result: await ingestEvent(lake, parseValue(message)) };
}

function parseValue(message: BusMessage): unknown {
  if (typeof message.value !== "string") {
    return message.value;
  }
  try {
    return JSON.parse(message.value);
  } catch {
    throw new ContractViolationError(message.topic, ["message value is not valid JSON"]);
  }
}
