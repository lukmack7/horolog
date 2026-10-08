"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Target } from "lucide-react";
import { Shell } from "@/app/components/Shell";
import { api, formatDuration, type DailyCapacity, type DailyData, type DailyDecision, type DailyItem, type PlanningProfile, type TodoInboxItem } from "@/app/lib/api";
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
  const [mode, setMode] = useState<"plan" | "review">("plan");
  const [bonusOpen, setBonusOpen] = useState(false);
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

        <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl border bg-white p-1">
          <button onClick={() => setMode("plan")} className={`rounded-lg py-2 text-sm font-bold ${mode === "plan" ? "bg-amber-100 text-amber-950" : "text-fg-muted"}`}>Plan</button>
          <button onClick={() => setMode("review")} className={`rounded-lg py-2 text-sm font-bold ${mode === "review" ? "bg-amber-100 text-amber-950" : "text-fg-muted"}`}>Zamknięcie dnia</button>
        </div>

        {error && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
        {!data && !error && <div className="mt-5 h-72 animate-pulse rounded-3xl bg-black/5" />}

        {data && mode === "plan" && <div className="mt-5 space-y-4">
          {capacity && <section className="rounded-2xl border bg-white p-4"><div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4"><Metric label="Wolne" value={formatDuration(capacity.free)} /><Metric label="Zaplanowane" value={formatDuration(capacity.scheduled)} /><Metric label="Twój limit" value={formatDuration(profile?.daily_capacity_minutes ?? capacity.workday)} /><Metric label="Najdłuższe okno" value={formatDuration(capacity.longest_free)} /></div>{profile && capacity.scheduled > profile.daily_capacity_minutes && <p className="mt-3 rounded-xl bg-amber-50 p-2.5 text-center text-xs font-semibold text-amber-900">Plan przekracza Twój realistyczny limit o {formatDuration(capacity.scheduled - profile.daily_capacity_minutes)}. Horolog niczego nie przeniesie automatycznie.</p>}</section>}
          <section className="grid gap-3 sm:grid-cols-2">
            <label className="rounded-2xl border bg-white p-4"><span className="flex items-center gap-2 text-sm font-bold"><Target size={16} /> Warunek wygranej</span><textarea value={data.plan.win_condition} onChange={(event) => setData({ ...data, plan: { ...data.plan, win_condition: event.target.value } })} onBlur={() => void savePlan()} rows={3} placeholder="Po czym poznasz, że dzień był wystarczająco dobry?" className="mt-2 w-full resize-none rounded-xl border bg-black/[0.02] p-3 text-sm outline-none focus:ring-2 focus:ring-amber-300" /></label>
            <label className="rounded-2xl border bg-white p-4"><span className="text-sm font-bold">Pierwszy mały krok</span><textarea value={data.plan.first_step} onChange={(event) => setData({ ...data, plan: { ...data.plan, first_step: event.target.value } })} onBlur={() => void savePlan()} rows={3} placeholder="Co konkretnie zrobisz jako pierwsze?" className="mt-2 w-full resize-none rounded-xl border bg-black/[0.02] p-3 text-sm outline-none focus:ring-2 focus:ring-amber-300" /></label>
          </section>

          <section className="rounded-3xl border bg-[#fffdf8] p-4 sm:p-5"><h2 className="text-lg font-bold">Najważniejsze, maksymalnie 3</h2><div className="mt-3 space-y-2">{core.length ? core.map((item) => <TaskRow key={item.id} item={item} pending={pending} onComplete={() => run(() => api.completeDailyItem(item.id))} onRestore={() => run(() => api.restoreDailyItemDate(item.id))} />) : <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Brak zadań podstawowych.</p>}</div></section>

          {bonus.length > 0 && <section className="rounded-2xl border bg-white"><button onClick={() => setBonusOpen((open) => !open)} aria-expanded={bonusOpen} className="flex w-full items-center justify-between p-4 text-left font-bold"><span>Bonus, jeśli zostanie energia ({bonus.length})</span><ChevronDown size={18} className={bonusOpen ? "rotate-180" : ""} /></button>{bonusOpen && <div className="space-y-2 border-t p-4">{bonus.map((item) => <TaskRow key={item.id} item={item} pending={pending} onComplete={() => run(() => api.completeDailyItem(item.id))} onRestore={() => run(() => api.restoreDailyItemDate(item.id))} />)}</div>}</section>}

          <section className="rounded-2xl border bg-white p-4"><h2 className="text-sm font-bold">Dodaj z Do zrobienia</h2>{todos.length ? <select defaultValue="" disabled={pending} onChange={(event) => { const id = event.target.value; event.target.value = ""; if (id) void run(() => api.assignTodo(id, { date, quadrant: 2 })); }} className="mt-2 h-11 w-full rounded-xl border bg-white px-3 text-sm"><option value="">Wybierz zadanie…</option>{todos.map((todo) => <option key={todo.id} value={todo.id}>{todo.title} · {formatDuration(todo.minutes)}</option>)}</select> : <p className="mt-2 text-sm text-fg-muted">Lista Do zrobienia jest pusta.</p>}</section>
        </div>}

        {data && mode === "review" && <div className="mt-5 space-y-4">
          <section className="grid gap-3 sm:grid-cols-2">
            <ReviewField label="Co dziś zrobiłem dobrze?" value={data.review.did_well} onChange={(value) => setData({ ...data, review: { ...data.review, did_well: value } })} onSave={() => run(() => api.saveDailyReview(date, data.review))} />
            <ReviewField label="Jaki jest pierwszy krok rano?" value={data.review.first_step_morning} onChange={(value) => setData({ ...data, review: { ...data.review, first_step_morning: value } })} onSave={() => run(() => api.saveDailyReview(date, data.review))} />
          </section>
          <section className="rounded-2xl border bg-white p-4"><h2 className="font-bold">Jedna decyzja dla każdej niedokończonej rzeczy</h2><p className="mt-1 text-xs text-fg-muted">Nic nie przeniesie się samo. Wszystkie wybrane decyzje zapiszą się razem.</p><div className="mt-4 space-y-2">{unfinished.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_180px]"><div><div className="text-sm font-semibold">{item.title}</div><div className="mt-1 text-xs text-fg-muted">Pierwotnie: {item.original_date || item.plan_date}</div></div><select value={decisions[item.id] ?? ""} onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: event.target.value as DailyDecision["action"] | "" }))} className="h-10 rounded-lg border bg-white px-2 text-sm"><option value="">Wybierz…</option><option value="complete">Gotowe</option><option value="keep">Zostaw na pierwotnej dacie</option><option value="defer">Świadomie przenieś na jutro</option><option value="to_todo">Do zrobienia</option><option value="cancel">Usuń z Daily</option></select></div>)}</div>{unfinished.length === 0 && <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">Wszystko rozstrzygnięte.</p>}<div className="mt-4 flex flex-wrap gap-2"><button disabled={pending || unfinished.length === 0} onClick={() => void submitDecisions()} className="rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-white disabled:opacity-40">Zapisz wybrane decyzje</button><button disabled={pending || Boolean(data.plan.closed_at)} onClick={() => void run(() => api.closeDaily(date))} className="rounded-xl border bg-white px-4 py-3 text-sm font-bold disabled:opacity-40">{data.plan.closed_at ? "Dzień zamknięty" : "Zamknij dzień"}</button></div></section>
        </div>}
      </div>
    </Shell>
  );
}

