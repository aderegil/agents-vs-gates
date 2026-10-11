// The only module that talks to the server. Paths are relative to /api ("run-control/stages").
// Every request carries ?ns=<namespace> (the one passed, else the global switch); POSTs carry X-CSRF-Token.
// Failures reject with an Error that has {status, error}.

export class ApiFailure extends Error {
  constructor(status, error) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

function clean(path) {
  return String(path || "").replace(/^\/+/, "").replace(/^api\//, "");
}

export function createApi({ getCsrf, getNs, onUnauthorized } = {}) {
  function url(path, opts = {}) {
    const p = clean(path);
    const u = new URL("/api/" + p, location.origin);
    const ns = opts.ns ?? (getNs ? getNs() : null);
    if (ns && !u.searchParams.has("ns")) u.searchParams.set("ns", ns);
    for (const [k, v] of Object.entries(opts.query || {})) if (v != null && v !== "") u.searchParams.set(k, v);
    return u.pathname + u.search;
  }

  async function request(method, path, body, opts = {}) {
    const headers = { Accept: "application/json" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      const csrf = getCsrf ? getCsrf() : null;
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }
    let res;
    try {
      res = await fetch(url(path, opts), {
        method, headers, credentials: "same-origin",
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      });
    } catch (e) {
      throw new ApiFailure(0, "The console server is not reachable");
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const msg = (data && data.error) || `${res.status} ${res.statusText}`;
      if (res.status === 401 && onUnauthorized && !opts.noAuthRedirect) onUnauthorized();
      throw new ApiFailure(res.status, msg);
    }
    return data;
  }

  return {
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body, opts),
    url,
  };
}

// Before a session exists (sign-in, first run): same-origin calls with the pre-session CSRF token.
export async function rawSession() {
  const res = await fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
  return res.json();
}

export async function rawPost(path, body, csrf) {
  const res = await fetch("/api/" + clean(path), {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrf || "" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiFailure(res.status, (data && data.error) || res.statusText);
  return data;
}
