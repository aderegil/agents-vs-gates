import { partitionKeyFor, topicFor, type DomainEvent } from "../core/events.js";
import type { EventPublisher } from "../core/ports.js";

/** What would be handed to a Kafka producer: topic, key, serialized value and headers. */
export interface ProducedRecord {
  readonly topic: string;
  readonly key: string;
  readonly value: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface KafkaEventPublisherOptions {
  /** Records kept before `publish` starts failing (back-pressure stand-in). */
  readonly maxBuffered?: number;
}

export class BufferOverflowError extends Error {
  constructor(limit: number) {
    super(`Event buffer is full (${limit} records); drain it before publishing more`);
    this.name = "BufferOverflowError";
  }
}

/**
 * Simulated Kafka producer: serializes each event and appends it to an in-process buffer
 * instead of talking to a broker. The wire format (JSON value, orderId key, topic per event type)
 * is the same one the real producer uses.
 */
export class KafkaEventPublisher implements EventPublisher {
  private readonly buffer: ProducedRecord[] = [];
  private readonly maxBuffered: number;

  constructor(options: KafkaEventPublisherOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? 10_000;
  }

  async publish(event: DomainEvent): Promise<void> {
    if (this.buffer.length >= this.maxBuffered) {
      throw new BufferOverflowError(this.maxBuffered);
    }
    this.buffer.push({
      topic: topicFor(event),
      key: partitionKeyFor(event),
      value: JSON.stringify(event),
      headers: {
        "content-type": "application/json",
        "event-type": event.type,
        "schema-version": String(event.schemaVersion),
      },
    });
  }

  /** Records published so far, oldest first. */
  get records(): readonly ProducedRecord[] {
    return this.buffer;
  }

  /** Returns and clears the buffered records. */
  drain(): ProducedRecord[] {
    return this.buffer.splice(0, this.buffer.length);
  }
}
