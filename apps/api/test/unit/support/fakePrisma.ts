import { randomUUID } from "node:crypto";

// A tiny in-memory stand-in for the exact PrismaClient methods the auth service
// calls. It lets the REAL service code (service.ts) run its flows —
// issue/consume/single-use/expiry, sessions, RLS scoping — with no Postgres, so
// the logic is verified behaviourally, not just type-checked. It implements only
// the query shapes service.ts actually uses; it is not a general Prisma mock.

interface CustomerRow {
  id: string;
  email: string;
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface AuthTokenRow {
  id: string;
  customerId: string;
  tokenHash: string;
  purpose: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}
interface SessionRow {
  id: string;
  customerId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface FakePrisma {
  customer: {
    upsert(args: { where: { email: string }; update: object; create: { email: string } }): Promise<CustomerRow>;
    findUnique(args: { where: { email?: string; id?: string } }): Promise<CustomerRow | null>;
    update(args: { where: { id: string }; data: Partial<CustomerRow> }): Promise<CustomerRow>;
  };
  authToken: {
    create(args: { data: Omit<AuthTokenRow, "id" | "createdAt" | "consumedAt"> & { consumedAt?: Date | null } }): Promise<AuthTokenRow>;
    findUnique(args: { where: { tokenHash: string } }): Promise<AuthTokenRow | null>;
    updateMany(args: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }): Promise<{ count: number }>;
  };
  customerSession: {
    create(args: { data: Omit<SessionRow, "id" | "createdAt"> }): Promise<SessionRow>;
    findUnique(args: { where: { tokenHash: string }; include?: { customer: true } }): Promise<(SessionRow & { customer: CustomerRow }) | null>;
    delete(args: { where: { id: string } }): Promise<SessionRow>;
    deleteMany(args: { where: { tokenHash: string } }): Promise<{ count: number }>;
  };
  __reset(): void;
}

export function createFakePrisma(): FakePrisma {
  let customers: CustomerRow[] = [];
  let tokens: AuthTokenRow[] = [];
  let sessions: SessionRow[] = [];

  return {
    customer: {
      async upsert({ where, create }) {
        const existing = customers.find((c) => c.email === where.email);
        if (existing) return existing;
        const row: CustomerRow = {
          id: randomUUID(),
          email: create.email,
          passwordHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        customers.push(row);
        return row;
      },
      async findUnique({ where }) {
        return (
          customers.find((c) =>
            where.email !== undefined ? c.email === where.email : c.id === where.id,
          ) ?? null
        );
      },
      async update({ where, data }) {
        const row = customers.find((c) => c.id === where.id);
        if (!row) throw new Error("customer not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    authToken: {
      async create({ data }) {
        const row: AuthTokenRow = {
          id: randomUUID(),
          customerId: data.customerId,
          tokenHash: data.tokenHash,
          purpose: data.purpose,
          expiresAt: data.expiresAt,
          consumedAt: data.consumedAt ?? null,
          createdAt: new Date(),
        };
        tokens.push(row);
        return row;
      },
      async findUnique({ where }) {
        return tokens.find((t) => t.tokenHash === where.tokenHash) ?? null;
      },
      async updateMany({ where, data }) {
        const row = tokens.find((t) => t.id === where.id && t.consumedAt === null);
        if (!row) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      },
    },
    customerSession: {
      async create({ data }) {
        const row: SessionRow = {
          id: randomUUID(),
          customerId: data.customerId,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
        };
        sessions.push(row);
        return row;
      },
      async findUnique({ where, include }) {
        const row = sessions.find((s) => s.tokenHash === where.tokenHash);
        if (!row) return null;
        if (!include?.customer) return row as SessionRow & { customer: CustomerRow };
        const customer = customers.find((c) => c.id === row.customerId)!;
        return { ...row, customer };
      },
      async delete({ where }) {
        const idx = sessions.findIndex((s) => s.id === where.id);
        const [row] = sessions.splice(idx, 1);
        return row!;
      },
      async deleteMany({ where }) {
        const before = sessions.length;
        sessions = sessions.filter((s) => s.tokenHash !== where.tokenHash);
        return { count: before - sessions.length };
      },
    },
    __reset() {
      customers = [];
      tokens = [];
      sessions = [];
    },
  };
}
