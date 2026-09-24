import { describe, it, expect } from "vitest";
import { assessPasswordStrength, hashPassword, verifyPassword } from "../../src/auth/password";

describe("password hashing", () => {
  it("verifies a correct password against its own hash", async () => {
    const stored = await hashPassword("Sunflower22");
    expect(await verifyPassword("Sunflower22", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("Sunflower22");
    expect(await verifyPassword("sunflower22", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("produces a different salt (and hash) each time", async () => {
    const a = await hashPassword("Sunflower22");
    const b = await hashPassword("Sunflower22");
    expect(a).not.toEqual(b);
    // ...yet both still verify.
    expect(await verifyPassword("Sunflower22", a)).toBe(true);
    expect(await verifyPassword("Sunflower22", b)).toBe(true);
  });

  it("returns false (never throws) for a malformed stored value", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-the-format")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "scrypt$aa$")).toBe(false);
  });
});

describe("assessPasswordStrength", () => {
  it("rejects anything under the length floor", () => {
    expect(assessPasswordStrength("Ab1").acceptable).toBe(false);
    expect(assessPasswordStrength("Abcd12").acceptable).toBe(false);
  });

  it("rejects a long password with only one character class", () => {
    // 'password' is length-8 but all lowercase — one class, not acceptable.
    expect(assessPasswordStrength("passwordpassword").acceptable).toBe(false);
  });

  it("accepts once it clears the length floor with 2+ classes", () => {
    const r = assessPasswordStrength("Sunflower22");
    expect(r.acceptable).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(2);
  });

  it("scales the score up to 4 for long, varied passwords", () => {
    expect(assessPasswordStrength("Sunflower-22!x").score).toBe(4);
    expect(assessPasswordStrength("").score).toBe(0);
  });
});
