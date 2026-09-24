import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

export function rawObjectKey(sessionId: string, characterId: string, contentType: string): string {
  const extension = CONTENT_TYPE_EXTENSIONS[contentType];
  return `sessions/${sessionId}/characters/${characterId}/raw.${extension}`;
}

/**
 * True only for a key this server itself would have issued for exactly this
 * session + character (one of the allowed image extensions). upload-confirm
 * checks this before saving rawKey: the worker later signs a download URL for
 * that key and hands it to Replicate, so accepting a client-chosen key would
 * let a caller make us process any object in the bucket. Exact equality against
 * the issued keys — no parsing, so no traversal/prefix/suffix tricks apply.
 */
export function isIssuedRawObjectKey(sessionId: string, characterId: string, key: string): boolean {
  return Object.keys(CONTENT_TYPE_EXTENSIONS).some(
    (contentType) => rawObjectKey(sessionId, characterId, contentType) === key,
  );
}

export async function createUploadUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 60,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: expiresInSeconds });
}

export async function createDownloadUrl(key: string, expiresInSeconds = 300): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key });
  return getSignedUrl(r2, command, { expiresIn: expiresInSeconds });
}

// Server-side (non-presigned) read/write, for the pipeline worker.
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2.send(
    new PutObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key, Body: body, ContentType: contentType }),
  );
}

// Used to skip work that's already done: a retried job (or a re-run of the same
// session) shouldn't pay for face swaps that already produced a page.
export async function objectExists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string })?.name === "NotFound") {
      return false;
    }
    throw error;
  }
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const result = await r2.send(new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));
  const stream = result.Body as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// --- GDPR deletion (src/gdpr/) -----------------------------------------

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

/**
 * Every object under `prefix` with its size, following ListObjectsV2
 * pagination to the end. "" lists the whole bucket (the admin storage
 * summary, which caches the result because of that).
 */
export async function listObjects(prefix: string): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await r2.send(
      new ListObjectsV2Command({ Bucket: env.R2_BUCKET_NAME, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0, lastModified: object.LastModified ?? null });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/** Every key under `prefix`, following ListObjectsV2 pagination to the end. */
export async function listObjectKeys(prefix: string): Promise<string[]> {
  return (await listObjects(prefix)).map((object) => object.key);
}

// DeleteObjects accepts at most 1000 keys per request.
const DELETE_BATCH_SIZE = 1000;

export interface DeleteObjectsResult {
  deleted: string[];
  /** Keys R2 refused to delete. A non-empty list means the deletion is NOT complete. */
  errors: { key: string; message: string }[];
}

/**
 * Deletes `keys` in batches. DeleteObjects answers 200 even when individual
 * keys fail, reporting them in `Errors`, so those are returned rather than
 * swallowed. Deleting a key that doesn't exist counts as success (S3 semantics).
 * A request-level failure throws; batches already sent stay deleted.
 */
export async function deleteObjects(keys: string[]): Promise<DeleteObjectsResult> {
  const result: DeleteObjectsResult = { deleted: [], errors: [] };
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
    const response = await r2.send(
      new DeleteObjectsCommand({
        Bucket: env.R2_BUCKET_NAME,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    const failed = new Set<string>();
    for (const error of response.Errors ?? []) {
      if (!error.Key) continue;
      failed.add(error.Key);
      result.errors.push({ key: error.Key, message: `${error.Code ?? "Error"}: ${error.Message ?? ""}`.trim() });
    }
    result.deleted.push(...batch.filter((key) => !failed.has(key)));
  }
  return result;
}
