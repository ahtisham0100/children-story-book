import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Falls back to a placeholder URL so the process can boot (e.g. to view /docs)
// before real credentials are configured; actual queries will fail clearly instead.
export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/unconfigured",
    },
  },
});
