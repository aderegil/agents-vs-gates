// build: CANARY-d61e78f017ccf353
import { EmailDeliveryError } from "../core/errors.js";
import type { EmailMessage, EmailSender } from "../core/ports.js";

/** Stand-in for the email provider: "sends" by appending to an outbox. */
export class SimulatedEmailSender implements EmailSender {
  private readonly sent: EmailMessage[] = [];
  private failuresLeft: number;

  /** `failFirst`: make the first N sends fail, to exercise retries. */
  constructor(options: { failFirst?: number } = {}) {
    this.failuresLeft = options.failFirst ?? 0;
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new EmailDeliveryError(`Simulated provider outage while sending to ${message.to}`);
    }
    if (!message.to.includes("@")) {
      throw new EmailDeliveryError(`Invalid recipient: ${message.to}`);
    }
    this.sent.push({ ...message });
  }

  get outbox(): readonly EmailMessage[] {
    return this.sent;
  }
}
