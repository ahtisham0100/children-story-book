import { describe, it, expect } from "vitest";
import { SESSION_COOKIE, sessionCookieOptions, sessionTtlMs } from "../../src/auth/session";

describe("session cookie hardening", () => {
  it("is always httpOnly and site-wide", () => {
    const opts = sessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/");
  });

  it("derives maxAge (seconds) from the session TTL", () => {
    const opts = sessionCookieOptions();
    expect(opts.maxAge).toBe(Math.floor(sessionTtlMs() / 1000));
  });

  it("builds a clearing cookie (maxAge 0) for logout", () => {
    expect(sessionCookieOptions(0).maxAge).toBe(0);
  });

  it("has a stable cookie name", () => {
    expect(SESSION_COOKIE).toBe("cbp_session");
  });
});
