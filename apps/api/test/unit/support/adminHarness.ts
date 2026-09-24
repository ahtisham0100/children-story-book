import { vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";

/**
 * Shared doubles for the admin API tests (test/unit/admin*.test.ts): an
 * in-memory Prisma covering exactly the query shapes the admin routes use,
 * fake BullMQ queues, and stubs for R2, Redis, Gelato and the GDPR primitives.
 *
 * Each test file wires it up with:
 *   const h = await vi.hoisted(async () => (await import("./support/adminHarness")).createAdminHarness());
 *   vi.mock("../../src/db", () => ({ prisma: h.prisma }));  ...and the other module mocks
 * (copy the block from adminQueues.test.ts: vi.mock calls are hoisted per file,
 * so they can't live in a shared helper).
 *
 * Auth is real (src/auth/guard.ts + the admin plugin's hooks); only the
 * session lookup is stubbed: cookie "admin-cookie" is an admin, "customer-cookie"
 * a plain customer, anything else nobody.
 */

type Row = Record<string, any>;

export const ADMIN = { id: "admin-1", email: "admin@example.com", role: "admin", passwordHash: null };
export const CUSTOMER = { id: "cust-1", email: "cust@example.com", role: "customer", passwordHash: null };
export const ADMIN_COOKIE = "cbp_session=admin-cookie";
export const CUSTOMER_COOKIE = "cbp_session=customer-cookie";
/** Headers for an admin mutation that passes the CSRF check. */
export const ADMIN_HEADERS = { cookie: ADMIN_COOKIE, "x-admin-request": "1" };

const isPlainCond = (v: unknown) =>
  v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);

