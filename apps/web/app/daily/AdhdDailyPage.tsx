"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, History, RotateCcw, Target } from "lucide-react";
import { Shell } from "@/app/components/Shell";
import { api, formatDuration, type DailyCapacity, type DailyData, type DailyDecision, type DailyHistoryEntry, type DailyItem, type DailyWeekly, type PlanningProfile, type TodoInboxItem } from "@/app/lib/api";
import { localDateKey } from "@/app/lib/experience";

function addDays(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

export function AdhdDailyPage() {
  const [date, setDate] = useState(localDateKey);
  const [data, setData] = useState<DailyData | null>(null);
  const [capacity, setCapacity] = useState<DailyCapacity | null>(null);
  const [todos, setTodos] = useState<TodoInboxItem[]>([]);
  const [profile, setProfile] = useState<PlanningProfile | null>(null);
  const [mode, setMode] = useState<"plan" | "review" | "history">("plan");
  const [bonusOpen, setBonusOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, DailyDecision["action"] | "">>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextData, nextCapacity, nextTodos, nextProfile] = await Promise.all([api.daily(date), api.capacity(date), api.todos(), api.planningProfile()]);
      setData(nextData);
      setCapacity(nextCapacity);
      setTodos(nextTodos);
      setProfile(nextProfile);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się wczytać dnia.");
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const activeItems = useMemo(() => data?.items.filter((item) => !item.completed_at && !item.cancelled_at) ?? [], [data]);
  const ordered = useMemo(() => activeItems.slice().sort((a, b) => a.quadrant - b.quadrant || a.priority - b.priority), [activeItems]);
  const core = ordered.slice(0, 3);
  const bonus = ordered.slice(3);
  const completed = useMemo(() => data?.items.filter((item) => item.completed_at && !item.cancelled_at) ?? [], [data]);
  const unfinished = data ? [...data.items, ...data.carry_suggestions].filter((item, index, all) => !item.completed_at && !item.cancelled_at && all.findIndex((other) => other.id === item.id) === index) : [];

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try { await action(); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Nie udało się zapisać zmiany."); }
    finally { setPending(false); }
  }

  async function savePlan() {
    if (!data) return;
    await run(() => api.saveDailyPlan(date, { win_condition: data.plan.win_condition, first_step: data.plan.first_step }));
  }

  async function submitDecisions() {
    const tomorrow = addDays(date, 1);
    const body = unfinished.flatMap((item): DailyDecision[] => {
      const action = decisions[item.id];
      if (!action) return [];
      return [{ item_id: item.id, action, ...(action === "keep" ? { date } : {}), ...(action === "defer" ? { until: tomorrow } : {}) }];
    });
    if (!body.length) { setError("Wybierz decyzję dla co najmniej jednego zadania."); return; }
    await run(async () => { await api.dailyDecisions(body); setDecisions({}); });
  }

  return (
    <Shell onPlanChange={load}>
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-amber-700">Plan bez przeciążenia</p><h1 className="font-serif text-3xl font-bold">Dzisiaj</h1></div>
          <div className="flex items-center gap-2">
            <button aria-label="Poprzedni dzień" onClick={() => setDate(addDays(date, -1))} className="rounded-xl border bg-white p-2"><ChevronLeft size={18} /></button>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Dzień planu" className="h-10 rounded-xl border bg-white px-2 text-sm font-semibold" />
            <button aria-label="Następny dzień" onClick={() => setDate(addDays(date, 1))} className="rounded-xl border bg-white p-2"><ChevronRight size={18} /></button>
          </div>
        </header>

        <div className="mt-5 grid grid-cols-3 gap-1 rounded-xl border bg-white p-1">
          <button onClick={() => setMode("plan")} className={`rounded-lg py-2 text-sm font-bold ${mode === "plan" ? "bg-amber-100 text-amber-950" : "text-fg-muted"}`}>Plan</button>
          <button onClick={() => setMode("review")} className={`rounded-lg py-2 text-sm font-bold ${mode === "review" ? "bg-amber-100 text-amber-950" : "text-fg-muted"}`}>Zamknięcie dnia</button>
          <button onClick={() => setMode("history")} className={`rounded-lg py-2 text-sm font-bold ${mode === "history" ? "bg-amber-100 text-amber-950" : "text-fg-muted"}`}>Historia</button>
        </div>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
        {!data && !error && <div className="mt-5 h-72 animate-pulse rounded-3xl bg-black/5" />}

        {data && mode === "plan" && <div className="mt-5 space-y-4">
          <section className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div><div className="flex items-center gap-2 text-sm font-bold text-amber-950"><CalendarRange size={17} /> Wstępny plan i kalendarz</div><p className="mt-1 text-xs text-amber-900/75">Zobacz cały tydzień, spotkania i bloki czasu. Tutaj nadal wybierasz tylko to, co najważniejsze.</p></div>
            <Link href="/planner" className="shrink-0 rounded-xl bg-amber-500 px-4 py-2.5 text-center text-sm font-bold text-white">Otwórz Planner</Link>
          </section>
          {capacity && <section className="rounded-2xl border bg-white p-4"><div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4"><Metric label="Wolne" value={formatDuration(capacity.free)} /><Metric label="Zaplanowane" value={formatDuration(capacity.scheduled)} /><Metric label="Twój limit" value={formatDuration(profile?.daily_capacity_minutes ?? capacity.workday)} /><Metric label="Najdłuższe okno" value={formatDuration(capacity.longest_free)} /></div>{profile && capacity.scheduled > profile.daily_capacity_minutes && <p className="mt-3 rounded-xl bg-amber-50 p-2.5 text-center text-xs font-semibold text-amber-900">Plan przekracza Twój realistyczny limit o {formatDuration(capacity.scheduled - profile.daily_capacity_minutes)}. Horolog niczego nie przeniesie automatycznie.</p>}</section>}
          <section className="grid gap-3 sm:grid-cols-2">
            <label className="rounded-2xl border bg-white p-4"><span className="flex items-center gap-2 text-sm font-bold"><Target size={16} /> Warunek wygranej</span><textarea value={data.plan.win_condition} onChange={(event) => setData({ ...data, plan: { ...data.plan, win_condition: event.target.value } })} onBlur={() => void savePlan()} rows={3} placeholder="Po czym poznasz, że dzień był wystarczająco dobry?" className="mt-2 w-full resize-none rounded-xl border bg-black/[0.02] p-3 text-sm outline-none focus:ring-2 focus:ring-amber-300" /></label>
            <label className="rounded-2xl border bg-white p-4"><span className="text-sm font-bold">Pierwszy mały krok</span><textarea value={data.plan.first_step} onChange={(event) => setData({ ...data, plan: { ...data.plan, first_step: event.target.value } })} onBlur={() => void savePlan()} rows={3} placeholder="Co konkretnie zrobisz jako pierwsze?" className="mt-2 w-full resize-none rounded-xl border bg-black/[0.02] p-3 text-sm outline-none focus:ring-2 focus:ring-amber-300" /></label>
          </section>

          <section className="rounded-3xl border bg-[#fffdf8] p-4 sm:p-5"><h2 className="text-lg font-bold">Najważniejsze, maksymalnie 3</h2><div className="mt-3 space-y-2">{core.length ? core.map((item) => <TaskRow key={item.id} item={item} pending={pending} onComplete={() => run(() => api.completeDailyItem(item.id))} onRestore={() => run(() => api.restoreDailyItemDate(item.id))} />) : <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Brak zadań podstawowych.</p>}</div></section>

          {bonus.length > 0 && <section className="rounded-2xl border bg-white"><button onClick={() => setBonusOpen((open) => !open)} aria-expanded={bonusOpen} className="flex w-full items-center justify-between p-4 text-left font-bold"><span>Bonus, jeśli zostanie energia ({bonus.length})</span><ChevronDown size={18} className={bonusOpen ? "rotate-180" : ""} /></button>{bonusOpen && <div className="space-y-2 border-t p-4">{bonus.map((item) => <TaskRow key={item.id} item={item} pending={pending} onComplete={() => run(() => api.completeDailyItem(item.id))} onRestore={() => run(() => api.restoreDailyItemDate(item.id))} />)}</div>}</section>}

          {completed.length > 0 && <section className="rounded-2xl border border-emerald-200 bg-white"><button onClick={() => setCompletedOpen((open) => !open)} aria-expanded={completedOpen} className="flex w-full items-center justify-between p-4 text-left font-bold text-emerald-900"><span className="flex items-center gap-2"><CheckCircle2 size={18} /> Ukończone tego dnia ({completed.length})</span><ChevronDown size={18} className={completedOpen ? "rotate-180" : ""} /></button>{completedOpen && <div className="space-y-2 border-t border-emerald-100 p-4">{completed.map((item) => <CompletedTaskRow key={item.id} item={item} />)}</div>}</section>}

          <section className="rounded-2xl border bg-white p-4"><h2 className="text-sm font-bold">Dodaj z Do zrobienia</h2>{todos.length ? <select defaultValue="" disabled={pending} onChange={(event) => { const id = event.target.value; event.target.value = ""; if (id) void run(() => api.assignTodo(id, { date, quadrant: 2 })); }} className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="">Wybierz zadanie…</option>{todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title} · {formatDuration(todo.minutes)}</option>)}</select> : <p className="mt-2 text-sm text-fg-muted">Lista Do zrobienia jest pusta.</p>}</section>
        </div>}

        {data && mode === "review" && <div className="mt-5 space-y-4">
          <section className="grid gap-3 sm:grid-cols-2">
            <ReviewField label="Co dziś zrobiłem dobrze?" value={data.review.did_well} onChange={(value) => setData({ ...data, review: { ...data.review, did_well: value } })} onSave={() => run(() => api.saveDailyReview(date, data.review))} />
            <ReviewField label="Jaki jest pierwszy krok rano?" value={data.review.first_step_morning} onChange={(value) => setData({ ...data, review: { ...data.review, first_step_morning: value } })} onSave={() => run(() => api.saveDailyReview(date, data.review))} />
          </section>
          <section className="rounded-2xl border bg-white p-4"><h2 className="font-bold">Jedna decyzja dla każdej niedokończonej rzeczy</h2><p className="mt-1 text-xs text-fg-muted">Nic nie przeniesie się samo. Wszystkie wybrane decyzje zapiszą się razem.</p><div className="mt-4 space-y-2">{unfinished.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_180px]"><div><div className="text-sm font-semibold">{item.title}</div><div className="mt-1 text-xs text-fg-muted">Pierwotnie: {item.original_date || item.plan_date}</div></div><select value={decisions[item.id] ?? ""} onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: event.target.value as DailyDecision["action"] | "" }))} className="h-10 rounded-lg border bg-white px-2 text-sm"><option value="">Wybierz…</option><option value="complete">Gotowe</option><option value="keep">Zostaw na pierwotnej dacie</option><option value="defer">Świadomie przenieś na jutro</option><option value="to_todo">Do zrobienia</option><option value="cancel">Usuń z Daily</option></select></div>)}</div>{unfinished.length === 0 && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Wszystko rozstrzygnięte.</p>}<div className="mt-4 flex flex-wrap gap-2"><button disabled={pending || unfinished.length === 0} onClick={() => void submitDecisions()} className="rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">Zapisz wybrane decyzje</button><button disabled={pending || Boolean(data.plan.closed_at)} onClick={() => void run(() => api.closeDaily(date))} className="rounded-xl border bg-white px-4 py-3 text-sm font-bold disabled:opacity-40">{data.plan.closed_at ? "Dzień zamknięty" : "Zamknij dzień"}</button></div></section>
        </div>}

        {mode === "history" && <div className="mt-5"><DailyHistory currentDate={date} onOpenDay={(nextDate) => { setDate(nextDate); setMode("plan"); }} /></div>}
      </div>
    </Shell>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <div><div className="text-[10px] font-bold uppercase text-fg-subtle">{label}</div><div className="mt-1 text-sm font-bold sm:text-lg">{value}</div></div>; }

function TaskRow({ item, pending, onComplete, onRestore }: { item: DailyItem; pending: boolean; onComplete: () => Promise<void>; onRestore: () => Promise<void> }) {
  const moved = item.deferred_here || (item.original_date && item.original_date !== item.defer_until && item.original_date !== localDateKey());
  return <div className="flex items-start gap-3 rounded-xl border bg-white p-3"><button disabled={pending} onClick={() => void onComplete()} aria-label={`Ukończ: ${item.title}`} className="mt-0.5 rounded-full border p-1.5 text-emerald-700"><Check size={14} /></button><div className="min-w-0 flex-1"><div className="font-semibold">{item.title}</div><div className="mt-1 text-xs text-fg-muted">{formatDuration(item.minutes)}{item.original_date ? ` · pierwotnie ${item.original_date}` : ""}</div></div>{moved && <button disabled={pending} onClick={() => void onRestore()} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold"><RotateCcw size={12} /> Przywróć datę</button>}</div>;
}

function CompletedTaskRow({ item }: { item: DailyItem }) {
  const completedAt = item.completed_at ? new Date(item.completed_at).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }) : null;
  return <div className="flex items-center gap-3 rounded-xl bg-emerald-50/70 p-3"><Check size={15} className="shrink-0 text-emerald-700" /><div className="min-w-0 flex-1"><div className="font-semibold text-emerald-950">{item.title}</div><div className="mt-0.5 text-xs text-emerald-800/70">{formatDuration(item.minutes)}{completedAt ? ` · ukończono ${completedAt}` : ""}</div></div></div>;
}