function Metric({ label, value }: { label: string; value: string }) { return <div><div className="text-[10px] font-bold uppercase text-fg-subtle">{label}</div><div className="mt-1 text-sm font-bold sm:text-lg">{value}</div></div>; }

function TaskRow({ item, pending, onComplete, onRestore }: { item: DailyItem; pending: boolean; onComplete: () => Promise<void>; onRestore: () => Promise<void> }) {
  const moved = item.deferred_here || (item.original_date && item.original_date !== item.defer_until && item.original_date !== localDateKey());
  return <div className="flex items-start gap-3 rounded-xl border bg-white p-3"><button disabled={pending} onClick={() => void onComplete()} aria-label={`Ukończ: ${item.title}`} className="mt-0.5 rounded-full border p-1.5 text-emerald-700"><Check size={14} /></button><div className="min-w-0 flex-1"><div className="font-semibold">{item.title}</div><div className="mt-1 text-xs text-fg-muted">{formatDuration(item.minutes)}{item.original_date ? ` · pierwotnie ${item.original_date}` : ""}</div></div>{moved && <button disabled={pending} onClick={() => void onRestore()} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold"><RotateCcw size={12} /> Przywróć datę</button>}</div>;
}

function ReviewField({ label, value, onChange, onSave }: { label: string; value: string; onChange: (value: string) => void; onSave: () => Promise<void> }) { return <label className="rounded-2xl border bg-white p-4"><span className="text-sm font-bold">{label}</span><textarea value={value} onChange={(event) => onChange(event.target.value)} onBlur={() => void onSave()} rows={6} className="mt-2 w-full resize-none rounded-xl border p-3 text-sm outline-none focus:ring-2 focus:ring-amber-300" /></label>; }
