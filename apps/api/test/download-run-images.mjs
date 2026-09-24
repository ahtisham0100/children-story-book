// Downloads everything for one session (each child's photo + every rendered book
// page) to a local folder, for building an offline client-facing showcase.
//
// Usage: node test/download-run-images.mjs <sessionId> <destDir>

import { PrismaClient } from "@prisma/client";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const [sessionId, destDir] = process.argv.slice(2);
if (!sessionId || !destDir) {
  console.error("Usage: node test/download-run-images.mjs <sessionId> <destDir>");
  process.exit(1);
}

const prisma = new PrismaClient();
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});
const Bucket = process.env.R2_BUCKET_NAME;

async function download(key, destPath) {
  const result = await r2.send(new GetObjectCommand({ Bucket, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  await writeFile(destPath, Buffer.concat(chunks));
  console.log(`  ${key} -> ${destPath}`);
}

async function main() {
  await mkdir(destDir, { recursive: true });

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { characters: true },
  });
  if (!session) throw new Error(`Session ${sessionId} not found`);

  for (const c of session.characters) {
    if (c.rawKey) await download(c.rawKey, path.join(destDir, `${c.slot}-photo.jpg`));
  }

  // Pages are discovered by key convention rather than tracked in the DB.
  const prefix = `sessions/${sessionId}/pages/`;
  const listed = await r2.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }));
  const pageKeys = listed.Contents?.map((o) => o.Key).filter(Boolean) ?? [];
  if (pageKeys.length === 0) console.log("  (no rendered pages found)");
  for (const key of pageKeys) {
    const name = key.split("/").pop();
    await download(key, path.join(destDir, `page-${name}`));
  }

  console.log("Done.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