function matchValue(value: any, cond: any): boolean {
  if (!isPlainCond(cond)) {
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  }
  return Object.entries(cond).every(([op, arg]: [string, any]) => {
    switch (op) {
      case "in":
        return arg.includes(value);
      case "notIn":
        return !arg.includes(value);
      case "not":
        return isPlainCond(arg) ? !matchValue(value, arg) : value !== arg;
      case "gte":
        return value != null && value >= arg;
      case "lte":
        return value != null && value <= arg;
      case "gt":
        return value != null && value > arg;
      case "lt":
        return value != null && value < arg;
      case "contains":
        return typeof value === "string" &&
          (cond.mode === "insensitive" ? value.toLowerCase().includes(String(arg).toLowerCase()) : value.includes(arg));
      case "startsWith":
        return typeof value === "string" && value.startsWith(arg);
      case "mode":
        return true;
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  });
}

export function createAdminHarness() {
  const db = {
    customers: [] as Row[],
    orders: [] as Row[],
    items: [] as Row[],
    events: [] as Row[],
    sessions: [] as Row[],
    deletionAudit: [] as Row[],
    adminLog: [] as Row[],
  };

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
      if (key === "items" && cond?.some) return db.items.some((i) => i.orderId === row.id && matches(i, cond.some));
      return matchValue(row[key], cond);
    });

  const project = (row: Row, args: Row) => {
    const out: Row = { ...row };
    if (args.include?.items) {
      out.items = db.items.filter((i) => i.orderId === row.id).map((i) => ({ ...i }));
    }
    if (args.include?.statusEvents) {
      out.statusEvents = db.events
        .filter((e) => e.orderId === row.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((e) => ({ ...e }));
    }
    if (args.select) {
      const picked: Row = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (k === "items") picked.items = db.items.filter((i) => i.orderId === row.id).map((i) => ({ id: i.id }));
        else picked[k] = row[k];
      }
      return picked;
    }
    return out;
  };

  const sortRows = (rows: Row[], orderBy?: Row | Row[]) => {
    const specs = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [key, dir] = Object.entries(spec)[0] as [string, "asc" | "desc"];
        const av = a[key] instanceof Date ? a[key].getTime() : a[key];
        const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
      }
      return 0;
    });
  };

  let seq = 0;
  const table = (rows: () => Row[], defaults: () => Row = () => ({})) => ({
    findMany: vi.fn(async (args: Row = {}) => {
      let hit = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy);
      if (args.skip) hit = hit.slice(args.skip);
      if (args.take !== undefined) hit = hit.slice(0, args.take);
      return hit.map((r) => project(r, args));
    }),
    count: vi.fn(async (args: Row = {}) => rows().filter((r) => matches(r, args.where)).length),
    findUnique: vi.fn(async (args: Row) => {
      const r = rows().find((x) => matches(x, args.where));
      return r ? project(r, args) : null;
    }),
    findFirst: vi.fn(async (args: Row = {}) => {
      const r = sortRows(rows().filter((x) => matches(x, args.where)), args.orderBy)[0];
      return r ? project(r, args) : null;
    }),
    update: vi.fn(async ({ where, data }: Row) => {
      const r = rows().find((x) => matches(x, where));
      if (!r) throw new Error("fake prisma: record not found");
      return Object.assign(r, data);
    }),
    updateMany: vi.fn(async ({ where, data }: Row) => {
      const hit = rows().filter((x) => matches(x, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    create: vi.fn(async ({ data }: Row) => {
      const row = { id: `gen-${++seq}`, createdAt: new Date(Date.now() + seq), ...defaults(), ...data };
      rows().push(row);
      return { ...row };
    }),
  });

  const prisma: Row = {
    customer: table(() => db.customers),
    order: table(() => db.orders),
    orderItem: table(() => db.items),
    orderStatusEvent: table(() => db.events),
    session: table(() => db.sessions),
    deletionAuditLog: table(() => db.deletionAudit, () => ({ force: false })),
    adminActionLog: table(() => db.adminLog),
  };
  prisma.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === "function" ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );

  const env: Row = {
    CORS_ORIGIN: ["http://localhost:3000"],
    REDIS_URL: "redis://fake",
    STAGE_EXECUTION: "direct",
    GELATO_API_KEY: "gelato-key",
    GDPR_DELETION_DRY_RUN: true,
    RL_ADMIN_IP_MAX: 1000,
    RL_ADMIN_WINDOW_MIN: 10,
    RL_ADMIN_MUTATION_IP_MAX: 1000,
    AUTH_SESSION_TTL_DAYS: 30,
    AUTH_COOKIE_SECURE: false,
    AUTH_COOKIE_SAMESITE: "lax",
    AUTH_COOKIE_DOMAIN: undefined,
  };

  // --- BullMQ doubles --------------------------------------------------
  type State = "active" | "waiting" | "delayed" | "completed" | "failed";
  const makeJob = (fields: Row & { id: string; state: State }) => {
    const job: Row = {
      name: "job",
      data: {},
      opts: { attempts: 1 },
      timestamp: Date.now(),
      processedOn: null,
      finishedOn: null,
      attemptsMade: 0,
      failedReason: undefined,
      stacktrace: [],
      returnvalue: null,
      ...fields,
    };
    job.getState = vi.fn(async () => job.state);
    job.isFailed = vi.fn(async () => job.state === "failed");
    job.isCompleted = vi.fn(async () => job.state === "completed");
    job.retry = vi.fn(async () => {
      if (job.state !== "failed") throw new Error("not failed");
      job.state = "waiting";
    });
    job.remove = vi.fn(async () => {
      queueJobs(job.queueName).splice(queueJobs(job.queueName).indexOf(job), 1);
    });
    return job;
  };
  const jobsByQueue = new Map<string, Row[]>();
  const queueJobs = (name: string) => {
    if (!jobsByQueue.has(name)) jobsByQueue.set(name, []);
    return jobsByQueue.get(name)!;
  };
  const makeQueue = (name: string) => ({
    name,
    getJobCounts: vi.fn(async (...types: State[]) =>
      Object.fromEntries(types.map((t) => [t, queueJobs(name).filter((j) => j.state === t).length])),
    ),
    getJobCountByTypes: vi.fn(async (...types: State[]) => queueJobs(name).filter((j) => types.includes(j.state)).length),
    getJobs: vi.fn(async (types: State[] | State, start = 0, end = -1) => {
      const list = queueJobs(name).filter((j) => [types].flat().includes(j.state));
      return list.slice(start, end < 0 ? undefined : end + 1);
    }),
    getJob: vi.fn(async (id: string) => queueJobs(name).find((j) => j.id === id)),
    add: vi.fn(async (jobName: string, data: Row, opts: Row = {}) => {
      const job = makeJob({ id: opts.jobId ?? `${name}-${++seq}`, state: "waiting", name: jobName, data, opts, queueName: name });
      queueJobs(name).push(job);
      return job;
    }),
  });
  const queues = new Map<string, ReturnType<typeof makeQueue>>();
  const queue = (name: string) => {
    if (!queues.has(name)) queues.set(name, makeQueue(name));
    return queues.get(name)!;
  };
  const addJob = (queueName: string, fields: Row & { id: string; state: State }) => {
    const job = makeJob({ ...fields, queueName });
    queueJobs(queueName).push(job);
    return job;
  };

  // --- Other collaborators ------------------------------------------------
  const deleteSessionAssets = vi.fn(async (sessionId: string, opts: Row) => ({
    sessionId,
    scope: opts.scope,
    fileCount: opts.dryRun ? 7 : 5,
    dryRun: opts.dryRun,
  }));
  const findCandidates = vi.fn(async (_kind: string, _q: Row): Promise<string[]> => []);
  const loadScheduleInput = vi.fn(async (_id: string): Promise<Row | null> => null);
  // Batched variant, built on the per-session stub so tests configure one thing.
  const loadScheduleInputs = vi.fn(async (ids: string[]) => {
    const map = new Map<string, Row>();
    for (const id of ids) {
      const input = await loadScheduleInput(id);
      if (input) map.set(id, input);
    }
    return map;
  });
  const listObjects = vi.fn(async (_prefix: string): Promise<{ key: string; size: number; lastModified: Date | null }[]> => []);
  const getGelatoOrder = vi.fn(async (_id: string) => ({ status: "shipped" }));
  const redisStore = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      redisStore.set(key, value);
      return "OK";
    }),
  };
  const enqueueFulfillment = vi.fn(async (orderId: string) =>
    queue("fulfillment").add("fulfill", { orderId }, { jobId: orderId }),
  );

  const getCustomerBySessionToken = async (raw: string) =>
    raw === "admin-cookie" ? { ...ADMIN } : raw === "customer-cookie" ? { ...CUSTOMER } : null;

  function reset() {
    // Call history AND per-test implementations (mockResolvedValueOnce,
    // mockImplementation) back to the originals above.
    vi.resetAllMocks();
    for (const key of Object.keys(db) as (keyof typeof db)[]) db[key].length = 0;
    jobsByQueue.clear();
    queues.clear();
    redisStore.clear();
    seq = 0;
    env.REDIS_URL = "redis://fake";
    env.STAGE_EXECUTION = "direct";
    env.GELATO_API_KEY = "gelato-key";
    env.GDPR_DELETION_DRY_RUN = true;
  }

  return {
    db,
    prisma,
    env,
    queue,
    addJob,
    deleteSessionAssets,
    findCandidates,
    loadScheduleInput,
    loadScheduleInputs,
    listObjects,
    getGelatoOrder,
    redis,
    enqueueFulfillment,
    getCustomerBySessionToken,
    reset,
  };
}

export type AdminHarness = ReturnType<typeof createAdminHarness>;

/** A Fastify app with just what the admin plugin needs (cookies + rate-limit decorator). */
export async function buildAdminTestApp(register: (app: any) => Promise<void>) {
  const app = Fastify();
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(register);
  await app.ready();
  return app;
}
