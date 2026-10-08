"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BarChart3, CalendarDays, CalendarRange, ChevronRight, ClipboardList, Clock3, ListChecks, MoreHorizontal, Pause, Play, Plus, Settings2, Sparkles, Square, X } from "lucide-react";
import { CommandBar } from "@/app/components/CommandBar";
import { api, type TimeTrackingEntry } from "@/app/lib/api";

const NAV = [
  { href: "/time", label: "Teraz", icon: Clock3 },
  { href: "/daily", label: "Dzisiaj", icon: CalendarDays },
  { href: "/todo", label: "Do zrobienia", icon: ClipboardList },
  { href: "/settings", label: "Ustawienia", icon: Settings2 },
] as const;

const TOOLS = [
  { href: "/planner", label: "Kalendarz i Planner", icon: CalendarRange },
  { href: "/inbox", label: "Wszystkie zadania", icon: ListChecks },
  { href: "/analytics", label: "Postępy i Analytics", icon: BarChart3 },
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
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const stream = new EventSource("/api/stream");
    stream.addEventListener("plan", () => {
      void refreshTimer();
      onPlanChange?.();
    });
    return () => stream.close();
  }, [onPlanChange, refreshTimer]);

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
        <div className="mt-6 border-t border-black/10 pt-4">
          <p className="px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-subtle">Planowanie i historia</p>
          <nav className="mt-2 space-y-1" aria-label="Planowanie i historia">
            {TOOLS.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${pathname === href ? "bg-amber-100 text-amber-950" : "text-fg-muted hover:bg-black/5"}`}>
                <Icon size={17} /> {label}
              </Link>
            ))}
            <button type="button" onClick={() => setCommandOpen(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold text-amber-800 hover:bg-amber-50">
              <Sparkles size={17} /> Zapytaj Horologa
              <span className="ml-auto text-[9px] text-fg-subtle">Ctrl K</span>
            </button>
          </nav>
        </div>
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

      {mobileMoreOpen && (
        <>
          <button type="button" aria-label="Zamknij dodatkową nawigację" onClick={() => setMobileMoreOpen(false)} className="fixed inset-0 z-30 bg-black/25 lg:hidden" />
          <div role="dialog" aria-modal="true" aria-label="Planowanie i historia" className="fixed bottom-[4.5rem] left-3 right-3 z-40 rounded-3xl border border-black/10 bg-[#fffdf8] p-3 shadow-2xl lg:hidden">
            <div className="mb-2 flex items-center justify-between px-1">
              <div><div className="text-sm font-bold">Planowanie i historia</div><div className="text-[10px] text-fg-muted">Pełne narzędzia, kiedy ich potrzebujesz.</div></div>
              <button type="button" onClick={() => setMobileMoreOpen(false)} aria-label="Zamknij" className="rounded-full bg-black/5 p-2"><X size={16} /></button>
            </div>
            <nav className="overflow-hidden rounded-2xl border bg-white">
              {TOOLS.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} onClick={() => setMobileMoreOpen(false)} className="flex min-h-14 items-center gap-3 border-b px-3 last:border-b-0">
                  <span className="rounded-xl bg-amber-50 p-2 text-amber-800"><Icon size={17} /></span><span className="flex-1 text-sm font-semibold">{label}</span><ChevronRight size={15} className="text-fg-subtle" />
                </Link>
              ))}
              <button type="button" onClick={() => { setMobileMoreOpen(false); setCommandOpen(true); }} className="flex min-h-14 w-full items-center gap-3 border-t px-3 text-left">
                <span className="rounded-xl bg-amber-100 p-2 text-amber-800"><Sparkles size={17} /></span><span className="flex-1 text-sm font-bold">Zapytaj Horologa</span><ChevronRight size={15} className="text-fg-subtle" />
              </button>
            </nav>
          </div>
        </>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-black/10 bg-[#fffdf8]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Główna nawigacja">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${pathname === href ? "text-amber-800" : "text-fg-muted"}`}>
            <Icon size={20} /> {label}
          </Link>
        ))}
        <button type="button" onClick={() => setMobileMoreOpen((open) => !open)} aria-expanded={mobileMoreOpen} className={`flex min-h-16 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${mobileMoreOpen || TOOLS.some((item) => pathname === item.href) ? "text-amber-800" : "text-fg-muted"}`}>
          <MoreHorizontal size={20} /> Więcej
        </button>
      </nav>
      <CommandBar open={commandOpen} onClose={() => setCommandOpen(false)} onCaptured={() => onPlanChange?.()} />
    </div>
  );
}
