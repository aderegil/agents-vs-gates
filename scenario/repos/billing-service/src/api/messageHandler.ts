// build: CANARY-d61e78f017ccf353
import { ContractViolationError } from "../core/errors.js";
import type { Invoice } from "../core/invoice.js";
import { onOrderPlaced, type OnOrderPlacedDeps } from "../core/onOrderPlaced.js";

export const ORDER_PLACED_TOPIC = "orders.placed";

/** A message as delivered by the event bus: `value` is the JSON text or the already parsed event. */
export interface BusMessage {
  readonly topic: string;
  readonly value: unknown;
}

export type MessageResult =
  | { readonly status: "processed"; readonly invoice: Invoice }
  | { readonly status: "ignored"; readonly topic: string };

/**
 * Entry point for the bus subscription. Unknown topics are ignored; a message that cannot be
 * decoded or does not match the contract throws, so the bus can retry or dead-letter it.
 */
export async function handleMessage(deps: OnOrderPlacedDeps, message: BusMessage): Promise<MessageResult> {
  if (message.topic !== ORDER_PLACED_TOPIC) {
    return { status: "ignored", topic: message.topic };
  }
  const invoice = await onOrderPlaced(deps, parseValue(message.value));
  return { status: "processed", invoice };
}

function parseValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new ContractViolationError("OrderPlaced", ["message value is not valid JSON"]);
  }
}
