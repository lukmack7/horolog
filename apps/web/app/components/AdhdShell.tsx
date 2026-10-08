"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { CalendarDays, ClipboardList, Clock3, Pause, Play, Plus, Settings2, Square } from "lucide-react";
import { api, type TimeTrackingEntry } from "@/app/lib/api";

const NAV = [
  { href: "/time", label: "Teraz", icon: Clock3 },
  { href: "/daily", label: "Dzisiaj", icon: CalendarDays },
  { href: "/todo", label: "Do zrobienia", icon: ClipboardList },
  { href: "/settings", label: "Ustawienia", icon: Settings2 },
] as const;

function elapsed(entry: TimeTrackingEntry, now: number): number {
  if (entry.status !== "running" || !entry.last_resumed_at) return entry.elapsed_seconds;
  return entry.accumulated_seconds + Math.max(0, Math.floor((now - Date.parse(entry.last_resumed_at)) / 1000));
}

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function AdhdShell({
  children,
  onPlanChange,
}: {
  children: React.ReactNode;
  onPlanChange?: () => void;
}) {
  const pathname = usePathname();
  const [active, setActive] = useState<TimeTrackingEntry | null>(null);
  const [capture, setCapture] = useState("");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const refreshTimer = useCallback(async () => {
    try {
      setActive(await api.activeTimeTracking());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się odczytać timera.");
    }
  }, []);

  useEffect(() => {
    void refreshTimer();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void refreshTimer(), 15000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [refreshTimer]);

  async function submitCapture(event: FormEvent) {
    event.preventDefault();
    if (!capture.trim()) return;
    setPending(true);
    setError(null);
    try {
      await api.createTodo({ title: capture.trim(), minutes: 30 });
      setCapture("");
      onPlanChange?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się zapisać.");
    } finally {
      setPending(false);
    }
  }

  async function timerAction(action: "pause" | "resume" | "stop") {
    if (!active) return;
    setError(null);
    try {
      if (action === "pause") await api.pauseTimeTracking(active.intent_id);
      if (action === "resume") await api.resumeTimeTracking(active.intent_id);
      if (action === "stop") await api.stopTimeTracking(active.intent_id);
      await refreshTimer();
      onPlanChange?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się zmienić timera.");
    }
  }

  return (
    <div className="min-h-screen bg-[#f5f3ee] text-fg lg:pl-56">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 border-r border-black/10 bg-[#fffdf8] p-4 lg:flex lg:flex-col">
        <Link href="/time" className="px-2 py-3 font-serif text-xl font-bold">Horolog</Link>
        <nav className="mt-5 space-y-1" aria-label="Główna nawigacja">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold ${pathname === href ? "bg-amber-100 text-amber-950" : "text-fg-muted hover:bg-black/5"}`}>
              <Icon size={18} /> {label}
            </Link>
          ))}
        </nav>
        <form onSubmit={submitCapture} className="mt-6 rounded-2xl border border-black/10 bg-white p-3">
          <label htmlFor="global-capture" className="text-xs font-bold">Zapisz, zanim ucieknie</label>
          <div className="mt-2 flex gap-2">
            <input id="global-capture" value={capture} onChange={(event) => setCapture(event.target.value)} placeholder="Nowa rzecz…" className="min-w-0 flex-1 rounded-lg border px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-300" />
            <button disabled={pending || !capture.trim()} aria-label="Dodaj do Do zrobienia" className="rounded-lg bg-amber-500 px-2 text-white disabled:opacity-40"><Plus size={18} /></button>
          </div>
          <p className="mt-1 text-[10px] text-fg-subtle">Bez analizy AI, prosto do Do zrobienia.</p>
        </form>
      </aside>

      {active && (
        <div className="sticky top-0 z-30 border-b border-amber-200 bg-amber-50/95 px-4 py-2 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <Link href={`/time?focus=${encodeURIComponent(active.intent_id)}`} className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold">{active.title}</span>
              <span className="font-mono text-sm tabular-nums">{clock(elapsed(active, now))}</span>
            </Link>
            <button onClick={() => void timerAction(active.status === "paused" ? "resume" : "pause")} aria-label={active.status === "paused" ? "Wznów timer" : "Wstrzymaj timer"} className="rounded-lg border bg-white p-2">
              {active.status === "paused" ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button onClick={() => void timerAction("stop")} aria-label="Zatrzymaj timer" className="rounded-lg border bg-white p-2"><Square size={15} /></button>
          </div>
        </div>
      )}

      {error && <div role="alert" className="mx-auto mt-3 max-w-5xl px-4 text-sm font-medium text-red-700">{error}</div>}
      <main id="main" className="pb-24 lg:pb-0">{children}</main>

      <button
        type="button"
        onClick={() => setCaptureOpen(true)}
        aria-label="Szybko dodaj do Do zrobienia"
        className="fixed bottom-20 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500 text-white shadow-lg lg:hidden"
      >
        <Plus size={21} />
      </button>

      {captureOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/30 p-3 lg:hidden" role="dialog" aria-modal="true" aria-label="Szybki zapis">
          <form onSubmit={async (event) => { await submitCapture(event); setCaptureOpen(false); }} className="w-full rounded-3xl bg-[#fffdf8] p-4 shadow-2xl">
            <label htmlFor="mobile-global-capture" className="text-sm font-bold">Zapisz, zanim ucieknie</label>
            <input id="mobile-global-capture" autoFocus value={capture} onChange={(event) => setCapture(event.target.value)} placeholder="Co chcesz zapamiętać?" className="mt-3 h-12 w-full rounded-xl border bg-white px-3 text-base outline-none focus:ring-2 focus:ring-amber-300" />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCaptureOpen(false)} className="h-11 rounded-xl border bg-white text-sm font-semibold">Anuluj</button>
              <button disabled={pending || !capture.trim()} className="h-11 rounded-xl bg-amber-500 text-sm font-bold text-white disabled:opacity-40">Zapisz</button>
            </div>
          </form>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-black/10 bg-[#fffdf8]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Główna nawigacja">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${pathname === href ? "text-amber-800" : "text-fg-muted"}`}>
            <Icon size={20} /> {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
