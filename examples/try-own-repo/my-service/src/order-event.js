// The event this service publishes when an order is placed. Other teams read it.
export function orderPlacedEvent(order) {
  return {
    orderId: order.id,
    total: order.lines.reduce((s, l) => s + l.qty * l.priceCents, 0),
    placedAt: order.placedAt,
  };
}
