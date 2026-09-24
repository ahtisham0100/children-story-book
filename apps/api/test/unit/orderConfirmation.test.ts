import { describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({ APP_BASE_URL: "https://books.example.com/", RESEND_FROM_ADDRESS: "orders@example.com" }));
vi.mock("../../src/env", () => ({ env: mockEnv }));

import { trackOrderUrl } from "../../src/email/orderConfirmation";

describe("trackOrderUrl", () => {
  it("builds an absolute URL on APP_BASE_URL without a double slash", () => {
    expect(trackOrderUrl("abc-123")).toBe("https://books.example.com/track/abc-123");
  });

  it("works when APP_BASE_URL has no trailing slash", () => {
    mockEnv.APP_BASE_URL = "http://localhost:3000";
    expect(trackOrderUrl("abc-123")).toBe("http://localhost:3000/track/abc-123");
  });
});
