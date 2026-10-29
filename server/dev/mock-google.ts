// Mock Google OAuth 2.0 server for tests and the local mock deployment. It
// enforces what the real one does for IdeaDock: client secret, redirect URI,
// single-use codes, PKCE S256, refresh tokens only on first consent, revocation
// and access-token expiry. Never deployed.
import { pkceChallenge, randomToken } from "../auth/crypto.ts";
import type { GoogleEndpoints } from "../auth/handler.ts";

type Grant = { refresh: Set<string>; revoked: boolean; issuedAt: number };
type Code = {
  sub: string;
  challenge: string;
  method: string;
  redirect: string;
  scope: string;
  nonce: string;
  refresh?: string;
  used: boolean;
};
export type MockGoogleOptions = {
  clientId: string;
  clientSecret: string;
  now: () => number;
  /** Refresh tokens stop working after this long (Testing apps: 7 days). */
  refreshLifetime?: number;
  base?: string;
};
const users: Record<string, { email: string; name: string }> = {};
export const mockUser = (sub: string) =>
  (users[sub] ??= { email: `${sub}@example.com`, name: sub });

export function createMockGoogle(options: MockGoogleOptions) {
  const base = options.base ?? "https://mock-google.test";
  const grants = new Map<string, Grant>();
  const codes = new Map<string, Code>();
  const access = new Map<string, { sub: string; expires: number }>();
  const state = {
    refreshCalls: 0,
    refreshTokensIssued: 0,
    revokeCalls: 0,
    outage: false,
    /** Account chosen on the consent screen when no login_hint is given. */
    nextUser: "alice",
    /** The user presses "Cancel" on the consent screen. */
    deny: false,
  };
  const endpoints: GoogleEndpoints = {
    authorize: `${base}/o/oauth2/v2/auth`,
    token: `${base}/token`,
    revoke: `${base}/revoke`,
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const jwt = (claims: Record<string, unknown>) =>
    [
      btoa(JSON.stringify({ alg: "none" })),
      btoa(JSON.stringify(claims)).replace(/=+$/, ""),
      "",
    ].join(".");
  function issueAccess(sub: string) {
    const token = `mock-at-${sub}-${randomToken(9)}`;
    access.set(token, { sub, expires: options.now() + 3599_000 });
    return token;
  }
  /** What the consent screen would do: returns the redirect back to the app. */
  function authorize(url: URL) {
    const p = url.searchParams;
    const redirect = p.get("redirect_uri") ?? "";
    const back = new URL(redirect);
    back.searchParams.set("state", p.get("state") ?? "");
    if (
      p.get("client_id") !== options.clientId ||
      p.get("response_type") !== "code"
    )
      throw new Error("mock google: bad authorize request");
    if (state.deny) {
      back.searchParams.set("error", "access_denied");
      return back.toString();
    }
    const prompt = p.get("prompt") ?? "";
    const sub =
      (!prompt.includes("select_account") && p.get("login_hint")) ||
      state.nextUser;
    mockUser(sub);
    let grant = grants.get(sub);
    const fresh = !grant || grant.revoked;
    if (fresh) {
      grant = { refresh: new Set(), revoked: false, issuedAt: options.now() };
      grants.set(sub, grant);
    }
    let refresh: string | undefined;
    if (
      p.get("access_type") === "offline" &&
      (fresh || prompt.includes("consent"))
    ) {
      refresh = `mock-rt-${sub}-${randomToken(9)}`;
      grant!.refresh.add(refresh);
      grant!.issuedAt = options.now();
      state.refreshTokensIssued++;
    }
    const code = randomToken();
    codes.set(code, {
      sub,
      challenge: p.get("code_challenge") ?? "",
      method: p.get("code_challenge_method") ?? "",
      redirect,
      scope: p.get("scope") ?? "",
      nonce: p.get("nonce") ?? "",
      refresh,
      used: false,
    });
    back.searchParams.set("code", code);
    return back.toString();
  }
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(
      new URL(base).pathname.replace(/\/$/, "").length,
    );
    if (path === "/o/oauth2/v2/auth")
      return new Response(null, {
        status: 302,
        headers: { Location: authorize(url) },
      });
    const form = new URLSearchParams(await request.text());
    if (path === "/revoke") {
      state.revokeCalls++;
      for (const grant of grants.values())
        if (grant.refresh.has(form.get("token") ?? "")) grant.revoked = true;
      return reply(200, {});
    }
    if (path !== "/token") return reply(404, {});
    if (state.outage) return reply(503, { error: "backend_error" });
    if (
      form.get("client_id") !== options.clientId ||
      form.get("client_secret") !== options.clientSecret
    )
      return reply(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      if (
        !code ||
        code.used ||
        code.redirect !== form.get("redirect_uri") ||
        code.method !== "S256" ||
        (await pkceChallenge(form.get("code_verifier") ?? "")) !==
          code.challenge
      )
        return reply(400, { error: "invalid_grant" });
      code.used = true;
      const user = mockUser(code.sub);
      return reply(200, {
        access_token: issueAccess(code.sub),
        expires_in: 3599,
        scope: code.scope,
        token_type: "Bearer",
        id_token: jwt({
          iss: "https://accounts.google.com",
          aud: options.clientId,
          sub: code.sub,
          email: user.email,
          name: user.name,
          nonce: code.nonce,
          exp: Math.floor(options.now() / 1000) + 3600,
        }),
        ...(code.refresh ? { refresh_token: code.refresh } : {}),
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      state.refreshCalls++;
      const token = form.get("refresh_token") ?? "";
      const entry = [...grants.entries()].find(([, g]) => g.refresh.has(token));
      const expired =
        entry &&
        options.refreshLifetime !== undefined &&
        options.now() - entry[1].issuedAt > options.refreshLifetime;
      if (!entry || entry[1].revoked || expired)
        return reply(400, { error: "invalid_grant" });
      return reply(200, {
        access_token: issueAccess(entry[0]),
        expires_in: 3599,
        scope:
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.file",
        token_type: "Bearer",
      });
    }
    return reply(400, { error: "unsupported_grant_type" });
  }
  return {
    endpoints,
    state,
    fetch,
    /** Revoke in "Google Account > Security > Third-party access". */
    revoke(sub: string) {
      const grant = grants.get(sub);
      if (grant) grant.revoked = true;
      for (const [token, value] of access)
        if (value.sub === sub) access.delete(token);
    },
    /** Whether Drive would accept this bearer token right now. */
    accepts(token: string) {
      const entry = access.get(token);
      return (
        !!entry &&
        entry.expires > options.now() &&
        !grants.get(entry.sub)?.revoked
      );
    },
  };
}
