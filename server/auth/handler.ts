// IdeaDock sign-in API: Google OAuth 2.0 authorization code flow with PKCE,
// refresh tokens sealed in D1 and long-lived HttpOnly sessions. The browser
// only ever receives short-lived Drive access tokens. Design notes:
// docs/AUTH.md ("서버 세션 로그인").
import { Sealer, pkceChallenge, randomToken, sha256Hex } from "./crypto.ts";

// Minimal D1 surface, so the handler runs on Cloudflare and on node:sqlite.
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
}
export type AuthEnv = {
  DB: D1Like;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  /** The one public origin of this deployment, e.g. https://ideadock.pages.dev */
  APP_ORIGIN: string;
};
export type GoogleEndpoints = {
  authorize: string;
  token: string;
  revoke: string;
};
export const google: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
};
export type AuthDeps = {
  /** Only tests and the local mock server point this elsewhere. */
  google?: GoogleEndpoints;
  now?: () => number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export const BASE = "/IdeaDock/";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const SESSION_COOKIE = "__Host-ideadock_session";
const OAUTH_COOKIE = "__Host-ideadock_oauth";
const DAY = 86_400_000;
/** A session left unused this long ends; every use pushes it forward. */
export const SESSION_IDLE = 60 * DAY;
/** Hard cap from sign-in (also Chrome's cookie lifetime limit). */
export const SESSION_ABSOLUTE = 400 * DAY;
const SESSION_TOUCH = 12 * 3_600_000;
const OAUTH_TTL = 10 * 60_000;
/** Access tokens closer than this to expiry are refreshed before handing out. */
const TOKEN_MARGIN = 5 * 60_000;
const LEASE = 15_000;

type Account = {
  sub: string;
  email: string;
  name: string;
  scope: string;
  refresh_token: string | null;
  access_token: string | null;
  access_issued_at: number | null;
  access_expires_at: number | null;
};
type SessionRow = Account & {
  id_hash: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
};
type Pending = {
  state: string;
  verifier: string;
  nonce: string;
  ret: string;
  consent: boolean;
  at: number;
};
type Failure = "revoked" | "unavailable" | "config" | "scope";

const noStore = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
function cookie(name: string, value: string, maxAgeMs: number) {
  const age = Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${name}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
const clear = (name: string) => cookie(name, "", 0);
function json(status: number, body: unknown, cookies: string[] = []) {
  const headers = new Headers({
    ...noStore,
    "Content-Type": "application/json; charset=utf-8",
  });
  cookies.forEach((c) => headers.append("Set-Cookie", c));
  return new Response(JSON.stringify(body), { status, headers });
}
function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ ...noStore, Location: location });
  cookies.forEach((c) => headers.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers });
}
function cookies(request: Request) {
  const out = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Only paths inside the app; anything else falls back to the app root. */
export function safeReturn(value: string | null | undefined, origin: string) {
  if (!value || value.length > 1024 || /[\\\s]/.test(value)) return BASE;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith(BASE)) return BASE;
    url.searchParams.delete("auth");
    return url.pathname + url.search + url.hash;
  } catch {
    return BASE;
  }
}
function back(
  ret: string,
  origin: string,
  result: string,
  extra: string[] = [],
) {
  const url = new URL(ret, origin);
  url.searchParams.set("auth", result);
  return redirect(url.pathname + url.search + url.hash, [
    clear(OAUTH_COOKIE),
    ...extra,
  ]);
}
function claims(idToken: unknown) {
  try {
    const part = String(idToken).split(".")[1];
    const text = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}
const publicUser = (a: Pick<Account, "sub" | "email" | "name">) => ({
  id: `google:${a.sub}`,
  email: a.email,
  name: a.name,
});

export async function handleAuth(
  request: Request,
  env: AuthEnv,
  deps: AuthDeps = {},
): Promise<Response> {
  const endpoints = deps.google ?? google;
  const now = deps.now ?? Date.now;
  const send = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = new URL(request.url);
  let origin: string;
  try {
    origin = new URL(env.APP_ORIGIN).origin;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error();
  } catch {
    return json(503, { reason: "config" });
  }
  let sealer: Sealer;
  try {
    sealer = await Sealer.fromSecret(env.TOKEN_ENCRYPTION_KEY);
  } catch {
    return json(503, { reason: "config" });
  }
  const db = env.DB;
  const redirectUri = `${origin}/api/auth/callback`;
  const jar = cookies(request);

  /** Same-origin fetch from the app only: blocks cross-site form posts and reads. */
  function trusted() {
    const site = request.headers.get("Sec-Fetch-Site");
    return (
      request.method === "POST" &&
      request.headers.get("Origin") === origin &&
      (!site || site === "same-origin") &&
      request.headers.get("X-IdeaDock-Auth") === "1" &&
      (request.headers.get("Content-Type") ?? "").startsWith("application/json")
    );
  }
  async function currentSession() {
    const raw = jar.get(SESSION_COOKIE);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = await db
      .prepare(
        "SELECT s.id_hash, s.created_at, s.last_used_at, s.expires_at, a.* FROM sessions s JOIN accounts a ON a.sub = s.sub WHERE s.id_hash = ?",
      )
      .bind(await sha256Hex(raw))
      .first<SessionRow>();
    if (row && row.expires_at <= now()) {
      await db
        .prepare("DELETE FROM sessions WHERE id_hash = ?")
        .bind(row.id_hash)
        .run();
      return null;
    }
    return row;
  }
  async function postForm(target: string, form: Record<string, string>) {
    const response = await send(target, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { response, body };
  }
  async function storeAccess(
    sub: string,
    token: string,
    expiresIn: unknown,
    extra: { refresh?: string; scope?: string } = {},
  ) {
    const issued = now();
    const seconds = Math.min(Number(expiresIn) || 3600, 3600);
    const expires = issued + seconds * 1000;
    await db
      .prepare(
        `UPDATE accounts SET access_token = ?, access_issued_at = ?, access_expires_at = ?,
         refresh_token = COALESCE(?, refresh_token), scope = COALESCE(?, scope),
         refresh_lock_until = NULL, updated_at = ? WHERE sub = ?`,
      )
      .bind(
        await sealer.seal(token, `access:${sub}`),
        issued,
        expires,
        extra.refresh
          ? await sealer.seal(extra.refresh, `refresh:${sub}`)
          : null,
        extra.scope ?? null,
        issued,
        sub,
      )
      .run();
    return { token, expires };
  }
  // `rejected`: the token Drive just refused this caller. It is never handed
  // out again; a different cached token (another tab refreshed) still is.
  async function cached(row: Account, rejected?: string) {
    if (
      !row.access_token ||
      !row.access_expires_at ||
      row.access_expires_at - now() <= TOKEN_MARGIN
    )
      return null;
    const token = await sealer.open(row.access_token, `access:${row.sub}`);
    return token && token !== rejected
      ? { token, expires: row.access_expires_at }
      : null;
  }
  const release = (sub: string) =>
    db
      .prepare("UPDATE accounts SET refresh_lock_until = NULL WHERE sub = ?")
      .bind(sub)
      .run();
  async function accessToken(
    row: Account,
    rejected?: string,
  ): Promise<{ token: string; expires: number } | { fail: Failure }> {
    const hit = await cached(row, rejected);
    if (hit) return hit;
    const leased = await db
      .prepare(
        "UPDATE accounts SET refresh_lock_until = ? WHERE sub = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)",
      )
      .bind(now() + LEASE, row.sub, now())
      .run();
    if ((leased.meta?.changes ?? 0) !== 1) {
      // Someone else is refreshing: wait for their token, then refresh
      // ourselves if they stalled (Google refresh tokens are reusable).
      for (let i = 0; i < 12; i++) {
        await sleep(250);
        const fresh = await db
          .prepare("SELECT * FROM accounts WHERE sub = ?")
          .bind(row.sub)
          .first<Account>();
        if (!fresh?.refresh_token) return { fail: "revoked" };
        if ((fresh.access_issued_at ?? 0) > (row.access_issued_at ?? 0)) {
          const got = await cached(fresh, rejected);
          if (got) return got;
        }
      }
    }
    const refresh = await sealer.open(row.refresh_token, `refresh:${row.sub}`);
    if (!refresh) {
      await release(row.sub);
      return { fail: "revoked" };
    }
    let reply;
    try {
      reply = await postForm(endpoints.token, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      });
    } catch {
      await release(row.sub);
      return { fail: "unavailable" };
    }
    const { response, body } = reply;
    if (response.ok && typeof body.access_token === "string") {
      const scope = typeof body.scope === "string" ? body.scope : row.scope;
      if (!scope.split(" ").includes(DRIVE_SCOPE)) {
        await release(row.sub);
        return { fail: "scope" };
      }
      return storeAccess(row.sub, body.access_token, body.expires_in, {
        refresh:
          typeof body.refresh_token === "string"
            ? body.refresh_token
            : undefined,
        scope,
      });
    }
    if (body.error === "invalid_grant") {
      // Revoked in Google settings, expired (Testing apps: 7 days), or the
      // password changed. Only this credential is dropped; Drive data is untouched.
      await db
        .prepare(
          "UPDATE accounts SET refresh_token = NULL, access_token = NULL, access_issued_at = NULL, access_expires_at = NULL, refresh_lock_until = NULL WHERE sub = ?",
        )
        .bind(row.sub)
        .run();
      return { fail: "revoked" };
    }
    await release(row.sub);
    return {
      fail:
        body.error === "invalid_client" || body.error === "unauthorized_client"
          ? "config"
          : "unavailable",
    };
  }

  try {
    const route = url.pathname;
    if (route === "/api/auth/login" && request.method === "GET") {
      const ret = safeReturn(url.searchParams.get("return"), origin);
      const consent = url.searchParams.get("consent") === "1";
      const switching = url.searchParams.get("switch") === "1";
      const hint = url.searchParams.get("hint") ?? "";
      const pending: Pending = {
        state: randomToken(),
        verifier: randomToken(48),
        nonce: randomToken(),
        ret,
        consent,
        at: now(),
      };
      const prompt = [consent && "consent", switching && "select_account"]
        .filter(Boolean)
        .join(" ");
      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: `openid email profile ${DRIVE_SCOPE}`,
        access_type: "offline",
        include_granted_scopes: "true",
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await pkceChallenge(pending.verifier),
        code_challenge_method: "S256",
        ...(prompt ? { prompt } : {}),
        ...(!switching && /^[\w.@+-]{1,256}$/.test(hint)
          ? { login_hint: hint }
          : {}),
      });
      return redirect(`${endpoints.authorize}?${params}`, [
        cookie(
          OAUTH_COOKIE,
          await sealer.seal(JSON.stringify(pending), "oauth"),
          OAUTH_TTL,
        ),
      ]);
    }

    if (route === "/api/auth/callback" && request.method === "GET") {
      const opened = await sealer.open(jar.get(OAUTH_COOKIE), "oauth");
      const pending = opened ? (JSON.parse(opened) as Pending) : null;
      const state = url.searchParams.get("state") ?? "";
      if (
        !pending ||
        now() - pending.at > OAUTH_TTL ||
        !same(state, pending.state)
      )
        return back(pending?.ret ?? BASE, origin, "state");
      const ret = safeReturn(pending.ret, origin);
      const error = url.searchParams.get("error");
      if (error)
        return back(
          ret,
          origin,
          error === "access_denied" ? "denied" : "error",
        );
      const code = url.searchParams.get("code");
      if (!code) return back(ret, origin, "error");
      let exchanged;
      try {
        exchanged = await postForm(endpoints.token, {
          grant_type: "authorization_code",
          code,
          code_verifier: pending.verifier,
          redirect_uri: redirectUri,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
        });
      } catch {
        return back(ret, origin, "unavailable");
      }
      const { response, body } = exchanged;
      if (!response.ok || typeof body.access_token !== "string")
        return back(ret, origin, "error");
      // The ID token came straight from Google's token endpoint over TLS, so
      // its claims are checked without a signature (OIDC Core 3.1.3.7).
      const id = claims(body.id_token);
      const sub = typeof id?.sub === "string" ? id.sub : "";
      if (
        !id ||
        !/^[\w-]{1,255}$/.test(sub) ||
        !["accounts.google.com", "https://accounts.google.com"].includes(
          String(id.iss),
        ) ||
        id.aud !== env.GOOGLE_CLIENT_ID ||
        Number(id.exp) * 1000 <= now() ||
        id.nonce !== pending.nonce
      )
        return back(ret, origin, "error");
      const scope = typeof body.scope === "string" ? body.scope : "";
      if (!scope.split(" ").includes(DRIVE_SCOPE))
        return back(ret, origin, "scope");
      const existing = await db
        .prepare("SELECT refresh_token FROM accounts WHERE sub = ?")
        .bind(sub)
        .first<{ refresh_token: string | null }>();
      const refresh =
        typeof body.refresh_token === "string" ? body.refresh_token : null;
      if (!refresh && !existing?.refresh_token) {
        // Google issues a refresh token only with fresh consent. Ask once.
        if (pending.consent) return back(ret, origin, "offline");
        const again = new URLSearchParams({
          return: ret,
          consent: "1",
          hint: sub,
        });
        return redirect(`/api/auth/login?${again}`, [clear(OAUTH_COOKIE)]);
      }
      const t = now();
      const email = typeof id.email === "string" ? id.email : "";
      const name = typeof id.name === "string" ? id.name : email;
      await db
        .prepare(
          `INSERT INTO accounts (sub, email, name, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (sub) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = excluded.updated_at`,
        )
        .bind(sub, email, name, scope, t, t)
        .run();
      await storeAccess(sub, body.access_token, body.expires_in, {
        refresh: refresh ?? undefined,
        scope,
      });
      // A new sign-in always gets a new session id (no fixation), and the
      // session this browser had before, for any account, ends.
      const previous = jar.get(SESSION_COOKIE);
      if (previous)
        await db
          .prepare("DELETE FROM sessions WHERE id_hash = ?")
          .bind(await sha256Hex(previous))
          .run();
      await db
        .prepare("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(t)
        .run();
      const session = randomToken();
      await db
        .prepare(
          "INSERT INTO sessions (id_hash, sub, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(await sha256Hex(session), sub, t, t, t + SESSION_IDLE)
        .run();
      return redirect(ret, [
        clear(OAUTH_COOKIE),
        cookie(SESSION_COOKIE, session, SESSION_IDLE),
      ]);
    }

    if (route === "/api/auth/token") {
      if (!trusted()) return json(403, { reason: "csrf" });
      const row = await currentSession();
      if (!row)
        return json(401, { reason: "session" }, [clear(SESSION_COOKIE)]);
      const input = (await request.json().catch(() => ({}))) as {
        rejected?: unknown;
      };
      const user = publicUser(row);
      const set: string[] = [];
      const t = now();
      if (t - row.last_used_at > SESSION_TOUCH) {
        const expires = Math.min(
          t + SESSION_IDLE,
          row.created_at + SESSION_ABSOLUTE,
        );
        await db
          .prepare(
            "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?",
          )
          .bind(t, expires, row.id_hash)
          .run();
        set.push(cookie(SESSION_COOKIE, jar.get(SESSION_COOKIE)!, expires - t));
      }
      const result = await accessToken(
        row,
        typeof input.rejected === "string" ? input.rejected : undefined,
      );
      if ("fail" in result) {
        if (result.fail === "revoked") {
          await db
            .prepare("DELETE FROM sessions WHERE sub = ?")
            .bind(row.sub)
            .run();
          return json(401, { reason: "revoked" }, [clear(SESSION_COOKIE)]);
        }
        if (result.fail === "scope") return json(401, { reason: "scope" }, set);
        const headers = json(503, { reason: result.fail }, set);
        headers.headers.set("Retry-After", "30");
        return headers;
      }
      return json(
        200,
        {
          user,
          access_token: result.token,
          expires_in: Math.floor((result.expires - now()) / 1000),
        },
        set,
      );
    }

    if (route === "/api/auth/logout") {
      if (!trusted()) return json(403, { reason: "csrf" });
      const input = (await request.json().catch(() => ({}))) as {
        everywhere?: unknown;
      };
      const row = await currentSession();
      if (row && input.everywhere === true) {
        const refresh = await sealer.open(
          row.refresh_token,
          `refresh:${row.sub}`,
        );
        if (refresh)
          await postForm(endpoints.revoke, { token: refresh }).catch(
            () => null,
          );
        await db
          .prepare(
            "UPDATE accounts SET refresh_token = NULL, access_token = NULL, access_issued_at = NULL, access_expires_at = NULL WHERE sub = ?",
          )
          .bind(row.sub)
          .run();
        await db
          .prepare("DELETE FROM sessions WHERE sub = ?")
          .bind(row.sub)
          .run();
      } else if (row) {
        await db
          .prepare("DELETE FROM sessions WHERE id_hash = ?")
          .bind(row.id_hash)
          .run();
      }
      return json(200, { ok: true }, [clear(SESSION_COOKIE)]);
    }
    return json(404, { reason: "not_found" });
  } catch {
    // No internals in the response; drafts on the device are never affected.
    return json(500, { reason: "server" });
  }
}
