# Minimal UI release verification

This release keeps Google Drive/IndexedDB storage and legacy recovery code while simplifying the existing three-panel UI. It adds first-image list thumbnails, steel blue light/dark colors, a 290px default sidebar with saved custom widths preserved, 54px panel headers, and a compact connection card. Signed-out screens do not imply that the account has zero ideas. Creating an idea opens its title immediately; search/quick-capture inputs and shortcuts are removed.

Data management is collapsed by default and exposes only JSON backup, JSON import, and legacy discovery. Diagnostics, editable previews, integrity checks, recovery backups, explicit approvals, and resumable/idempotent migration remain available in a keyboard-accessible modal. Existing data is never automatically deleted or uploaded.

## Local checks

- TypeScript and credential preflight: passed.
- Unit/regression: 52 passed.
- Static browser tests: 22 passed on desktop/mobile, including light/dark accessibility, signed-out versus empty demo state, custom sidebar widths, thumbnails, backup/import/restore, corrupt-cache preservation, and browser shortcut behavior.
- Mock OAuth/Drive browser tests: 8 passed, including a connected empty account, approval, repeated migration, image integrity/reload, interrupted upload retry, save errors and concurrent-edit warnings.
- GitHub Pages static export and `/IdeaDock/` asset verification: passed. Mock OAuth builds are replaced by a normal environment build before release.

## Screenshots

The screenshots use synthetic data in separate browser contexts and never write to a real Google account.

- [Desktop signed out](screenshots/ui-final/desktop-login.png)
- [Mobile signed out](screenshots/ui-final/mobile-login.png)
- [Desktop list](screenshots/ui-final/desktop-list.png)
- [Mobile list](screenshots/ui-final/mobile-list.png)
- [Data management](screenshots/ui-final/desktop-data.png)
- [Legacy discovery modal](screenshots/ui-final/desktop-discovery.png)
- [Mobile import modal](screenshots/ui-final/mobile-import.png)
- [Dark mode](screenshots/ui-final/desktop-dark.png)

## Verification boundary

Mock OAuth/Drive tests are not real Google login tests. This release does not claim a new real-account login, live Drive mutation, or physical-device synchronization check. Public-site verification after deployment must use a fresh browser context and synthetic local demo data; no existing Drive ideas, images, or backups may be modified by that check. The existing main-only CI-gated Pages workflows are unchanged.
