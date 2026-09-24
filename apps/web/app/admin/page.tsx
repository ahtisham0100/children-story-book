"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin/queues");
  }, [router]);
  return <p className="page-lede">Opening the queue monitor…</p>;
}