function DailyHistory({ currentDate, onOpenDay }: { currentDate: string; onOpenDay: (date: string) => void }) {
  const [history, setHistory] = useState<DailyHistoryEntry[]>([]);
  const [weekly, setWeekly] = useState<DailyWeekly | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.dailyHistory(), api.dailyWeekly(currentDate)])
      .then(([nextHistory, nextWeekly]) => {
        if (!alive) return;
        setHistory(nextHistory);
        setWeekly(nextWeekly);
        setError(null);
      })
      .catch((caught) => {
        if (alive) setError(caught instanceof Error ? caught.message : "Nie udało się wczytać historii.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [currentDate]);

  if (loading) return <div className="h-72 animate-pulse rounded-3xl bg-black/5" />;
  if (error) return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>;

  return <div className="space-y-4">
    {weekly && <section className="rounded-2xl border bg-white p-4"><div className="flex items-center gap-2"><CalendarRange size={17} /><h2 className="font-bold">Tydzień w skrócie</h2></div><p className="mt-1 text-xs text-fg-muted">{weekly.start} - {weekly.end}</p><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="Zaplanowane dni" value={`${weekly.planned_days}/7`} /><Metric label="Dni z review" value={`${weekly.reviewed_days}/7`} /><Metric label="Wykonane" value={`${weekly.items_completed}/${weekly.items_created}`} /><Metric label="Do decyzji" value={String(weekly.stale_items)} /></div><div className="mt-4 grid grid-cols-7 gap-1">{weekly.days.map((day) => <button key={day.date} type="button" onClick={() => onOpenDay(day.date)} className={`rounded-lg border px-1 py-2 text-center ${day.completed_items ? "border-emerald-200 bg-emerald-50" : "bg-white"}`}><div className="text-[9px] uppercase text-fg-muted">{new Date(`${day.date}T12:00:00`).toLocaleDateString("pl-PL", { weekday: "short" })}</div><div className="mt-1 text-xs font-bold">{new Date(`${day.date}T12:00:00`).getDate()}</div>{day.completed_items > 0 && <div className="mt-1 text-[9px] font-bold text-emerald-700">{day.completed_items} ✓</div>}</button>)}</div></section>}
    <section className="rounded-2xl border bg-white p-4"><div className="flex items-center gap-2"><History size={17} /><h2 className="font-bold">Historia dni</h2></div>{history.length === 0 ? <p className="mt-3 rounded-xl bg-black/[0.03] p-4 text-center text-sm text-fg-muted">Historia zacznie się budować wraz z kolejnymi dniami.</p> : <div className="mt-3 divide-y overflow-hidden rounded-xl border">{history.map((entry) => <button key={entry.date} type="button" onClick={() => onOpenDay(entry.date)} className="flex w-full items-center gap-3 bg-white p-3 text-left hover:bg-black/[0.02]"><div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl bg-amber-50"><span className="text-[9px] uppercase text-amber-800">{new Date(`${entry.date}T12:00:00`).toLocaleDateString("pl-PL", { month: "short" })}</span><span className="text-sm font-bold">{new Date(`${entry.date}T12:00:00`).getDate()}</span></div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{entry.win_condition || entry.first_step || "Plan dnia"}</div><div className="mt-1 text-xs text-fg-muted">{entry.completed_items}/{entry.items} wykonanych · {entry.review_answers} odpowiedzi review</div></div><ChevronRight size={16} className="text-fg-subtle" /></button>)}</div>}</section>
  </div>;
}

function ReviewField({ label, value, onChange, onSave }: { label: string; value: string; onChange: (value: string) => void; onSave: () => Promise<void> }) { return <label className="rounded-2xl border bg-white p-4"><span className="text-sm font-bold">{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} onBlur={() => void onSave()} rows={6} className="mt-2 w-full resize-none rounded-xl border p-3 text-sm outline-none focus:ring-2 focus:ring-amber-300" /></label>; }
