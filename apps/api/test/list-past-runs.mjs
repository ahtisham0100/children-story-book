// Lists every session in the DB with signed, browser-openable links to the
// child's photo and each rendered book page — for pulling up past runs to show
// a client.
//
// Pages are discovered from storage by key convention
// (sessions/<id>/pages/<pageId>.png), so nothing extra is tracked in the DB.
//
// Usage: node test/list-past-runs.mjs [hoursValid]  (default 24h link expiry)

import { PrismaClient } from "@prisma/client";
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

dotenv.config();

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

const hoursValid = Number(process.argv[2] ?? "24");
const expiresIn = hoursValid * 3600;

async function linkFor(key) {
  if (!key) return null;
  try {
    return await getSignedUrl(r2, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
  } catch (error) {
    return `ERROR generating link: ${error.message}`;
  }
}

async function listPages(sessionId) {
  const prefix = `sessions/${sessionId}/pages/`;
  try {
    const result = await r2.send(new ListObjectsV2Command({ Bucket, Prefix: prefix }));
    return result.Contents?.map((o) => o.Key).filter(Boolean) ?? [];
  } catch {
    return [];
  }
}

async function main() {
  const sessions = await prisma.session.findMany({
    include: { characters: true },
    orderBy: { createdAt: "asc" },
  });

  if (sessions.length === 0) {
    console.log("No sessions found in the database.");
    return;
  }

  for (const session of sessions) {
    console.log("\n================================================================");
    console.log(`Session ${session.id}`);
    console.log(`  status: ${session.status}   book: ${session.storyId}   created: ${session.createdAt.toISOString()}`);

    for (const c of session.characters) {
      console.log(`\n  Child "${c.childName}" (slot: ${c.slot})`);
      console.log(`    photo: ${c.rawKey ? await linkFor(c.rawKey) : "— not uploaded —"}`);
    }

    const pageKeys = await listPages(session.id);
    if (pageKeys.length === 0) {
      console.log("\n  Pages: — none rendered —");
    } else {
      console.log("\n  Pages:");
      for (const key of pageKeys) {
        const id = key.split("/").pop()?.replace(/\.png$/, "");
        console.log(`    ${id}: ${await linkFor(key)}`);
      }
    }
  }

  console.log(`\n(Links valid for ${hoursValid}h from now.)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
