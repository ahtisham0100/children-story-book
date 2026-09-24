-- Admin role for Milestone 4's /admin. Every existing customer becomes a
-- plain "customer". Admins are granted only via `npm run make-admin -- <email>`.
ALTER TABLE "Customer" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'customer';
