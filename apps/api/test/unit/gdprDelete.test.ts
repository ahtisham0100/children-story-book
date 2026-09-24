import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins for exactly what deleteSessionAssets touches: a fake R2
// bucket (a Set of keys) and the handful of Prisma calls it makes.
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    bucket: new Set<string>(),
    session: null as Row | null,
    characters: [] as Row[],
    items: [] as Row[],
    audit: [] as Row[],
    failTransaction: false,
  };

  const prisma = {
    session: {
      findUnique: vi.fn(async () =>
        state.session ? { ...state.session, characters: state.characters.map((c) => ({ ...c })) } : null,
      ),
      update: vi.fn(async ({ data }: { data: Row }) => Object.assign(state.session!, data)),
    },
    character: {
      updateMany: vi.fn(async ({ data }: { data: Row }) => {
        state.characters.forEach((c) => Object.assign(c, data));
        return { count: state.characters.length };
      }),
    },
    orderItem: {
      findMany: vi.fn(async () => state.items.map((i) => ({ ...i }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) =>
        Object.assign(state.items.find((i) => i.id === where.id)!, data),
      ),
    },
    deletionAuditLog: { create: vi.fn(async ({ data }: { data: Row }) => state.audit.push(data)) },
    // Interactive transaction: the callback gets the same client. A failing
    // transaction throws before running, so nothing inside it is applied.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (state.failTransaction) throw new Error("db unavailable");
      return fn(prisma);
    }),
  };

  const storage = {
    listObjectKeys: vi.fn(async (prefix: string) => [...state.bucket].filter((k) => k.startsWith(prefix))),
    objectExists: vi.fn(async (key: string) => state.bucket.has(key)),
    deleteObjects: vi.fn(async (keys: string[]) => {
      keys.forEach((k) => state.bucket.delete(k));
      return { deleted: keys, errors: [] as { key: string; message: string }[] };
    }),
  };

  return { state, prisma, storage };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/storage", () => h.storage);

import { deleteSessionAssets } from "../../src/gdpr/deleteSessionAssets";

const SID = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const OID = "33333333-3333-4333-8333-333333333333";
const IID = "44444444-4444-4444-8444-444444444444";

const RAW_JPG = `sessions/${SID}/characters/${CID}/raw.jpg`;
const RAW_PNG = `sessions/${SID}/characters/${CID}/raw.png`; // an orphan: issued, never confirmed
const PAGE_1 = `sessions/${SID}/pages/p1.png`;
const PAGE_2 = `sessions/${SID}/pages/p2.png`;
const PDF = `orders/${OID}/items/${IID}/print.pdf`;
const OTHER_SESSION_RAW = `sessions/99999999-9999-4999-8999-999999999999/characters/x/raw.jpg`;
const OTHER_ORDER_PDF = `orders/88888888-8888-4888-8888-888888888888/items/y/print.pdf`;

const SYSTEM = { trigger: "auto_p1", actor: "system", dryRun: false } as const;

