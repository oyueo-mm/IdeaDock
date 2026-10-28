// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Request = { login_hint?: string; prompt: string };
const requests: Request[] = [];
let profile = { sub: "alice", email: "alice@example.com", name: "Alice" };
let driveStatus = 200;
let expiresIn = 3600;

// Each import is a fresh page load: module memory is lost, browser storage is not.
async function load() {
  vi.resetModules();
  return import("../src/lib/drive");
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  requests.length = 0;
  profile = { sub: "alice", email: "alice@example.com", name: "Alice" };
  driveStatus = 200;
  expiresIn = 3600;
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test.apps.googleusercontent.com");
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (options) => ({
          requestAccessToken: ({ prompt }) => {
            requests.push({ login_hint: options.login_hint, prompt });
            options.callback({
              access_token: `token-${profile.sub}`,
              expires_in: expiresIn,
              scope: `openid email profile ${options.scope.split(" ").pop()}`,
            });
          },
        }),
      },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("userinfo")
        ? Response.json(profile)
        : new Response("{}", { status: driveStatus }),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Drive sign-in persistence", () => {
  it("shows the chooser on first sign-in and uses a login hint afterwards", async () => {
    const drive = await load();
    const user = await drive.connectDrive();
    expect(requests.at(-1)).toEqual({
      login_hint: undefined,
      prompt: "select_account",
    });
    await drive.connectDrive({ hint: user });
    expect(requests.at(-1)).toEqual({ login_hint: "alice", prompt: "" });
  });
  it("keeps the token across a reload of the remembered account only", async () => {
    let drive = await load();
    const user = await drive.connectDrive();
    drive.rememberDriveUser(user);
    expect(localStorage.getItem("ideadock:drive-account")).not.toContain(
      "token",
    );
    drive = await load();
    expect(drive.driveSessionAccount()).toBe("google:alice");
    // A token for a different (or forgotten) workspace is discarded.
    localStorage.setItem(
      "ideadock:drive-account",
      JSON.stringify({ ...user, id: "google:bob" }),
    );
    drive = await load();
    expect(drive.driveSessionAccount()).toBeNull();
    expect(sessionStorage.getItem("ideadock:drive-session")).toBeNull();
  });
  it("never restores an expired token and drops it when it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let drive = await load();
    const user = await drive.connectDrive();
    drive.rememberDriveUser(user);
    const changes = vi.fn();
    drive.subscribeDriveSession(changes);
    vi.advanceTimersByTime(3600 * 1000);
    expect(changes).toHaveBeenCalled();
    expect(drive.driveSessionAccount()).toBeNull();
    expect(sessionStorage.getItem("ideadock:drive-session")).toBeNull();
    expiresIn = 7 * 24 * 3600; // Never trust a lifetime above one hour.
    await drive.connectDrive({ hint: user });
    vi.advanceTimersByTime(3600 * 1000);
    drive = await load();
    expect(drive.driveSessionAccount()).toBeNull();
  });
  it("turns a 401 into a reconnect request without losing the workspace", async () => {
    const drive = await load();
    const user = await drive.connectDrive();
    drive.rememberDriveUser(user);
    driveStatus = 401;
    const repo = drive.activeDriveRepository();
    await expect(repo.remote.list("idea")).rejects.toBeInstanceOf(
      drive.DriveAuthError,
    );
    expect(drive.driveSessionAccount()).toBeNull();
    expect(sessionStorage.getItem("ideadock:drive-session")).toBeNull();
    // Cached drafts and images still resolve to the remembered account.
    expect(drive.activeDriveRepository().account).toBe("google:alice");
    await expect(repo.remote.list("idea")).rejects.toBeInstanceOf(
      drive.DriveAuthError,
    );
  });
  it("forgets token and account at sign-out", async () => {
    let drive = await load();
    const user = await drive.connectDrive();
    drive.rememberDriveUser(user);
    drive.forgetDriveUser();
    expect(localStorage.getItem("ideadock:drive-account")).toBeNull();
    expect(sessionStorage.getItem("ideadock:drive-session")).toBeNull();
    drive = await load();
    expect(drive.rememberedDriveUser()).toBeNull();
    expect(drive.driveSessionAccount()).toBeNull();
    expect(() => drive.activeDriveRepository()).toThrow("연결이 필요");
  });
  it("ignores malformed stored values", async () => {
    localStorage.setItem("ideadock:drive-account", "{not json");
    sessionStorage.setItem(
      "ideadock:drive-session",
      JSON.stringify({ token: 1, expires: "x" }),
    );
    const drive = await load();
    expect(drive.rememberedDriveUser()).toBeNull();
    expect(drive.driveSessionAccount()).toBeNull();
  });
});
