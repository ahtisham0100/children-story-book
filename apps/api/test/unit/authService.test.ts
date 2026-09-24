import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the Prisma singleton with the in-memory fake BEFORE importing the
// service, so the real service code runs its flows against it.
vi.mock("../../src/db", async () => {
  const { createFakePrisma } = await import("./support/fakePrisma");
  return { prisma: createFakePrisma() };
});

import { prisma } from "../../src/db";
import type { FakePrisma } from "./support/fakePrisma";
import { hashToken } from "../../src/auth/tokens";
import {
  consumeToken,
  createSession,
  destroySession,
  findCustomerByEmail,
  findOrCreateCustomerByEmail,
  getCustomerBySessionToken,
  issueToken,
  setCustomerPassword,
  verifyCredentials,
} from "../../src/auth/service";

const db = prisma as unknown as FakePrisma;

beforeEach(() => db.__reset());

describe("silent account creation", () => {
  it("creates an account on first checkout and is idempotent by email", async () => {
    const a = await findOrCreateCustomerByEmail("Parent@Example.com");
    const b = await findOrCreateCustomerByEmail("parent@example.com "); // different case/space
    expect(a.id).toBe(b.id); // same account, not a duplicate
    expect(a.email).toBe("parent@example.com"); // normalized
    expect(a.passwordHash).toBeNull(); // no password until they activate
  });

  it("re-running it never clobbers a password already set", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    await setCustomerPassword(c.id, "Sunflower22");
    const again = await findOrCreateCustomerByEmail("p@example.com");
    expect(again.passwordHash).not.toBeNull();
  });
});

describe("single-use, time-limited tokens", () => {
  it("consumes a valid token once, then never again", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    const raw = await issueToken(c.id, "activation");

    const first = await consumeToken(raw, ["activation"]);
    expect(first?.id).toBe(c.id);

    const second = await consumeToken(raw, ["activation"]);
    expect(second).toBeNull(); // single-use enforced
  });

  it("rejects a token used for the wrong purpose", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    const raw = await issueToken(c.id, "magic_link");
    // A magic-link token must not be accepted where a reset/activation is expected.
    expect(await consumeToken(raw, ["activation", "password_reset"])).toBeNull();
  });

  it("rejects an expired token", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    const raw = "expired-raw-token";
    await db.authToken.create({
      data: {
        customerId: c.id,
        tokenHash: hashToken(raw),
        purpose: "password_reset",
        expiresAt: new Date(Date.now() - 1000), // already in the past
      },
    });
    expect(await consumeToken(raw, ["password_reset"])).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await consumeToken("never-issued", ["activation"])).toBeNull();
  });
});

describe("password login", () => {
  it("verifies correct credentials and rejects wrong ones", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    await setCustomerPassword(c.id, "Sunflower22");

    expect((await verifyCredentials("P@example.com", "Sunflower22"))?.id).toBe(c.id);
    expect(await verifyCredentials("p@example.com", "wrong")).toBeNull();
  });

  it("returns null for a magic-link-only account with no password", async () => {
    await findOrCreateCustomerByEmail("nopass@example.com");
    expect(await verifyCredentials("nopass@example.com", "anything")).toBeNull();
  });
});

describe("browser sessions", () => {
  it("resolves a live session cookie to its customer", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    const cookie = await createSession(c.id);
    expect((await getCustomerBySessionToken(cookie))?.id).toBe(c.id);
  });

  it("stops resolving after logout", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    const cookie = await createSession(c.id);
    await destroySession(cookie);
    expect(await getCustomerBySessionToken(cookie)).toBeNull();
  });

  it("rejects an expired session and cleans it up", async () => {
    const c = await findOrCreateCustomerByEmail("p@example.com");
    const cookie = "expired-session";
    await db.customerSession.create({
      data: { customerId: c.id, tokenHash: hashToken(cookie), expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getCustomerBySessionToken(cookie)).toBeNull();
  });

  it("rejects a forged/unknown cookie", async () => {
    expect(await getCustomerBySessionToken("forged")).toBeNull();
  });
});

describe("email lookup", () => {
  it("finds by normalized email and returns null for unknown", async () => {
    await findOrCreateCustomerByEmail("Known@Example.com");
    expect((await findCustomerByEmail("known@example.com"))?.email).toBe("known@example.com");
    expect(await findCustomerByEmail("unknown@example.com")).toBeNull();
  });
});
