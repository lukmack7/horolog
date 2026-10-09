"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, CheckCircle2, FastForward, Lightbulb, Pause, Play, Plus, RotateCcw, Square } from "lucide-react";
import { Shell } from "@/app/components/Shell";
import { api, formatDuration, minutesBetween, type Block, type DailyData, type Intent, type IntentSuggestion, type Plan, type TimeTrackingEntry } from "@/app/lib/api";
import { localDateKey } from "@/app/lib/experience";

function elapsed(entry: TimeTrackingEntry, now: number): number {
  if (entry.status !== "running" || !entry.last_resumed_at) return entry.elapsed_seconds;
  return entry.accumulated_seconds + Math.max(0, Math.floor((now - Date.parse(entry.last_resumed_at)) / 1000));
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AdhdTimePage({ standard = false }: { standard?: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [daily, setDaily] = useState<DailyData | null>(null);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [active, setActive] = useState<TimeTrackingEntry | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<IntentSuggestion | null>(null);
  const [distraction, setDistraction] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [stuckOpen, setStuckOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const day = localDateKey();
      const [nextPlan, nextDaily, nextIntents, nextActive] = await Promise.all([
        api.plan(), api.daily(day), api.intents(), api.activeTimeTracking(),
      ]);
      setPlan(nextPlan);
      setDaily(nextDaily);
      setIntents(nextIntents);
      setActive(nextActive);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się wczytać planu.");
    }
  }, []);

  useEffect(() => {
    setFocusId(new URLSearchParams(window.location.search).get("focus"));
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const day = localDateKey(now);
  const todayBlocks = useMemo(() => (plan?.blocks ?? []).filter((block) => localDateKey(new Date(block.start)) === day).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), [day, plan]);
  const blocks = useMemo(() => todayBlocks.filter((block) => !block.completed), [todayBlocks]);
  const completed = useMemo(() => {
    const completedBlocks = todayBlocks.filter((block) => block.completed).map((block) => ({
      id: block.intent_id + ":" + block.start,
      title: block.title,
      intentId: block.intent_id,
      start: block.start,
      end: block.end,
      recurring: Boolean(block.recurring),
      finishedAt: intents.find((item) => item.id === block.intent_id)?.completed_at ?? null,
    }));
    // Completed one-shot intents can disappear from the solver's plan entirely.
    for (const intent of intents) {
      if (!intent.completed_at || localDateKey(new Date(intent.completed_at)) !== day) continue;
      if (completedBlocks.some((item) => item.intentId === intent.id)) continue;
      completedBlocks.push({ id: intent.id, title: intent.title, intentId: intent.id, start: "", end: "", recurring: false, finishedAt: intent.completed_at });
    }
    return completedBlocks.sort((a, b) => Date.parse(b.finishedAt ?? b.end || day) - Date.parse(a.finishedAt ?? a.end || day));
  }, [todayBlocks, intents, day]);
  const nowMs = now.getTime();
  const current = blocks.find((block) => Date.parse(block.start) <= nowMs && nowMs < Date.parse(block.end));
  const next = blocks.find((block) => Date.parse(block.start) > nowMs);
  const focused = focusId ? blocks.find((block) => block.intent_id === focusId) : undefined;
  const overdue = blocks.find((block) => Date.parse(block.end) <= nowMs);
  const primary = focused ?? current ?? next ?? overdue;
  const intent = primary ? intents.find((item) => item.id === primary.intent_id) : undefined;
  const firstStep = intent?.first_step || daily?.plan.first_step;
  const upcoming = [...(plan?.busy ?? []).map((item) => ({ title: item.label, start: item.start })), ...blocks.map((item) => ({ title: item.title, start: item.start }))]
    .filter((item) => Date.parse(item.start) > nowMs && (!primary || item.start !== primary.start))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const elapsedSeconds = active ? elapsed(active, nowMs) : 0;
  const plannedMinutes = primary ? minutesBetween(primary.start, primary.end) : 0;
  const predictedEnd = active && primary?.intent_id === active.intent_id
    ? new Date(nowMs + Math.max(0, plannedMinutes * 60 - elapsedSeconds) * 1000)
    : primary ? new Date(Math.max(nowMs, Date.parse(primary.start)) + plannedMinutes * 60000) : null;

  async function perform(key: string, action: () => Promise<unknown>) {
    setPending(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się wykonać działania.");
    } finally {
      setPending(null);
    }
  }

  async function completePrimary() {
    if (!primary) return;
    await perform("complete", async () => {
      if (active?.intent_id === primary.intent_id) await api.stopTimeTracking(primary.intent_id);
      if (primary.recurring) await api.completeBlock(primary.intent_id, primary.start, primary.end);
      else await api.complete(primary.intent_id);
    });
  }

  async function captureDistraction(event: FormEvent) {
    event.preventDefault();
    if (!distraction.trim()) return;
    await perform("capture", async () => {
      await api.createTodo({ title: distraction.trim(), minutes: 30 });
      setDistraction("");
    });
  }

  return (
    <Shell onPlanChange={load}>
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6">
          {!standard && <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Tryb wykonawczy</p>}
          <h1 className="mt-1 text-[28px] font-bold text-fg">{standard ? "Czas" : "Teraz"}</h1>
          <p className="mt-1 text-sm text-fg-muted">Jedna rzecz. Jeden następny krok.</p>
        </header>

        {error && <div role="alert" className="mb-5 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertCircle className="shrink-0" size={18} />{error}</div>}

        {!plan && !error && <div className="h-80 animate-pulse rounded-3xl bg-black/5" />}
        {plan && !primary && <section className="rounded-card border border-black/[0.08] bg-surface p-8 text-center">
          <h2 className="text-xl font-bold">{completed.length ? "Dobra robota — wszystko zaplanowane jest wykonane" : "Nie masz zaplanowanych zadań na dziś"}</h2>
          <p className="mt-2 text-sm text-fg-muted">{completed.length ? "Poniżej możesz zobaczyć, co już udało się zrobić." : "Możesz wybrać kolejne zadanie z Do zrobienia."}</p>
        </section>}

        {primary && (
          <section className="rounded-card border border-black/[0.08] bg-surface p-5 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-bold uppercase tracking-wider text-fg-subtle">{current?.intent_id === primary.intent_id ? "W tej chwili" : "Następny blok"}</div>
                <h2 className="mt-2 text-2xl font-bold leading-tight sm:text-3xl">{primary.title}</h2>
                <p className="mt-2 text-sm text-fg-muted">{new Date(primary.start).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}–{new Date(primary.end).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })} · {formatDuration(plannedMinutes)}</p>
              </div>
              {active?.intent_id === primary.intent_id && <div className="rounded-xl bg-sunk px-4 py-2 text-center"><div className="text-[10px] font-bold uppercase text-fg-muted">Timer</div><div className="font-mono text-2xl tabular-nums">{formatClock(elapsedSeconds)}</div></div>}
            </div>

            {firstStep && <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4"><div className="text-[11px] font-bold uppercase tracking-wider text-amber-800">Pierwszy krok</div><p className="mt-1 text-base font-semibold">{firstStep}</p></div>}

            <div className="mt-6 flex flex-wrap gap-2">
              {(!active || active.intent_id !== primary.intent_id) && (primary.kind === "task" || primary.kind === "focus") && <>
                <button disabled={pending !== null} onClick={() => void perform("start", () => api.startTimeTracking(primary.intent_id))} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-fg px-5 font-bold text-white disabled:opacity-50"><Play size={18} /> Start</button>
                <button disabled={pending !== null} onClick={() => void perform("start-five", () => api.startTimeTracking(primary.intent_id))} className="min-h-12 rounded-xl border border-black/10 bg-surface px-4 font-bold text-fg disabled:opacity-50">Zacznij 5 minut</button>
              </>}
              {active?.intent_id === primary.intent_id && <>
                <button disabled={pending !== null} onClick={() => void perform("toggle", () => active.status === "paused" ? api.resumeTimeTracking(primary.intent_id) : api.pauseTimeTracking(primary.intent_id))} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-fg px-5 font-bold text-white"><>{active.status === "paused" ? <Play size={18} /> : <Pause size={18} />}</>{active.status === "paused" ? "Wznów" : "Pauza"}</button>
                <button disabled={pending !== null} onClick={() => void perform("stop", () => api.stopTimeTracking(primary.intent_id))} className="inline-flex min-h-12 items-center gap-2 rounded-xl border bg-white px-4 font-semibold"><Square size={16} /> Stop</button>
              </>}
              {primary.kind === "task" && !primary.recurring && <button disabled={pending !== null} onClick={() => void completePrimary()} className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 font-semibold text-emerald-900"><Check size={17} /> Gotowe</button>}
              {primary.recurring && <button disabled={pending !== null} onClick={() => void completePrimary()} className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 font-semibold text-emerald-900"><Check size={17} /> Ukończ ten blok</button>}
              <button disabled={pending !== null} onClick={() => setRecoveryOpen((value) => !value)} className="inline-flex min-h-12 items-center gap-2 rounded-xl border bg-white px-4 font-semibold"><FastForward size={17} /> Nie teraz</button>
              <button disabled={pending !== null} onClick={() => setStuckOpen((value) => !value)} className="inline-flex min-h-12 items-center gap-2 rounded-xl border bg-white px-4 font-semibold"><Lightbulb size={17} /> Utknąłem</button>
            </div>

            {recoveryOpen && <div className="mt-4 rounded-xl border border-black/10 bg-sunk p-4">
              <p className="mb-3 text-sm font-semibold">Co zrobić z tym blokiem? Nic nie zostanie przeniesione automatycznie.</p>
              <div className="flex flex-wrap gap-2">
                <button disabled={pending !== null} onClick={() => setRecoveryOpen(false)} className="rounded-lg border bg-surface px-3 py-2 text-sm">Zostaw na tej dacie</button>
                <button disabled={pending !== null} onClick={() => void perform("not-now", async () => { await api.rejectBlock(primary.intent_id, primary.start, primary.end); setRecoveryOpen(false); })} className="rounded-lg border bg-surface px-3 py-2 text-sm">Pomiń ten blok</button>
                {intent?.original_date && <button disabled={pending !== null} onClick={() => void perform("restore", async () => { await api.restoreIntentDate(primary.intent_id); setRecoveryOpen(false); })} className="rounded-lg border bg-surface px-3 py-2 text-sm">Przywróć pierwotną datę</button>}
              </div>
            </div>}
            {stuckOpen && <div className="mt-4 rounded-xl border border-black/10 bg-sunk p-4">
              <p className="mb-3 text-sm font-semibold">Co utrudnia rozpoczęcie?</p>
              <div className="flex flex-wrap gap-2">
                {["Nie wiem, od czego zacząć", "Zadanie jest za duże", "Coś mnie blokuje"].map((reason) => <button key={reason} disabled={pending !== null} onClick={() => void perform("suggest", async () => { setSuggestion(await api.suggestIntent(primary.intent_id)); setStuckOpen(false); })} className="rounded-lg border bg-surface px-3 py-2 text-sm">{reason}</button>)}
                <button onClick={() => { setStuckOpen(false); setRecoveryOpen(true); }} className="rounded-lg border bg-surface px-3 py-2 text-sm">Potrzebuję innego zadania</button>
              </div>
            </div>}
            {suggestion && <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4"><h3 className="font-bold">Proponowany start</h3><p className="mt-1 text-sm font-semibold">{suggestion.first_step}</p><ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">{suggestion.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="mt-4 flex gap-2"><button onClick={() => void perform("save-step", async () => { await api.patchIntent(primary.intent_id, { first_step: suggestion.first_step }); setSuggestion(null); })} className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-bold text-white">Zapisz pierwszy krok</button><button onClick={() => setSuggestion(null)} className="rounded-lg border bg-white px-3 py-2 text-sm font-semibold">Nie zapisuj</button></div></div>}
          </section>
        )}

        {plan && <section className="mt-5 rounded-card border border-black/[0.08] bg-surface p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-base font-semibold"><CheckCircle2 size={18} className="text-emerald-700" /> Dzisiaj zrobione</h2>
            <span className="text-sm font-semibold text-fg-muted">{completed.length} {completed.length === 1 ? "zadanie" : "zadań"}</span>
          </div>
          {completed.length ? <ul className="mt-3 space-y-3">{completed.map((item) => <li key={item.id} className="flex items-center gap-3 border-t border-black/[0.06] pt-3">
            <CheckCircle2 size={16} className="shrink-0 text-emerald-700" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg-muted line-through">{item.title}</div>
              <div className="text-xs text-fg-subtle">{item.finishedAt ? `Ukończono ${new Date(item.finishedAt).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" })}` : "Wykonano · brak dokładnej godziny ukończenia"}</div>
            </div>
            <button disabled={pending !== null} onClick={() => void perform("undo-complete", () => item.recurring ? api.uncompleteBlock(item.intentId, item.start, item.end) : api.uncomplete(item.intentId))} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs text-fg-muted" aria-label={`Cofnij ukończenie: ${item.title}`}><RotateCcw size={12} /> Cofnij</button>
          </li>)}</ul> : <p className="mt-2 text-sm text-fg-muted">Tutaj pojawią się zadania ukończone dzisiaj.</p>}
          {blocks.length > 0 && <p className="mt-3 text-xs text-fg-muted">Pozostało {blocks.length} {blocks.length === 1 ? "blok" : "bloków"} w dzisiejszym planie.</p>}
        </section>}

        <section className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border bg-white/80 p-4"><div className="text-[11px] font-bold uppercase text-fg-subtle">Prognozowany koniec</div><div className="mt-1 text-lg font-bold">{predictedEnd ? predictedEnd.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : "Brak aktywnego bloku"}</div></div>
          <div className="rounded-2xl border bg-white/80 p-4"><div className="text-[11px] font-bold uppercase text-fg-subtle">Następne wydarzenie</div><div className="mt-1 text-lg font-bold">{upcoming ? `${upcoming.title} za ${formatDuration(Math.max(0, minutesBetween(now.toISOString(), upcoming.start)))}` : "Dziś już nic"}</div></div>
        </section>

        <form onSubmit={captureDistraction} className="mt-4 flex gap-2 rounded-2xl border bg-white/80 p-3">
          <label htmlFor="distraction" className="sr-only">Zapisz rozproszenie</label>
          <input id="distraction" value={distraction} onChange={(event) => setDistraction(event.target.value)} placeholder="Rozproszenie? Zapisz i wróć do zadania…" className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none" />
          <button disabled={!distraction.trim() || pending !== null} className="inline-flex items-center gap-1 rounded-xl bg-fg px-3 py-2 text-sm font-bold text-white disabled:opacity-40"><Plus size={16} /> Zapisz</button>
        </form>
      </div>
    </Shell>
  );
}
