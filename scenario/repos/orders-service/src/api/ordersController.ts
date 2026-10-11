import type { OrderService } from "../core/orderService.js";
import { toErrorResponse } from "./errorMapper.js";
import { errorResponse, json, queryOf, splitPath, type HttpRequest, type HttpResponse } from "./http.js";
import { parseCancelRequest, parseListOrdersQuery, parsePlaceOrderRequest } from "./requestParsing.js";
import { toOrderListResponse, toOrderResponse } from "./responses.js";

export interface OrdersController {
  handle(request: HttpRequest): Promise<HttpResponse>;
}

type RouteMatch =
  | { readonly kind: "placeOrder" }
  | { readonly kind: "health" }
  | { readonly kind: "listOrders" }
  | { readonly kind: "getOrder"; readonly id: string }
  | { readonly kind: "cancelOrder"; readonly id: string }
  | { readonly kind: "methodNotAllowed"; readonly allow: string }
  | { readonly kind: "notFound" };

/**
 * REST handlers for orders-api:
 *   POST /orders               place an order           -> 201
 *   GET  /orders?customerId=   list a customer's orders -> 200 { orders: [...] }
 *   GET  /orders/{id}          read an order            -> 200
 *   POST /orders/{id}/cancel   cancel a placed order    -> 200
 *   GET  /health               liveness probe           -> 200 { status: "ok" }
 * Handlers are pure functions of `{ method, path, body }` plus the order service.
 */
export function createOrdersController(service: OrderService): OrdersController {
  return {
    async handle(request: HttpRequest): Promise<HttpResponse> {
      try {
        return await dispatch(service, request);
      } catch (error) {
        return toErrorResponse(error);
      }
    },
  };
}

async function dispatch(service: OrderService, request: HttpRequest): Promise<HttpResponse> {
  const route = matchRoute(request.method, request.path);
  switch (route.kind) {
    case "placeOrder": {
      const order = await service.placeOrder(parsePlaceOrderRequest(request.body));
      return json(201, toOrderResponse(order));
    }
    case "listOrders": {
      const page = await service.listOrders(parseListOrdersQuery(queryOf(request.path)));
      return json(200, toOrderListResponse(page));
    }
    case "health":
      return json(200, { status: "ok" });
    case "getOrder": {
      const order = await service.getOrder(route.id);
      return json(200, toOrderResponse(order));
    }
    case "cancelOrder": {
      const { reason } = parseCancelRequest(request.body);
      const order = await service.cancelOrder(route.id, reason === undefined ? {} : { reason });
      return json(200, toOrderResponse(order));
    }
    case "methodNotAllowed":
      return errorResponse(405, "method_not_allowed", `Allowed: ${route.allow}`);
    case "notFound":
      return errorResponse(404, "route_not_found", `No route for ${request.method} ${request.path}`);
  }
}

function matchRoute(method: string, path: string): RouteMatch {
  const verb = method.toUpperCase();
  const segments = splitPath(path);
  const [root, id, action] = segments;
  if (root === "health" && segments.length === 1) {
    return verb === "GET" ? { kind: "health" } : { kind: "methodNotAllowed", allow: "GET" };
  }
  if (root !== "orders" || segments.length > 3) {
    return { kind: "notFound" };
  }
  if (id === undefined) {
    if (verb === "POST") {
      return { kind: "placeOrder" };
    }
    return verb === "GET" ? { kind: "listOrders" } : { kind: "methodNotAllowed", allow: "GET, POST" };
  }
  const orderId = decodeSegment(id);
  if (action === undefined) {
    return verb === "GET" ? { kind: "getOrder", id: orderId } : { kind: "methodNotAllowed", allow: "GET" };
  }
  if (action === "cancel") {
    return verb === "POST" ? { kind: "cancelOrder", id: orderId } : { kind: "methodNotAllowed", allow: "POST" };
  }
  return { kind: "notFound" };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
