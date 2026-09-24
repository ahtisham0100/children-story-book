import { describe, expect, it } from "vitest";
import { isIssuedRawObjectKey, rawObjectKey } from "../../src/storage";

const SESSION = "11111111-1111-4111-8111-111111111111";
const CHARACTER = "22222222-2222-4222-8222-222222222222";
const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER_CHARACTER = "44444444-4444-4444-8444-444444444444";

describe("isIssuedRawObjectKey", () => {
  it.each(["image/jpeg", "image/png", "image/webp"])("accepts the key upload-url issues for %s", (contentType) => {
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, rawObjectKey(SESSION, CHARACTER, contentType))).toBe(true);
  });

  it("rejects another character's key in the same session", () => {
    const key = rawObjectKey(SESSION, OTHER_CHARACTER, "image/png");
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, key)).toBe(false);
  });

  it("rejects the right character id under a different session", () => {
    const key = rawObjectKey(OTHER_SESSION, CHARACTER, "image/png");
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, key)).toBe(false);
  });

  it("rejects arbitrary objects in the bucket", () => {
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `sessions/${OTHER_SESSION}/pages/page-1.png`)).toBe(false);
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, "orders/abc/items/def/print.pdf")).toBe(false);
  });

  it("rejects path traversal out of the character's prefix", () => {
    const key = `sessions/${SESSION}/characters/${CHARACTER}/../../../${OTHER_SESSION}/characters/${OTHER_CHARACTER}/raw.png`;
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, key)).toBe(false);
  });

  it("rejects extensions the server never issues", () => {
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `sessions/${SESSION}/characters/${CHARACTER}/raw.gif`)).toBe(false);
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `sessions/${SESSION}/characters/${CHARACTER}/raw.undefined`)).toBe(false);
  });

  it("rejects prefixed, suffixed or case-altered variants of a valid key", () => {
    const valid = rawObjectKey(SESSION, CHARACTER, "image/jpeg");
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `/${valid}`)).toBe(false);
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `x/${valid}`)).toBe(false);
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `${valid}.png`)).toBe(false);
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, `${valid} `)).toBe(false);
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, valid.toUpperCase())).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(isIssuedRawObjectKey(SESSION, CHARACTER, "")).toBe(false);
  });
});
