// Minimal Supabase REST client (PostgREST) using the service role key.
// The key stays on the server; the browser never talks to Supabase directly.

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function supabaseConfigured() {
  return Boolean(URL_ && KEY);
}

export async function sb(path, { method = "GET", body, prefer } = {}) {
  if (!supabaseConfigured()) throw new Error("Supabase is not configured");
  const headers = {
    apikey: KEY,
    authorization: `Bearer ${KEY}`,
    "content-type": "application/json",
  };
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 409) {
    const err = new Error("conflict");
    err.status = 409;
    throw err;
  }
  if (!res.ok) throw new Error(`supabase ${method} ${path.split("?")[0]} -> HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
