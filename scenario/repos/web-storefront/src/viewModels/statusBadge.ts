// build: CANARY-bab633003b4a7775
import { statusLabel } from "../core/order.js";

export type BadgeTone = "info" | "success" | "danger" | "neutral";

export interface StatusBadge {
  readonly label: string;
  readonly tone: BadgeTone;
  /** Text for screen readers; never relies on color alone. */
  readonly ariaLabel: string;
}

const TONES: Readonly<Record<string, BadgeTone>> = {
  placed: "info",
  paid: "success",
  shipped: "success",
  delivered: "success",
  cancelled: "danger",
  refunded: "neutral",
};

/** Badge shown next to an order. Statuses the storefront does not know get the neutral tone. */
export function statusBadge(status: string): StatusBadge {
  const label = statusLabel(status);
  return {
    label,
    tone: Object.hasOwn(TONES, status) ? (TONES[status] as BadgeTone) : "neutral",
    ariaLabel: `Order status: ${label.toLowerCase()}`,
  };
}
