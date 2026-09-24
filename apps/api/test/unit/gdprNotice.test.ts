import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GDPR_DELETION_NOTICE } from "../../src/gdpr/notice";
import { P1_GRACE_MS, P2_PROCESSED_DELAY_MS, P2_RAW_DELAY_MS } from "../../src/gdpr/schedule";

// The deletion promise appears in API emails/receipts AND on web pages that
// can't import API code. This keeps the two copies identical.
const WEB_NOTICE = fileURLToPath(new URL("../../../web/lib/gdprNotice.ts", import.meta.url));

function evalWebNotice(): string {
  const source = readFileSync(WEB_NOTICE, "utf-8");
  const body = source.slice(source.indexOf("GDPR_DELETION_NOTICE =") + "GDPR_DELETION_NOTICE =".length);
  const literals = body.slice(0, body.indexOf(";")).match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
  return literals.map((l) => JSON.parse(l) as string).join("");
}

describe("GDPR deletion notice", () => {
  it("is identical in the API and the web app", () => {
    expect(evalWebNotice()).toBe(GDPR_DELETION_NOTICE);
  });

  it("states the same delays the sweeper enforces", () => {
    const HOUR = 3_600_000;
    expect(P2_RAW_DELAY_MS).toBe(24 * HOUR);
    expect(P2_PROCESSED_DELAY_MS).toBe(30 * 24 * HOUR);
    expect(P1_GRACE_MS).toBe(24 * HOUR);
    expect(GDPR_DELETION_NOTICE).toContain("24 hours after your order is delivered");
    expect(GDPR_DELETION_NOTICE).toContain("30 days after delivery");
    expect(GDPR_DELETION_NOTICE).toContain("24 hours after your preview expires");
  });
});
