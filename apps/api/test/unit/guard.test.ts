import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";

const getCustomerBySessionToken = vi.hoisted(() => vi.fn());
vi.mock("../../src/auth/service", () => ({ getCustomerBySessionToken }));

import { CUSTOMER_ROLE, requireAdmin, requireCustomer } from "../../src/auth/guard";
import { SESSION_COOKIE } from "../../src/auth/session";

function fakeRequest(cookie?: string) {
  return { cookies: cookie ? { [SESSION_COOKIE]: cookie } : {} } as unknown as FastifyRequest;
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    code(status: number) {
      reply.statusCode = status;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

const customer = { id: "c1", email: "parent@example.com", passwordHash: null, role: CUSTOMER_ROLE.customer };
const admin = { id: "a1", email: "staff@example.com", passwordHash: "hash", role: CUSTOMER_ROLE.admin };

beforeEach(() => getCustomerBySessionToken.mockReset());

describe("requireAdmin", () => {
  it("401s with no session cookie, without touching the database", async () => {
    const reply = fakeReply();
    expect(await requireAdmin(fakeRequest(), reply as unknown as FastifyReply)).toBeNull();
    expect(reply.statusCode).toBe(401);
    expect(getCustomerBySessionToken).not.toHaveBeenCalled();
  });

  it("401s with an invalid or expired cookie", async () => {
    getCustomerBySessionToken.mockResolvedValue(null);
    const reply = fakeReply();
    expect(await requireAdmin(fakeRequest("forged"), reply as unknown as FastifyReply)).toBeNull();
    expect(reply.statusCode).toBe(401);
  });

  it("403s a logged-in customer who isn't an admin", async () => {
    getCustomerBySessionToken.mockResolvedValue(customer);
    const reply = fakeReply();
    expect(await requireAdmin(fakeRequest("valid"), reply as unknown as FastifyReply)).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  it("403s any role string other than exactly 'admin'", async () => {
    getCustomerBySessionToken.mockResolvedValue({ ...customer, role: "Admin" });
    const reply = fakeReply();
    expect(await requireAdmin(fakeRequest("valid"), reply as unknown as FastifyReply)).toBeNull();
    expect(reply.statusCode).toBe(403);
  });

  it("returns the admin and sends nothing", async () => {
    getCustomerBySessionToken.mockResolvedValue(admin);
    const reply = fakeReply();
    expect(await requireAdmin(fakeRequest("valid"), reply as unknown as FastifyReply)).toEqual(admin);
    expect(reply.body).toBeUndefined();
  });
});

describe("requireCustomer (unchanged behaviour)", () => {
  it("lets any logged-in customer through, admin or not", async () => {
    getCustomerBySessionToken.mockResolvedValue(customer);
    const reply = fakeReply();
    expect(await requireCustomer(fakeRequest("valid"), reply as unknown as FastifyReply)).toEqual(customer);
  });
});
