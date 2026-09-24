import { describe, expect, it } from "vitest";
import { redact, summarize } from "../../src/admin/redact";

const SIGNED =
  "https://acct123.r2.cloudflarestorage.com/bucket/sessions/s1/characters/c1/raw.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20260924&X-Amz-Signature=abcdef0123";

describe("redact", () => {
  it("replaces emails anywhere in a string", () => {
    expect(redact("send to Jane.Doe+books@Example.co.uk now")).toBe("send to [redacted-email] now");
  });

  it("replaces R2 URLs, signed or not", () => {
    expect(redact(`fetch ${SIGNED} failed`)).toBe("fetch [redacted-url] failed");
    expect(redact("https://pub-abc.r2.dev/sessions/s1/pages/p1.png")).toBe("[redacted-url]");
    expect(redact("https://acct.r2.cloudflarestorage.com/bucket/key")).toBe("[redacted-url]");
  });

  it("replaces any URL carrying a presigning signature, whatever the host", () => {
    expect(redact("https://cdn.example.com/x.png?Signature=abc&Expires=1")).toBe("[redacted-url]");
    expect(redact("http://s3.example/x?X-Amz-Signature=abc")).toBe("[redacted-url]");
  });

  it("leaves ordinary text, ids, keys and harmless URLs alone", () => {
    const text = "order 1111 failed at sessions/s1/pages/p1.png; see https://docs.bullmq.io/guide";
    expect(redact(text)).toBe(text);
  });

  it("walks nested objects and arrays without mutating the input", () => {
    const input = {
      orderId: "o1",
      photoUrl: SIGNED,
      nested: { emails: ["a@b.co", "keep me"], n: 3, ok: true, nothing: null },
    };
    const copy = structuredClone(input);
    expect(redact(input)).toEqual({
      orderId: "o1",
      photoUrl: "[redacted-url]",
      nested: { emails: ["[redacted-email]", "keep me"], n: 3, ok: true, nothing: null },
    });
    expect(input).toEqual(copy);
  });

  it("redacts stack traces line by line", () => {
    const stack = [`Error: Gelato rejected order for jane@example.com`, `    at fetch (${SIGNED})`];
    expect(redact(stack)).toEqual(["Error: Gelato rejected order for [redacted-email]", "    at fetch ([redacted-url])"]);
  });
});

describe("summarize", () => {
  it("is redacted JSON, truncated", () => {
    expect(summarize({ orderId: "o1" })).toBe('{"orderId":"o1"}');
    expect(summarize({ email: "a@b.co" })).toBe('{"email":"[redacted-email]"}');
    const long = summarize({ text: "x".repeat(500) }, 50);
    expect(long.length).toBe(50);
    expect(long.endsWith("…")).toBe(true);
  });

  it("copes with undefined data", () => {
    expect(summarize(undefined)).toBe("");
  });
});
