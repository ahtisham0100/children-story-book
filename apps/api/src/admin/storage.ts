import { listObjects, type StoredObject } from "../storage";
import { getCacheRedis } from "../redis";

/**
 * R2 usage by category for the admin dashboard, following the key layout in
 * the GDPR design spec:
 *   raw        sessions/<sid>/characters/...     (children's uploaded photos)
 *   processed  sessions/<sid>/pages/...          (rendered pages, previews)
 *   printPdf   orders/<oid>/items/<iid>/print.pdf
 *   other      everything else (scratch/ stage handoffs, stray keys)
 */
export type StorageCategory = "raw" | "processed" | "printPdf" | "other";
export const STORAGE_CATEGORIES: StorageCategory[] = ["raw", "processed", "printPdf", "other"];

export function categorize(key: string): StorageCategory {
  if (/^sessions\/[^/]+\/characters\//.test(key)) return "raw";
  if (/^sessions\/[^/]+\/pages\//.test(key)) return "processed";
  if (/^orders\/[^/]+\/items\/[^/]+\/print\.pdf$/.test(key)) return "printPdf";
  return "other";
}

export interface StorageTotals {
  count: number;
  bytes: number;
}

export interface StorageSummary {
  categories: Record<StorageCategory, StorageTotals>;
  total: StorageTotals;
  computedAt: string;
}

export function summarizeObjects(objects: StoredObject[], now = new Date()): StorageSummary {
  const categories = Object.fromEntries(STORAGE_CATEGORIES.map((c) => [c, { count: 0, bytes: 0 }])) as Record<
    StorageCategory,
    StorageTotals
  >;
  const total = { count: 0, bytes: 0 };
  for (const object of objects) {
    const bucket = categories[categorize(object.key)];
    bucket.count++;
    bucket.bytes += object.size;
    total.count++;
    total.bytes += object.size;
  }
  return { categories, total, computedAt: now.toISOString() };
}

const CACHE_KEY = "admin:storage-summary";
const CACHE_SECONDS = 600;

function warn(what: string, error: unknown) {
  console.warn(`[admin] storage summary cache ${what} failed:`, error instanceof Error ? error.message : String(error));
}

/**
 * Lists the WHOLE bucket, which gets slow as it grows, so the result is cached
 * in Redis for 10 minutes (computedAt tells the admin how old it is). Redis
 * being down only costs the cache: the summary is computed and returned anyway.
 */
export async function getStorageSummary(options: { refresh: boolean }): Promise<StorageSummary & { cached: boolean }> {
  if (!options.refresh) {
    try {
      const hit = await getCacheRedis().get(CACHE_KEY);
      if (hit) return { ...(JSON.parse(hit) as StorageSummary), cached: true };
    } catch (error) {
      warn("read", error);
    }
  }
  const summary = summarizeObjects(await listObjects(""));
  try {
    await getCacheRedis().set(CACHE_KEY, JSON.stringify(summary), "EX", CACHE_SECONDS);
  } catch (error) {
    warn("write", error);
  }
  return { ...summary, cached: false };
}
