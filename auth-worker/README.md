# IdeaDock: single-origin Cloudflare authentication

This is an **opt-in migration**, not a replacement for the existing GitHub Pages deployment. Keep Pages running as the rollback target until account- and device-level verification is complete.

## Architecture

- The **same Cloudflare Worker origin** serves the current Next.js static export at `/IdeaDock/` and the OAuth endpoints at `/IdeaDock/api/auth/*`.
- Google authorization code + PKCE + state cookie; `access_type=offline` and Drive `drive.file` scope.
- A **30-day sliding HttpOnly, Secure, SameSite=Lax session cookie**; session identifier is never stored in plaintext in D1.
- D1 stores only user identity and AES-GCM-encrypted refresh/access tokens. The AES key and Google OAuth secret are Worker secrets, never GitHub source or client bundles.
- The browser receives short-lived **access tokens only** so the existing Drive read/write code remains compatible. Refresh tokens are never returned to the browser.
- Every refresh is performed by Worker on demand; Drive continues to hold all idea content, revisions and images.
- The old Github Pages login path remains unchanged while `NEXT_PUBLIC_AUTH_MODE` is unset.


## Recommended activation: GitHub Actions (no local Cloudflare CLI required)

After this feature is merged and the one-time Google Cloud + Cloudflare resources exist, the repository has a **manual, main-only** workflow named **Deploy IdeaDock auth Worker (manual)**. It does not run automatically, never changes the normal Pages CI, and must remain staging until live authorization and cross-device testing succeed.

1. In Cloudflare create a Workers account, choose a `workers.dev` subdomain, and create a D1 database named `ideadock-auth` (get its database ID). Create an API token with permissions to edit Workers and D1 for this account.
2. In GitHub **Settings → Secrets and variables → Actions → Variables**, add `CF_D1_DATABASE_ID` with the new D1 database ID.
3. In GitHub **Settings → Environments**, create `ideadock-auth-staging` with required reviewers if desired, and place the following as **environment secrets**: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `APP_ORIGIN`. `SESSION_ENCRYPTION_KEY` is an independently generated 32-byte random base64 value; never expose it in issues or chat.
4. In Google Cloud register the **exact** redirect URI `<APP_ORIGIN>/IdeaDock/api/auth/callback` for the Google Web OAuth client from the **original Drive-enabled Cloud project**. The OAuth consent screen should be appropriately published before depending on long-term refresh.
5. In **Actions → Deploy IdeaDock auth Worker (manual) → Run workflow**, run on `main` after its tests pass. The workflow validates configuration, runs tests, builds Worker-mode assets, applies D1 migrations, deploys, sets Worker-only secrets, and verifies `GET /IdeaDock/api/auth/session` returns 401 without a session.
6. **Do not redirect existing users yet.** Check the Worker URL in a new browser, sign in to the existing Google account, verify Drive content access, perform cross-device edit/sync and full logout/restart/recovery checks. If older drafts remain only in `github.io` browser storage, finish or export them before switching.

The owner must provision these resources because they cannot be created from GitHub source code alone. A successful CI/workflow only verifies infrastructure and the unauthenticated endpoint; **it does not prove that real Google OAuth consent, Drive data access, refresh-token retention, or cross-device behavior work**.

## One-time Cloudflare + Google Cloud setup (owner action)

1. Create a Cloudflare account and use its Workers feature. A dedicated domain is optional because a `workers.dev` subdomain is sufficient when **both the UI and auth API are served from the same Worker origin**.
2. In **the same Google Cloud project as the existing IdeaDock Drive OAuth app**, create or configure a **Web application** OAuth client, obtaining Client ID and Client Secret. Keep the existing client and site unchanged. Register the exact redirect URI:
   `https://ideadock-auth.<your-workers-subdomain>.workers.dev/IdeaDock/api/auth/callback`
   If using a custom domain, use its exact origin instead. Ensure the OAuth consent screen is Production before expecting >7-day refresh-token validity for external users.
3. Run `npx wrangler login`, then `npx wrangler d1 create ideadock-auth`. Copy `wrangler.example.toml` to `wrangler.toml` and replace `REPLACE_WITH_D1_DATABASE_ID`. Do **not** commit `wrangler.toml`.
4. Run `npx wrangler d1 migrations apply ideadock-auth --remote` after the configuration is saved.
5. Set the following **four Worker secrets** (never commit or share them in chat): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `APP_ORIGIN`. Use `npx wrangler secret put <NAME>` for each. `APP_ORIGIN` must exactly equal `https://ideadock-auth.<your-workers-subdomain>.workers.dev` without trailing slash. Generate `SESSION_ENCRYPTION_KEY` locally as 32 cryptographically random bytes encoded in base64; changing it invalidates stored sessions.
6. Make a full backup of the existing IdeaDock and **sync all pending changes** on each device before switching domains. IndexedDB and localStorage from `oyueo-mm.github.io` are **not accessible** from the new Cloudflare origin. Data already stored in Google Drive remains available to the same Google account, subject to Google's `drive.file` per-app permissions.
7. Build an explicitly opt-in Worker variant:
   `NEXT_PUBLIC_AUTH_MODE=worker NEXT_PUBLIC_STORAGE_BACKEND=drive NEXT_PUBLIC_GOOGLE_DRIVE_SPACE=drive npm run build` (set these environment variables using PowerShell syntax if on Windows).
   This does not require the old browser token-model Client ID, but keeping the old `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is harmless.
8. Run `npx wrangler deploy`. Open `https://ideadock-auth.<your-workers-subdomain>.workers.dev/IdeaDock/`. Login with the same Google account and verify that all existing ideas/images and folder structures appear, create a test edit, sign out and back in, and verify a **second physical device** receives it.
9. Test automatic refresh after access-token expiry, reconnection after browser restart, offline edits and rollback. **Only then** choose whether to redirect the old Pages URL to the new Worker-hosted site. The previous Pages deployment remains the safe fallback.

### Fail-safe and rollback

- The new mode is compiled only when `NEXT_PUBLIC_AUTH_MODE=worker`.
- Production GitHub Pages CI remains in its existing token model; it must **not** be rebuilt with Worker mode.
- The Worker never deletes or moves the Drive data.
- If Worker OAuth fails, go back to `https://oyueo-mm.github.io/IdeaDock/` with the original browser login model.
- Before first use on the new origin, all pending drafts on the old origin must be uploaded or exported. The Worker cannot migrate browser-local drafts across origins.
- Do not export the D1 database to public artifacts or install devtools logging of tokens.

### API

`GET /IdeaDock/api/auth/start`: redirects to Google OAuth (optional `?switch=1` for account selection).

`GET /IdeaDock/api/auth/callback`: validates an encrypted short-lived state/PKCE cookie, exchanges Google code and creates encrypted server-side credentials.

`GET /IdeaDock/api/auth/session`: checks the session cookie, refreshes access tokens when needed and returns a **no-store** JSON payload `{ authenticated, token, expires, user }`. An unauthenticated user gets HTTP 401.

`POST /IdeaDock/api/auth/logout`: requires same-origin Origin and deletes server-side session and browser cookie.

This provides **automatic long-lived Drive authorization**, not websocket-based instant collaboration; the existing polling interval stays at 15 seconds.

## Google token limits

Google can revoke refresh tokens or apply a 7-day expiry while an external OAuth app remains in Testing. The 30-day cookie only controls IdeaDock's own session and does not override Google token validity.

See: https://developers.google.com/identity/protocols/oauth2/web-server and https://developers.cloudflare.com/workers/static-assets/.
