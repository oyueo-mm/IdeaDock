import { describe, it, expect, beforeEach } from "vitest";
import {
  handleAuth,
  safeReturn,
  SESSION_COOKIE,
  type AuthEnv,
} from "../server/auth/handler";
import { Sealer, base64url, sha256Hex } from "../server/auth/crypto";
import { sqliteD1 } from "../server/dev/sqlite-d1";
import { createMockGoogle } from "../server/dev/mock-google";

const ORIGIN = "https://ideadock.pages.dev";
const DAY = 86_400_000;
const key = base64url(crypto.getRandomValues(new Uint8Array(32)));

function setup(options: { refreshLifetime?: number } = {}) {
  const clock = { t: Date.UTC(2026, 9, 1) };
  const now = () => clock.t;
  const google = createMockGoogle({
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "test-secret",
    now,
    ...options,
  });
  const { DB, raw } = sqliteD1();
  const env: AuthEnv = {
    DB,
    GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: key,
    APP_ORIGIN: ORIGIN,
  };
  const deps = {
    google: google.endpoints,
    now,
    fetch: ((input: string, init?: RequestInit) =>
      google.fetch(new Request(input, init))) as typeof fetch,
    sleep: (ms: number) =>
      new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))),
  };
  const call = (request: Request) => handleAuth(request, env, deps);
  /** A browser profile: its own cookie jar, following redirects like Chrome. */
  function browser() {
    const jar = new Map<string, string>();
    const raw: string[] = [];
    function store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        raw.push(line);
        const [pair] = line.split(";");
        const at = pair.indexOf("=");
        const name = pair.slice(0, at),
          value = pair.slice(at + 1);
        if (/Max-Age=0/.test(line) || !value) jar.delete(name);
        else jar.set(name, value);
      }
    }
    const header = () =>
      [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    async function navigate(path: string) {
      let url = new URL(path, ORIGIN);
      for (let hops = 0; hops < 10; hops++) {
        let response: Response;
        if (url.origin === ORIGIN) {
          response = await call(
            new Request(url, { headers: { Cookie: header() } }),
          );
          store(response);
        } else response = await google.fetch(new Request(url));
        const location = response.headers.get("Location");
        if (response.status !== 302 || !location) return { url, response };
        url = new URL(location, url);
        if (url.origin === ORIGIN && !url.pathname.startsWith("/api/"))
          return { url, response };
      }
      throw new Error("redirect loop");
    }
    async function post(
      path: string,
      body: unknown = {},
      headers: Record<string, string> = {},
    ) {
      const response = await call(
        new Request(new URL(path, ORIGIN), {
          method: "POST",
          headers: {
            Cookie: header(),
            Origin: ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
            "X-IdeaDock-Auth": "1",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
      store(response);
      return { status: response.status, body: await response.json() };
    }
    return {
      jar,
      raw,
      navigate,
      post,
      login: (query = "") =>
        navigate(`/api/auth/login?return=%2FIdeaDock%2F${query}`),
      token: (rejected?: string) => post("/api/auth/token", { rejected }),
    };
  }
  return { clock, google, env, raw, browser, call };
}

describe("authorization code sign-in", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("signs in with PKCE, state and a hashed, HttpOnly session", async () => {
    const b = t.browser();
    const start = await t.call(
      new Request(`${ORIGIN}/api/auth/login?return=%2FIdeaDock%2F`),
    );
    const location = new URL(start.headers.get("Location")!);
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/callback`,
    );
    expect(location.searchParams.get("scope")).toBe(
      "openid email profile https://www.googleapis.com/auth/drive.file",
    );
    expect(location.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(start.headers.get("Cache-Control")).toBe("no-store");

    const done = await b.login();
    expect(done.url.pathname).toBe("/IdeaDock/");
    expect(done.url.search).toBe("");
    const session = b.jar.get(SESSION_COOKIE)!;
    expect(session).toMatch(/^[\w-]{43}$/);
    const line = b.raw.find((l) =>
      l.startsWith(`${SESSION_COOKIE}=${session}`),
    )!;
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/Secure/);
    expect(line).toMatch(/SameSite=Lax/);
    expect(line).toMatch(/Path=\//);
    expect(b.jar.has("__Host-ideadock_oauth")).toBe(false);

    // Only the hash of the session id and sealed tokens reach the database.
    const rows = t.raw.prepare("SELECT * FROM sessions").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id_hash).toBe(await sha256Hex(session));
    const account = t.raw.prepare("SELECT * FROM accounts").get()!;
    expect(String(account.refresh_token)).toMatch(/^v1\./);
    expect(JSON.stringify(account)).not.toMatch(/mock-rt-|mock-at-/);

    const token = await b.token();
    expect(token.status).toBe(200);
    expect(token.body.user).toEqual({
      id: "google:alice",
      email: "alice@example.com",
      name: "alice",
    });
    expect(t.google.accepts(token.body.access_token)).toBe(true);
    expect(token.body).not.toHaveProperty("refresh_token");
    expect(JSON.stringify(token.body)).not.toMatch(/mock-rt-/);
  });

  it("rejects a forged or missing state and keeps returns inside the app", async () => {
    const b = t.browser();
    const forged = await b.navigate("/api/auth/callback?code=x&state=forged");
    expect(forged.url.searchParams.get("auth")).toBe("state");
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);

    // A real flow whose state is swapped on the way back.
    const start = await t.call(new Request(`${ORIGIN}/api/auth/login`));
    const oauth = start.headers.getSetCookie()[0].split(";")[0];
    const swapped = await t.call(
      new Request(
        `${ORIGIN}/api/auth/callback?code=x&state=${"a".repeat(43)}`,
        {
          headers: { Cookie: oauth },
        },
      ),
    );
    expect(swapped.headers.get("Location")).toBe("/IdeaDock/?auth=state");

    for (const target of [
      "https://evil.example/IdeaDock/",
      "//evil.example/IdeaDock/",
      "/other-app/",
      "/IdeaDock/\\evil",
    ])
      expect(safeReturn(target, ORIGIN)).toBe("/IdeaDock/");
    expect(safeReturn("/IdeaDock/?auth=x#idea=1", ORIGIN)).toBe(
      "/IdeaDock/#idea=1",
    );
  });

  it("reports a cancelled consent without creating a session", async () => {
    t.google.state.deny = true;
    const b = t.browser();
    const done = await b.login();
    expect(done.url.searchParams.get("auth")).toBe("denied");
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("does not ask Google for a new refresh token on every sign-in", async () => {
    const one = t.browser(),
      two = t.browser();
    await one.login();
    await two.login(); // a second device of the same account
    await one.login(); // signing in again on the first device
    expect(t.google.state.refreshTokensIssued).toBe(1);
    expect((await one.token()).status).toBe(200);
    expect((await two.token()).status).toBe(200);
    // Each sign-in replaced that browser's own session instead of piling up.
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n).toBe(
      2,
    );
  });

  it("asks for consent once when Google has a grant but the server lost its token", async () => {
    await t.browser().login();
    t.raw.exec("DELETE FROM accounts");
    const b = t.browser();
    const done = await b.login();
    expect(done.url.pathname).toBe("/IdeaDock/");
    expect(t.google.state.refreshTokensIssued).toBe(2);
    expect((await b.token()).status).toBe(200);
  });
});

describe("long-lived sessions", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("reuses the access token, then refreshes it after an hour", async () => {
    const b = t.browser();
    await b.login();
    const first = await b.token();
    expect((await b.token()).body.access_token).toBe(first.body.access_token);
    expect(t.google.state.refreshCalls).toBe(0);

    t.clock.t += 61 * 60_000;
    expect(t.google.accepts(first.body.access_token)).toBe(false);
    const second = await b.token();
    expect(second.status).toBe(200);
    expect(second.body.access_token).not.toBe(first.body.access_token);
    expect(t.google.accepts(second.body.access_token)).toBe(true);
    expect(t.google.state.refreshCalls).toBe(1);
  });

  it("refreshes once for many simultaneous requests", async () => {
    const tabs = [t.browser(), t.browser(), t.browser()];
    for (const tab of tabs) await tab.login();
    t.clock.t += 2 * 3_600_000;
    const replies = await Promise.all(
      tabs.flatMap((tab) => [tab.token(), tab.token()]),
    );
    expect(replies.every((r) => r.status === 200)).toBe(true);
    expect(new Set(replies.map((r) => r.body.access_token)).size).toBe(1);
    expect(t.google.state.refreshCalls).toBe(1);
  });

  it("replaces a token Drive rejected, but reuses one another device just got", async () => {
    const a = t.browser(),
      b = t.browser();
    await a.login();
    await b.login();
    const old = (await b.token()).body.access_token;
    t.clock.t += 2 * 3_600_000;
    const fresh = (await a.token()).body.access_token;
    // b's old token failed at Drive; a already refreshed, so b gets that one.
    expect((await b.token(old)).body.access_token).toBe(fresh);
    expect(t.google.state.refreshCalls).toBe(1);
    // Drive refuses the fresh one too (e.g. revoked moments ago): refresh.
    t.google.revoke("alice");
    const reply = await b.token(fresh);
    expect(reply.status).toBe(401);
    expect(reply.body.reason).toBe("revoked");
  });

  it.each([7, 30])(
    "restores a session used again after %i days",
    async (days) => {
      const b = t.browser();
      await b.login();
      t.clock.t += days * DAY;
      const reply = await b.token();
      expect(reply.status).toBe(200);
      expect(reply.body.user.id).toBe("google:alice");
      // Using it pushed the expiry forward again.
      const session = t.raw.prepare("SELECT * FROM sessions").get()!;
      expect(Number(session.expires_at)).toBe(t.clock.t + 60 * DAY);
    },
  );

  it("stays signed in with regular use but ends after 60 idle days or 400 in total", async () => {
    const b = t.browser();
    await b.login();
    for (let day = 0; day < 390; day += 30) {
      t.clock.t += 30 * DAY;
      expect((await b.token()).status).toBe(200);
    }
    t.clock.t += 30 * DAY; // 420 days after sign-in
    expect((await b.token()).body.reason).toBe("session");

    const idle = t.browser();
    await idle.login();
    t.clock.t += 61 * DAY;
    const reply = await idle.token();
    expect(reply.status).toBe(401);
    expect(reply.body.reason).toBe("session");
    expect(idle.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("keeps the session through a Google outage or network failure", async () => {
    const b = t.browser();
    await b.login();
    t.clock.t += 2 * 3_600_000;
    t.google.state.outage = true;
    const down = await b.token();
    expect(down.status).toBe(503);
    expect(down.body.reason).toBe("unavailable");
    expect(b.jar.has(SESSION_COOKIE)).toBe(true);
    t.google.state.outage = false;
    expect((await b.token()).status).toBe(200);
  });

  it("asks to sign in again only when Google revoked the grant", async () => {
    const alice = t.browser(),
      phone = t.browser(),
      bob = t.browser();
    await alice.login();
    await phone.login();
    t.google.state.nextUser = "bob";
    await bob.login("&switch=1");
    t.google.revoke("alice");
    t.clock.t += 2 * 3_600_000;
    const reply = await alice.token();
    expect(reply.status).toBe(401);
    expect(reply.body.reason).toBe("revoked");
    expect((await phone.token()).body.reason).toBe("session");
    // Other accounts are untouched.
    expect((await bob.token()).body.user.id).toBe("google:bob");
    // Signing in again grants a new token and works.
    t.google.state.nextUser = "alice";
    await alice.login("&switch=1");
    expect((await alice.token()).status).toBe(200);
  });

  it("ends a Testing-mode grant after 7 days and recovers on sign-in", async () => {
    t = setup({ refreshLifetime: 7 * DAY });
    const b = t.browser();
    await b.login();
    t.clock.t += 6 * DAY;
    expect((await b.token()).status).toBe(200);
    t.clock.t += 2 * DAY;
    expect((await b.token()).body.reason).toBe("revoked");
    await b.login("&consent=1");
    expect((await b.token()).status).toBe(200);
  });

  it("switching accounts replaces the browser's session", async () => {
    const b = t.browser();
    await b.login();
    const before = b.jar.get(SESSION_COOKIE);
    t.google.state.nextUser = "bob";
    await b.login("&switch=1");
    expect(b.jar.get(SESSION_COOKIE)).not.toBe(before);
    expect((await b.token()).body.user.id).toBe("google:bob");
    expect(
      t.raw
        .prepare("SELECT sub FROM sessions")
        .all()
        .map((r) => r.sub),
    ).toEqual(["bob"]);
  });
});

describe("sign-out and request forgery", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("signs out one device, or every device with a revoke", async () => {
    const a = t.browser(),
      b = t.browser();
    await a.login();
    await b.login();
    expect((await a.post("/api/auth/logout")).status).toBe(200);
    expect(a.jar.has(SESSION_COOKIE)).toBe(false);
    expect((await a.token()).status).toBe(401);
    expect((await b.token()).status).toBe(200);

    await a.login();
    await a.post("/api/auth/logout", { everywhere: true });
    expect(t.google.state.revokeCalls).toBe(1);
    expect((await b.token()).body.reason).toBe("session");
    expect(
      t.raw.prepare("SELECT refresh_token FROM accounts").get()!.refresh_token,
    ).toBe(null);
  });

  it.each([
    ["no Origin", { Origin: "" }],
    ["another origin", { Origin: "https://evil.example" }],
    ["a cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
    ["no custom header", { "X-IdeaDock-Auth": "" }],
    ["a form post", { "Content-Type": "application/x-www-form-urlencoded" }],
  ])("refuses token and logout requests with %s", async (_name, headers) => {
    const b = t.browser();
    await b.login();
    for (const path of ["/api/auth/token", "/api/auth/logout"]) {
      const reply = await b.post(path, {}, headers as Record<string, string>);
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ reason: "csrf" });
    }
    // The session survived the attempts.
    expect((await b.token()).status).toBe(200);
  });

  it("refuses GET for token endpoints and unknown cookies", async () => {
    const b = t.browser();
    await b.login();
    const get = await t.call(
      new Request(`${ORIGIN}/api/auth/token`, {
        headers: { Cookie: `${SESSION_COOKIE}=${b.jar.get(SESSION_COOKIE)}` },
      }),
    );
    expect(get.status).toBe(403);
    b.jar.set(SESSION_COOKIE, "x".repeat(43));
    expect((await b.token()).body.reason).toBe("session");
  });

  it("answers 503 without details when secrets are missing", async () => {
    const reply = await handleAuth(new Request(`${ORIGIN}/api/auth/login`), {
      ...t.env,
      TOKEN_ENCRYPTION_KEY: "short",
    });
    expect(reply.status).toBe(503);
    expect(await reply.json()).toEqual({ reason: "config" });
  });
});

describe("token sealing", () => {
  it("detects tampering and refuses ciphertext from another context", async () => {
    const sealer = await Sealer.fromSecret(key);
    const sealed = await sealer.seal("refresh-secret", "refresh:alice");
    expect(sealed).not.toContain("refresh-secret");
    expect(await sealer.open(sealed, "refresh:alice")).toBe("refresh-secret");
    expect(await sealer.open(sealed, "refresh:bob")).toBe(null);
    const [v, iv, data] = sealed.split(".");
    const flipped =
      data.slice(0, -2) + (data.at(-2) === "A" ? "B" : "A") + data.at(-1);
    expect(await sealer.open(`${v}.${iv}.${flipped}`, "refresh:alice")).toBe(
      null,
    );
    const other = await Sealer.fromSecret(
      base64url(crypto.getRandomValues(new Uint8Array(32))),
    );
    expect(await other.open(sealed, "refresh:alice")).toBe(null);
    await expect(Sealer.fromSecret("too-short")).rejects.toThrow();
    // Two seals of the same text differ (fresh IV each time).
    expect(await sealer.seal("x", "c")).not.toBe(await sealer.seal("x", "c"));
  });
});
