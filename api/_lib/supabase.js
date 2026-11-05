// Minimal Supabase REST client (PostgREST) using the service role key.
// The key stays on the server; the browser never talks to Supabase directly.

// Accepts the Project URL in any of the shapes people paste: with a trailing
// slash, with /rest/v1 on the end, or the dashboard address of the project.
export function normalizeSupabaseUrl(raw) {
  let u = String(raw || "").trim().replace(/^["']|["']$/g, "");
  const dash = u.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1]}.supabase.co`;
  u = u.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "").replace(/\/+$/, "");
  if (u && !/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

const URL_ = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

export function supabaseConfigured() {
  return Boolean(URL_ && KEY);
}

export async function sb(path, { method = "GET", body, prefer } = {}) {
  if (!supabaseConfigured()) throw new Error("Supabase is not configured");
  // Works with both key styles: legacy service_role JWTs (eyJ…) and new sb_secret_ keys.
  // New secret keys are not JWTs, so they go in the apikey header only.
  const headers = { apikey: KEY, "content-type": "application/json" };
  if (KEY.startsWith("eyJ")) headers.authorization = `Bearer ${KEY}`;
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
  if (!res.ok) {
    // PostgREST explains itself in the body (code + message); keep it for debugging.
    let why = "";
    try { const j = await res.json(); why = [j.code, j.message || j.msg || j.error].filter(Boolean).join(" "); } catch { /* none */ }
    const host = URL_.replace(/^https?:\/\//, "");
    throw new Error(`supabase ${method} ${path.split("?")[0]} -> HTTP ${res.status} ${why} (host: ${host})`.trim());
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