function seed() {
  h.state.bucket = new Set([RAW_JPG, RAW_PNG, PAGE_1, PAGE_2, PDF, OTHER_SESSION_RAW, OTHER_ORDER_PDF]);
  h.state.session = { id: SID, previewKey: PAGE_1, rawDeletedAt: null, processedDeletedAt: null };
  h.state.characters = [{ id: CID, sessionId: SID, slot: "child_1", childName: "Ada", rawKey: RAW_JPG }];
  h.state.items = [
    {
      id: IID,
      orderId: OID,
      sessionId: SID,
      configSnapshot: [{ slot: "child_1", childName: "Ada", rawKey: RAW_JPG }],
      printPageKeys: [PAGE_1, PAGE_2],
      printPdfKey: PDF,
    },
  ];
  h.state.audit = [];
  h.state.failTransaction = false;
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("scope: raw", () => {
  it("deletes every raw object (incl. unconfirmed extensions), nulls the raw keys, sets the marker", async () => {
    const result = await deleteSessionAssets(SID, { scope: "raw", ...SYSTEM });

    expect(result.fileCount).toBe(2);
    expect(h.state.bucket.has(RAW_JPG)).toBe(false);
    expect(h.state.bucket.has(RAW_PNG)).toBe(false);
    // Processed files and other sessions untouched.
    expect(h.state.bucket.has(PAGE_1)).toBe(true);
    expect(h.state.bucket.has(PDF)).toBe(true);
    expect(h.state.bucket.has(OTHER_SESSION_RAW)).toBe(true);

    expect(h.state.characters[0]!.rawKey).toBeNull();
    expect(h.state.items[0]!.configSnapshot).toEqual([{ slot: "child_1", childName: "Ada", rawKey: null }]);
    expect(h.state.session!.rawDeletedAt).toBeInstanceOf(Date);
    expect(h.state.session!.processedDeletedAt).toBeNull();
    expect(h.state.session!.previewKey).toBe(PAGE_1);
    expect(h.state.items[0]!.printPdfKey).toBe(PDF);
  });
});

describe("scope: processed", () => {
  it("deletes pages AND the print PDF stored under the order prefix, nulls those keys", async () => {
    const result = await deleteSessionAssets(SID, { scope: "processed", ...SYSTEM, trigger: "auto_p2_processed" });

    expect(result.fileCount).toBe(3);
    expect(h.state.bucket.has(PAGE_1)).toBe(false);
    expect(h.state.bucket.has(PAGE_2)).toBe(false);
    expect(h.state.bucket.has(PDF)).toBe(false);
    expect(h.state.bucket.has(RAW_JPG)).toBe(true);
    expect(h.state.bucket.has(OTHER_ORDER_PDF)).toBe(true);

    expect(h.state.session!.previewKey).toBeNull();
    expect(h.state.items[0]!.printPdfKey).toBeNull();
    expect(h.state.session!.processedDeletedAt).toBeInstanceOf(Date);
    expect(h.state.session!.rawDeletedAt).toBeNull();
    expect(h.state.characters[0]!.rawKey).toBe(RAW_JPG);
  });
});

describe("scope: all", () => {
  it("deletes everything for the session and nothing else", async () => {
    const result = await deleteSessionAssets(SID, { scope: "all", trigger: "user", actor: "cust-1", dryRun: false });
    expect(result.fileCount).toBe(5);
    expect([...h.state.bucket].sort()).toEqual([OTHER_ORDER_PDF, OTHER_SESSION_RAW].sort());
    expect(h.state.session!.rawDeletedAt).toBeInstanceOf(Date);
    expect(h.state.session!.processedDeletedAt).toBeInstanceOf(Date);
  });
});

describe("audit log", () => {
  it("writes exactly one row per successful call, with no personal data", async () => {
    await deleteSessionAssets(SID, { scope: "raw", ...SYSTEM });
    expect(h.state.audit).toHaveLength(1);
    const row = h.state.audit[0]!;
    expect(row).toMatchObject({
      trigger: "auto_p1",
      scope: "raw",
      sessionId: SID,
      fileCount: 2,
      actor: "system",
      dryRun: false,
      outcome: "succeeded",
    });
    expect(Object.keys(row).sort()).toEqual(
      ["actor", "dryRun", "error", "fileCount", "force", "outcome", "scope", "sessionId", "trigger"].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("Ada");
    expect(JSON.stringify(row)).not.toContain("raw.jpg");
  });
});

describe("dry run", () => {
  it("deletes nothing, changes no DB rows, and still writes one audit row with the would-be count", async () => {
    const before = [...h.state.bucket];
    const result = await deleteSessionAssets(SID, { scope: "all", ...SYSTEM, dryRun: true });

    expect(result).toMatchObject({ fileCount: 5, dryRun: true });
    expect([...h.state.bucket]).toEqual(before);
    expect(h.storage.deleteObjects).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.state.characters[0]!.rawKey).toBe(RAW_JPG);
    expect(h.state.session!.rawDeletedAt).toBeNull();
    expect(h.state.audit).toHaveLength(1);
    expect(h.state.audit[0]).toMatchObject({ dryRun: true, fileCount: 5, outcome: "succeeded" });
  });
});

describe("idempotency", () => {
  it("re-running on an already-deleted session is a successful no-op (and keeps the first timestamp)", async () => {
    await deleteSessionAssets(SID, { scope: "raw", ...SYSTEM });
    const firstMarker = h.state.session!.rawDeletedAt;

    const again = await deleteSessionAssets(SID, { scope: "raw", ...SYSTEM });
    expect(again.fileCount).toBe(0);
    expect(h.state.session!.rawDeletedAt).toBe(firstMarker);
    expect(h.state.audit).toHaveLength(2);
    expect(h.state.audit[1]).toMatchObject({ fileCount: 0, outcome: "succeeded" });
  });

  it("succeeds for a session row that no longer exists (prefix listing only)", async () => {
    h.state.session = null;
    h.state.characters = [];
    h.state.items = [];
    const result = await deleteSessionAssets(SID, { scope: "all", trigger: "user", actor: "cust-1", dryRun: false });
    expect(result.fileCount).toBe(4); // raw x2 + pages x2; the PDF is only reachable through the order item
    expect(h.state.bucket.has(RAW_JPG)).toBe(false);
    expect(h.state.audit).toHaveLength(1);
  });
});

describe("failures never mark anything deleted that isn't", () => {
  it("a partial R2 failure leaves markers and keys set, and audits the failure once", async () => {
    h.storage.deleteObjects.mockImplementationOnce(async (keys: string[]) => {
      // First key deleted, second rejected by R2.
      h.state.bucket.delete(keys[0]!);
      return { deleted: [keys[0]!], errors: [{ key: keys[1]!, message: "InternalError" }] };
    });

    await expect(deleteSessionAssets(SID, { scope: "raw", ...SYSTEM })).rejects.toThrow(/R2/);

    expect(h.state.session!.rawDeletedAt).toBeNull();
    expect(h.state.characters[0]!.rawKey).toBe(RAW_JPG);
    expect(h.state.audit).toHaveLength(1);
    expect(h.state.audit[0]).toMatchObject({ outcome: "failed", fileCount: 1, dryRun: false });
  });

  it("a thrown R2 error leaves markers unset", async () => {
    h.storage.deleteObjects.mockRejectedValueOnce(new Error("network down"));
    await expect(deleteSessionAssets(SID, { scope: "processed", ...SYSTEM })).rejects.toThrow();
    expect(h.state.session!.processedDeletedAt).toBeNull();
    expect(h.state.session!.previewKey).toBe(PAGE_1);
    expect(h.state.audit).toEqual([expect.objectContaining({ outcome: "failed", fileCount: 0 })]);
  });

  it("objects still present after the delete (e.g. a concurrent upload) count as a failure", async () => {
    h.storage.deleteObjects.mockImplementationOnce(async (keys: string[]) => {
      keys.forEach((k) => h.state.bucket.delete(k));
      h.state.bucket.add(`sessions/${SID}/characters/${CID}/raw.webp`);
      return { deleted: keys, errors: [] };
    });
    await expect(deleteSessionAssets(SID, { scope: "raw", ...SYSTEM })).rejects.toThrow(/still present/);
    expect(h.state.session!.rawDeletedAt).toBeNull();
    expect(h.state.audit).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("a DB failure after R2 succeeded leaves markers unset; the next run completes with 0 files", async () => {
    h.state.failTransaction = true;
    await expect(deleteSessionAssets(SID, { scope: "raw", ...SYSTEM })).rejects.toThrow(/db unavailable/);
    expect(h.state.bucket.has(RAW_JPG)).toBe(false);
    expect(h.state.session!.rawDeletedAt).toBeNull();
    expect(h.state.audit).toEqual([expect.objectContaining({ outcome: "failed", fileCount: 2 })]);

    h.state.failTransaction = false;
    const retry = await deleteSessionAssets(SID, { scope: "raw", ...SYSTEM });
    expect(retry.fileCount).toBe(0);
    expect(h.state.session!.rawDeletedAt).toBeInstanceOf(Date);
    expect(h.state.characters[0]!.rawKey).toBeNull();
  });
});

describe("safety", () => {
  it("refuses a DB key outside this session's own prefixes, deleting nothing", async () => {
    h.state.characters[0]!.rawKey = OTHER_SESSION_RAW;
    await expect(deleteSessionAssets(SID, { scope: "raw", ...SYSTEM })).rejects.toThrow(/outside/);
    expect(h.storage.deleteObjects).not.toHaveBeenCalled();
    expect(h.state.bucket.has(OTHER_SESSION_RAW)).toBe(true);
    expect(h.state.audit).toEqual([expect.objectContaining({ outcome: "failed", fileCount: 0 })]);
  });

  it.each(["", "a/b", "../x", " "])("refuses the malformed session id %j before touching R2", async (bad) => {
    await expect(deleteSessionAssets(bad, { scope: "all", ...SYSTEM })).rejects.toThrow(/session id/);
    expect(h.storage.listObjectKeys).not.toHaveBeenCalled();
    expect(h.storage.deleteObjects).not.toHaveBeenCalled();
    expect(h.state.audit).toHaveLength(1);
    expect(h.state.audit[0]).toMatchObject({ outcome: "failed", sessionId: null });
  });
});
