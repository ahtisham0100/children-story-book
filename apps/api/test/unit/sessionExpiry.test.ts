import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({ SESSION_TTL_HOURS: 72 }));
vi.mock("../../src/env", () => ({ env: mockEnv }));

import { newSessionExpiry, sessionActivity, sessionExpiresAt } from "../../src/sessionExpiry";

const NOW = new Date("2026-09-23T12:00:00.000Z");

describe("session expiry", () => {
  it("expires TTL hours after the given time", () => {
    expect(sessionExpiresAt(NOW, 72).toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(sessionExpiresAt(NOW, 1).toISOString()).toBe("2026-09-23T13:00:00.000Z");
  });

  it("a new session expires SESSION_TTL_HOURS from creation", () => {
    expect(newSessionExpiry(NOW)).toEqual({
      expiresAt: new Date("2026-09-26T12:00:00.000Z"),
      lastActivityAt: NOW,
    });
  });

  it("activity slides the expiry forward from the time of the activity", () => {
    const later = new Date("2026-09-25T09:30:00.000Z");
    const { expiresAt, lastActivityAt } = sessionActivity(later);
    expect(lastActivityAt).toBe(later);
    expect(expiresAt.toISOString()).toBe("2026-09-28T09:30:00.000Z");
    expect(expiresAt.getTime()).toBeGreaterThan(newSessionExpiry(NOW).expiresAt.getTime());
  });

  it("honours a configured TTL", () => {
    mockEnv.SESSION_TTL_HOURS = 24;
    expect(newSessionExpiry(NOW).expiresAt.toISOString()).toBe("2026-09-24T12:00:00.000Z");
    mockEnv.SESSION_TTL_HOURS = 72;
  });
});
