// build: CANARY-659701fc98899bcc
import { IngestError, UnknownTableError } from "../core/errors.js";
import type { DataLake } from "../core/ports.js";
import { TABLE_NAMES, type TableName } from "../core/rows.js";

export interface QueryResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Read-only access to the lake, for quick inspection:
 *   GET /tables              -> 200 { tables: [...] }
 *   GET /tables/{name}       -> 200 { table, count, rows } | 404
 */
export async function queryLake(lake: DataLake, method: string, path: string): Promise<QueryResponse> {
  const segments = (path.split("?", 1)[0] ?? "").split("/").filter((segment) => segment !== "");
  if (segments[0] !== "tables" || segments.length > 2) {
    return failure(404, "route_not_found", `No route for ${path}`);
  }
  if (method.toUpperCase() !== "GET") {
    return failure(405, "method_not_allowed", "Allowed: GET");
  }
  const name = segments[1];
  if (name === undefined) {
    return { status: 200, body: { tables: TABLE_NAMES } };
  }
  try {
    const table = asTable(name);
    const rows = await lake.rows(table);
    return { status: 200, body: { table, count: rows.length, rows } };
  } catch (error) {
    if (error instanceof IngestError) {
      return failure(404, error.code, error.message);
    }
    return failure(500, "internal_error", "Unexpected error");
  }
}

function asTable(name: string): TableName {
  const table = TABLE_NAMES.find((candidate) => candidate === name);
  if (table === undefined) {
    throw new UnknownTableError(name);
  }
  return table;
}

function failure(status: number, code: string, message: string): QueryResponse {
  return { status, body: { error: { code, message } } };
}
