"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { api, type TimeTrackingEntry } from "@/app/lib/api";

export function ActiveTimerBadge() {
  const [entry, setEntry] = useState<TimeTrackingEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const active = await api.activeTimeTracking();
        if (live) setEntry(active);
      } catch {
        if (live) setEntry(null);
      }
    };
    void refresh();
    const refreshId = window.setInterval(() => void refresh(), 15000);
    const clockId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      window.clearInterval(refreshId);
      window.clearInterval(clockId);
    };
  }, []);

  if (!entry) return null;
  const seconds = entry.status === "running" && entry.last_resumed_at
    ? entry.accumulated_seconds + Math.max(0, Math.floor((now - Date.parse(entry.last_resumed_at)) / 1000))
    : entry.elapsed_seconds;
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <Link href={`/time?focus=${encodeURIComponent(entry.intent_id)}`}
      className="fixed bottom-20 right-4 z-40 flex max-w-[min(85vw,360px)] items-center gap-2 rounded-xl border border-black/10 bg-surface px-3 py-2 text-sm text-fg shadow-lg lg:bottom-5 lg:right-6"
      aria-label={`Otwórz aktywny timer ${entry.title}`}>
      <Clock size={16} className="shrink-0" />
      <span className="min-w-0 truncate font-medium">{entry.title}</span>
      <span className="font-mono tabular-nums">{entry.status === "paused" ? "Pauza " : ""}{clock}</span>
    </Link>
  );
}
