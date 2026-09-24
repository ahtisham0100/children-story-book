import { describe, it, expect } from "vitest";
import {
  TOKEN_TTL_MS,
  expiryFrom,
  generateToken,
  hashToken,
  isTokenUsable,
} from "../../src/auth/tokens";

describe("token generation", () => {
  it("returns a raw value plus its SHA-256, and the raw is never the stored hash", () => {
    const { raw, hash } = generateToken();
    expect(raw).not.toEqual(hash);
    expect(hash).toEqual(hashToken(raw));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashToken is deterministic and unique per input", () => {
    expect(hashToken("abc")).toEqual(hashToken("abc"));
    expect(hashToken("abc")).not.toEqual(hashToken("abd"));
  });

  it("generates distinct tokens", () => {
    expect(generateToken().raw).not.toEqual(generateToken().raw);
  });
});

describe("token TTLs (spec)", () => {
  it("expires password reset in 30 minutes", () => {
    expect(TOKEN_TTL_MS.password_reset).toBe(30 * 60_000);
  });
  it("keeps magic-link login short (15 min) and activation generous (7 days)", () => {
    expect(TOKEN_TTL_MS.magic_link).toBe(15 * 60_000);
    expect(TOKEN_TTL_MS.activation).toBe(7 * 24 * 60 * 60_000);
  });

  it("expiryFrom adds the purpose's TTL to now", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(expiryFrom("password_reset", now).getTime()).toBe(now.getTime() + 30 * 60_000);
  });
});

describe("isTokenUsable", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const future = new Date(now.getTime() + 60_000);
  const past = new Date(now.getTime() - 60_000);

  it("is usable when unconsumed and unexpired", () => {
    expect(isTokenUsable({ consumedAt: null, expiresAt: future }, now)).toBe(true);
  });
  it("is not usable once consumed", () => {
    expect(isTokenUsable({ consumedAt: past, expiresAt: future }, now)).toBe(false);
  });
  it("is not usable once expired", () => {
    expect(isTokenUsable({ consumedAt: null, expiresAt: past }, now)).toBe(false);
  });
});
