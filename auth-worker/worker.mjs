// Single-origin authentication for the dedicated Cloudflare-hosted IdeaDock site.
// Google refresh tokens and OAuth client secret never reach client-side JavaScript.
const BASE = "/IdeaDock";
const API = `${BASE}/api/auth`;
const SESSION_COOKIE = "__Host-ideadock-session";
const FLOW_COOKIE = "__Host-ideadock-oauth";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const FLOW_SECONDS = 10 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function randomString(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return toB64url(bytes);
}
function toB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}
async function hash(value) {
  return toB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function secretKey(env) {
  const raw = Uint8Array.from(atob(env.SESSION_ENCRYPTION_KEY || ""), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("SESSION_ENCRYPTION_KEY must be 32 random bytes in base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(purpose) }, await secretKey(env), plaintext);
  return `${toB64url(iv)}.${toB64url(new Uint8Array(ciphertext))}`;
}
async function unseal(value, env, purpose) {
  const parts = String(value || "").split(".");
  if (parts.length !== 2) throw new Error("Invalid sealed value");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(parts[0]), additionalData: encoder.encode(purpose) }, await secretKey(env), fromB64url(parts[1]));
  return JSON.parse(decoder.decode(plaintext));
}
function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const split = part.trim().indexOf("=");
    if (split > 0 && part.trim().slice(0, split) === name) return part.trim().slice(split + 1);
  }
  return null;
}
function responseJson(value, status = 200, sessionCookie) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, private",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  if (sessionCookie) headers.append("Set-Cookie", sessionCookie);
  return new Response(JSON.stringify(value), { status, headers });
}
function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
  for (const item of cookies) headers.append("Set-Cookie", item);
  return new Response(null, { status: 302, headers });
}
function ready(request, env) {
  return env.AUTH_DB && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET &&
    env.SESSION_ENCRYPTION_KEY && env.APP_ORIGIN &&
    new URL(request.url).origin === env.APP_ORIGIN.replace(/\/$/, "");
}
function callbackUrl(env) {
  return `${env.APP_ORIGIN.replace(/\/$/, "")}${API}/callback`;
}
async function begin(request, env) {
  const verifier = randomString(32);
  const state = randomString();
  const challenge = await hash(verifier);
  const pending = await seal({ state, verifier, expires: Date.now() + FLOW_SECONDS * 1000 }, env, "oauth-flow");
  const query = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(env),
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    scope: `openid email profile ${DRIVE_SCOPE}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: new URL(request.url).searchParams.has("switch") ? "select_account consent" : "consent",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`, [cookie(FLOW_COOKIE, pending, FLOW_SECONDS)]);
}
async function exchange(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}
async function callback(request, env) {
  const query = new URL(request.url).searchParams;
  const clearFlow = cookie(FLOW_COOKIE, "", 0);
  const encrypted = readCookie(request, FLOW_COOKIE);
  if (!encrypted || !query.get("code") || !query.get("state") || query.get("error"))
    return responseJson({ error: "authorization_failed" }, 400, clearFlow);
  let state;
  try { state = await unseal(encrypted, env, "oauth-flow"); } catch { return responseJson({ error: "invalid_oauth_state" }, 400, clearFlow); }
  if (state.expires < Date.now() || state.state !== query.get("state"))
    return responseJson({ error: "invalid_oauth_state" }, 400, clearFlow);
  const tokens = await exchange({
    code: query.get("code"),
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: callbackUrl(env),
    code_verifier: state.verifier,
    grant_type: "authorization_code",
  });
  if (!tokens.ok || !tokens.body.access_token || !tokens.body.refresh_token ||
    !(tokens.body.scope || "").split(" ").includes(DRIVE_SCOPE)) {
    return responseJson({ error: "offline_access_not_granted" }, 400, clearFlow);
  }
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.body.access_token}` },
  });
  if (!profileResponse.ok) return responseJson({ error: "profile_unavailable" }, 502, clearFlow);
  const profile = await profileResponse.json();
  if (typeof profile.sub !== "string" || !profile.sub || typeof profile.email !== "string")
    return responseJson({ error: "invalid_profile" }, 502, clearFlow);
  const sessionId = randomString();
  const sid = await hash(sessionId);
  const expires = Date.now() + SESSION_SECONDS * 1000;
  const accessExpires = Date.now() + Math.max(0, Number(tokens.body.expires_in || 3600) - 60) * 1000;
  await env.AUTH_DB.prepare(
    "INSERT INTO auth_sessions (sid_hash, google_sub, email, display_name, refresh_ciphertext, access_ciphertext, access_expires, session_expires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(sid, profile.sub, profile.email, typeof profile.name === "string" ? profile.name : "",
    await seal(tokens.body.refresh_token, env, "refresh-token"),
    await seal(tokens.body.access_token, env, "access-token"),
    accessExpires, expires, Date.now()).run();
  const previous = await currentSession(request, env);
  if (previous) await deleteSession(env, previous.sid);
  return redirect(`${env.APP_ORIGIN}${BASE}/`, [cookie(SESSION_COOKIE, sessionId, SESSION_SECONDS), clearFlow]);
}
async function deleteSession(env, sid) {
  await env.AUTH_DB.prepare("DELETE FROM auth_sessions WHERE sid_hash = ?").bind(sid).run();
}
async function currentSession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw || !/^[a-zA-Z0-9_-]{40,50}$/.test(raw)) return null;
  const sid = await hash(raw);
  const row = await env.AUTH_DB.prepare("SELECT * FROM auth_sessions WHERE sid_hash = ?").bind(sid).first();
  if (!row) return null;
  if (Number(row.session_expires) <= Date.now()) {
    await deleteSession(env, sid);
    return null;
  }
  return { sid, row, raw };
}
async function session(request, env) {
  const current = await currentSession(request, env);
  if (!current) return responseJson({ authenticated: false }, 401, cookie(SESSION_COOKIE, "", 0));
  const { sid, row, raw } = current;
  let accessToken;
  let accessExpires = Number(row.access_expires);
  if (accessExpires <= Date.now() + 90000 || new URL(request.url).searchParams.get("force") === "1") {
    const refresh = await unseal(row.refresh_ciphertext, env, "refresh-token");
    const tokens = await exchange({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" });
    if (!tokens.ok) {
      if (tokens.body.error === "invalid_grant") {
        // Another refresh might have won the race; keep the session if it already advanced.
        const latest = await env.AUTH_DB.prepare("SELECT access_expires FROM auth_sessions WHERE sid_hash = ?").bind(sid).first();
        if (!latest || Number(latest.access_expires) === accessExpires) {
          await deleteSession(env, sid);
          return responseJson({ authenticated: false, error: "reauthorization_required" }, 401, cookie(SESSION_COOKIE, "", 0));
        }
        return session(request, env);
      }
      return responseJson({ error: "google_temporarily_unavailable" }, 503);
    }
    if (!tokens.body.access_token || (tokens.body.scope && !tokens.body.scope.split(" ").includes(DRIVE_SCOPE)))
      return responseJson({ error: "drive_scope_missing" }, 403);
    accessToken = tokens.body.access_token;
    accessExpires = Date.now() + Math.max(0, Number(tokens.body.expires_in || 3600) - 60) * 1000;
    const encryptedRefresh = tokens.body.refresh_token
      ? await seal(tokens.body.refresh_token, env, "refresh-token")
      : row.refresh_ciphertext;
    const result = await env.AUTH_DB.prepare(
      "UPDATE auth_sessions SET access_ciphertext = ?, refresh_ciphertext = ?, access_expires = ? WHERE sid_hash = ? AND access_expires = ?"
    ).bind(await seal(accessToken, env, "access-token"), encryptedRefresh, accessExpires, sid, row.access_expires).run();
    if (result.meta?.changes === 0) return session(request, env);
  } else {
    accessToken = await unseal(row.access_ciphertext, env, "access-token");
  }
  const expires = Date.now() + SESSION_SECONDS * 1000;
  await env.AUTH_DB.prepare("UPDATE auth_sessions SET session_expires = ? WHERE sid_hash = ?").bind(expires, sid).run();
  return responseJson({
    authenticated: true,
    token: accessToken,
    expires: accessExpires,
    user: { id: `google:${row.google_sub}`, email: row.email, user_metadata: { full_name: row.display_name } },
  }, 200, cookie(SESSION_COOKIE, raw, SESSION_SECONDS));
}
async function logout(request, env) {
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return responseJson({ error: "bad_origin" }, 403);
  const current = await currentSession(request, env);
  if (current) await deleteSession(env, current.sid);
  return responseJson({ authenticated: false }, 200, cookie(SESSION_COOKIE, "", 0));
}
async function asset(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === BASE) return redirect(`${url.origin}${BASE}/`);
  if (!url.pathname.startsWith(`${BASE}/`) || !["GET", "HEAD"].includes(request.method))
    return new Response("Not found", { status: 404 });
  // Next.js exports out/index.html and out/_next, while its links use /IdeaDock/*.
  url.pathname = url.pathname.slice(BASE.length) || "/";
  if (url.pathname === "/") url.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(url.toString(), request));
}
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${API}/`)) return asset(request, env);
  if (!ready(request, env)) return responseJson({ error: "auth_not_configured" }, 503);
  try {
    if (url.pathname === `${API}/start` && request.method === "GET") return begin(request, env);
    if (url.pathname === `${API}/callback` && request.method === "GET") return callback(request, env);
    if (url.pathname === `${API}/session` && request.method === "GET") return session(request, env);
    if (url.pathname === `${API}/logout` && request.method === "POST") return logout(request, env);
    return responseJson({ error: "not_found" }, 404);
  } catch {
    // Never send secrets, refresh tokens, Google responses or SQL details to clients.
    return responseJson({ error: "auth_service_unavailable" }, 503);
  }
}
export default { fetch: handleRequest };
