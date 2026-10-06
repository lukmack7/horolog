"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/app/components/Shell";
import {
  api,
  formatDuration,
  type DailyData,
  type DailyHistoryEntry,
  type DailyReview,
  type DailyWeekly,
} from "@/app/lib/api";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Clock3,
  Lightbulb,
  RotateCcw,
  Sparkles,
  Sunrise,
  Target,
  Trash2,
  History,
  CalendarRange,
  Brain,
} from "lucide-react";

type DailyMode = "plan" | "review" | "history";

const QUADRANTS = [
  {
    id: 1 as const,
    title: "1. Zrób teraz",
    subtitle: "Ważne + pilne",
    helper: "Co mnie ugryzie, jeśli tego dziś nie zrobię?",
    tone: "border-red-200 bg-red-50/45",
    dot: "#dc2626",
    schedule: true,
  },
  {
    id: 2 as const,
    title: "2. Zaplanuj",
    subtitle: "Ważne + niepilne",
    helper: "Co warto zrobić, zanim stanie się pilne?",
    tone: "border-amber-200 bg-amber-50/45",
    dot: "#f59e0b",
    schedule: true,
  },
  {
    id: 3 as const,
    title: "3. Ogranicz / deleguj",
    subtitle: "Nieważne + pilne",
    helper: "Czy naprawdę muszę zrobić to osobiście i teraz?",
    tone: "border-blue-200 bg-blue-50/40",
    dot: "#2563eb",
    schedule: false,
  },
  {
    id: 4 as const,
    title: "4. Usuń / odłóż",
    subtitle: "Nieważne + niepilne",
    helper: "Czy to zadanie zabiera czas ważniejszym rzeczom?",
    tone: "border-stone-200 bg-stone-50/70",
    dot: "#78716c",
    schedule: false,
  },
];

const REVIEW_FIELDS: Array<{
  key: keyof DailyReview;
  label: string;
  icon: string;
  placeholder: string;
}> = [
  { key: "did_well", label: "Co dziś zrobiłem dobrze?", icon: "✅", placeholder: "Co poszło dobrze, mimo wszystko?" },
  { key: "grateful_for", label: "Za co jestem sobie wdzięczny?", icon: "🙏", placeholder: "Za jaką decyzję, wysiłek albo zachowanie sobie dziękuję?" },
  { key: "would_change", label: "Co dziś zrobiłbym inaczej?", icon: "🔄", placeholder: "Bez biczowania się — co zrobiłbym inaczej drugi raz?" },
  { key: "learned", label: "Czego mnie to uczy?", icon: "🧠", placeholder: "Jaki wniosek chcę zapamiętać?" },
  { key: "improve_tomorrow", label: "Co poprawię jutro?", icon: "➡️", placeholder: "Jedna konkretna rzecz na jutro." },
  { key: "first_step_morning", label: "Jaki jest mój pierwszy krok rano?", icon: "▶️", placeholder: "Najmniejszy konkretny krok, od którego zacznę." },
];

function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const dateKeyFromDate = dateKey;

export default function DailyPage() {
  const [date, setDate] = useState(() => {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    return now;
  });
  const [mode, setMode] = useState<DailyMode>("plan");
  const [data, setData] = useState<DailyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const key = dateKey(date);

  const load = useCallback(async () => {
    try {
      setData(await api.daily(key));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się wczytać Daily.");
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  const moveDay = (days: number) => {
    setDate((current) => {
      const next = new Date(current);
      next.setDate(current.getDate() + days);
      return next;
    });
  };

  const savePlan = async (patch: Partial<DailyData["plan"]>) => {
    if (!data) return;
    const next = { ...data.plan, ...patch };
    setData({ ...data, plan: next });
    setSaving("plan");
    try {
      await api.saveDailyPlan(key, {
        win_condition: next.win_condition,
        first_step: next.first_step,
      });
    } finally {
      setSaving(null);
    }
  };

  const saveReview = async (next: DailyReview) => {
    if (!data) return;
    setData({ ...data, review: next });
    setSaving("review");
    try {
      await api.saveDailyReview(key, next);
    } finally {
      setSaving(null);
    }
  };

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[1280px] overflow-x-hidden px-4 py-5 sm:px-6 sm:py-8">
        <header className="mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[30px] font-bold leading-tight text-fg">Daily</h1>
              <p className="mt-1 text-[13px] text-fg-muted">
                Plan dnia, wykonanie i refleksja w jednym miejscu.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => moveDay(-1)} className="flex h-9 w-9 items-center justify-center rounded-xl border bg-white">
                <ChevronLeft size={17} />
              </button>
              <button
                type="button"
                onClick={() => setDate(new Date())}
                className="h-9 rounded-xl border bg-white px-3 text-[12px] font-semibold"
              >
                Dziś
              </button>
              <button type="button" onClick={() => moveDay(1)} className="flex h-9 w-9 items-center justify-center rounded-xl border bg-white">
                <ChevronRight size={17} />
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
                {date.toLocaleDateString("pl-PL", { weekday: "long" })}
              </div>
              <div className="font-serif text-[22px] font-bold text-fg">
                {date.toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" })}
              </div>
            </div>
            {data && (
              <div className="flex gap-2 text-[10.5px] font-semibold text-fg-muted">
                <span className="rounded-full bg-sunk px-2.5 py-1">
                  {data.summary.completed_blocks}/{data.summary.total_blocks} bloków
                </span>
                {data.summary.carry_over > 0 && (
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">
                    {data.summary.carry_over} przeniesione
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-1 rounded-2xl border bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setMode("plan")}
              className={`flex h-11 items-center justify-center gap-2 rounded-xl text-[12.5px] font-semibold ${
                mode === "plan" ? "bg-primary text-white" : "text-fg-muted"
              }`}
            >
              <CalendarDays size={16} /> Plan dnia
            </button>
            <button
              type="button"
              onClick={() => {
                if (dateKey(date) > dateKey(new Date())) setDate(new Date());
                setMode("review");
              }}
              className={`flex h-11 items-center justify-center gap-2 rounded-xl text-[12.5px] font-semibold ${
                mode === "review" ? "bg-primary text-white" : "text-fg-muted"
              }`}
            >
              <Sparkles size={16} /> Koniec dnia
            </button>
            <button
              type="button"
              onClick={() => setMode("history")}
              className={`flex h-11 items-center justify-center gap-2 rounded-xl text-[12.5px] font-semibold ${
                mode === "history" ? "bg-primary text-white" : "text-fg-muted"
              }`}
            >
              <History size={16} /> Historia
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {!data && !error && (
          <div className="space-y-3">
            <div className="h-28 animate-pulse rounded-2xl bg-sunk" />
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="h-72 animate-pulse rounded-2xl bg-sunk" />
              <div className="h-72 animate-pulse rounded-2xl bg-sunk" />
            </div>
          </div>
        )}

        {data && mode === "plan" && (
          <PlanView
            data={data}
            setData={setData}
            dateKey={key}
            savePlan={savePlan}
            reload={load}
          />
        )}

        {data && mode === "review" && (
          <ReviewView
            data={data}
            saveReview={saveReview}
          />
        )}

        {mode === "history" && (
          <HistoryView
            currentDate={date}
            onOpenDay={(next) => {
              setDate(next);
              setMode("plan");
            }}
          />
        )}

        {saving && (
          <div className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-primary px-3 py-1.5 text-[10px] font-semibold text-white shadow-lg">
            zapisuję…
          </div>
        )}
      </main>
    </Shell>
  );
}

function PlanView({
  data,
  setData,
  dateKey,
  savePlan,
  reload,
}: {
  data: DailyData;
  setData: (data: DailyData) => void;
  dateKey: string;
  savePlan: (patch: Partial<DailyData["plan"]>) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      {data.yesterday.improve && (
        <section className="rounded-2xl border border-indigo-100 bg-indigo-50/45 p-4">
          <div className="flex items-start gap-3">
            <Brain size={16} className="mt-0.5 shrink-0 text-indigo-700" />
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-indigo-700">
                Wczoraj chciałeś poprawić
              </div>
              <p className="mt-1 text-[12.5px] font-medium leading-relaxed text-indigo-950">
                {data.yesterday.improve}
              </p>
            </div>
          </div>
        </section>
      )}

      {data.summary.carry_over > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
          <div className="flex items-start gap-3">
            <RotateCcw size={17} className="mt-0.5 shrink-0 text-amber-700" />
            <div>
              <h2 className="text-[13px] font-bold text-amber-900">Przeniesione z wcześniejszych dni</h2>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-amber-800">
                Nic nie znika. Niewykonane zadania pozostają aktywne aż je wykonasz albo świadomie usuniesz.
              </p>
            </div>
          </div>
        </section>
      )}

      {data.suggestions.length > 0 && (
        <section className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <CalendarDays size={16} className="text-fg-muted" />
            <h2 className="text-[14px] font-bold">Już w Plannerze</h2>
          </div>
          <p className="mt-1 text-[11.5px] text-fg-muted">
            Te zadania są już zaplanowane na ten dzień. Dodaj je do macierzy bez tworzenia duplikatu.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.suggestions.map((item) => (
              <button
                key={item.intent_id}
                type="button"
                onClick={async () => {
                  const quadrant = item.priority;
                  await api.createDailyItem(dateKey, {
                    title: item.title,
                    quadrant: quadrant as 1 | 2 | 3 | 4,
                    minutes: Math.max(15, item.minutes),
                    schedule_enabled: true,
                    intent_id: item.intent_id,
                  });
                  await reload();
                }}
                className="flex max-w-full items-center gap-2 rounded-xl border bg-sunk/50 px-3 py-2 text-left text-[11.5px] font-medium hover:bg-sunk"
              >
                <CirclePlus size={14} className="shrink-0" />
                <span className="truncate">{item.title}</span>
                <span className="tabular shrink-0 text-[9px] text-fg-muted">{formatDuration(item.minutes)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="flex items-center gap-2 px-1 text-[10.5px] text-fg-muted">
        <Target size={13} />
        <span>Macierz ustala priorytet zadania automatycznie — bez osobnego P1/P2/P3/P4 w Daily.</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {QUADRANTS.map((quadrant) => (
          <QuadrantCard
            key={quadrant.id}
            quadrant={quadrant}
            items={data.items.filter((item) => item.quadrant === quadrant.id && !item.completed_at)}
            dateKey={dateKey}
            reload={reload}
            draggingItemId={draggingItemId}
            setDraggingItemId={setDraggingItemId}
          />
        ))}
      </div>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <Target size={16} />
            <h2 className="text-[13px] font-bold">Dzisiaj wygrywam, jeśli…</h2>
          </div>
          <textarea
            value={data.plan.win_condition}
            onChange={(e) => setData({ ...data, plan: { ...data.plan, win_condition: e.target.value } })}
            onBlur={(e) => void savePlan({ win_condition: e.target.value })}
            rows={3}
            placeholder="Jedna rzecz, która sprawi, że ten dzień uznam za wygrany."
            className="w-full resize-none rounded-xl border bg-sunk/30 px-3 py-2.5 text-[13px] outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <Sunrise size={16} />
            <h2 className="text-[13px] font-bold">Zaczynam od…</h2>
          </div>
          <textarea
            value={data.plan.first_step}
            onChange={(e) => setData({ ...data, plan: { ...data.plan, first_step: e.target.value } })}
            onBlur={(e) => void savePlan({ first_step: e.target.value })}
            rows={3}
            placeholder="Najmniejszy konkretny krok, który zrobię jako pierwszy."
            className="w-full resize-none rounded-xl border bg-sunk/30 px-3 py-2.5 text-[13px] outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
      </section>
    </div>
  );
}

function QuadrantCard({
  quadrant,
  items,
  dateKey,
  reload,
  draggingItemId,
  setDraggingItemId,
}: {
  quadrant: (typeof QUADRANTS)[number];
  items: DailyData["items"];
  dateKey: string;
  reload: () => Promise<void>;
  draggingItemId: string | null;
  setDraggingItemId: (id: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(30);

  const submit = async () => {
    if (!title.trim()) return;
    await api.createDailyItem(dateKey, {
      title: title.trim(),
      quadrant: quadrant.id,
      minutes,
      schedule_enabled: quadrant.schedule,
    });
    setTitle("");
    setMinutes(30);
    setAdding(false);
    await reload();
  };

  return (
    <section
      className={`rounded-2xl border p-4 shadow-sm transition-all ${quadrant.tone} ${
        draggingItemId ? "ring-1 ring-black/5" : ""
      }`}
      onDragOver={(e) => {
        if (!draggingItemId) return;
        e.preventDefault();
      }}
      onDrop={async (e) => {
        e.preventDefault();
        if (!draggingItemId) return;
        const item = items.find((candidate) => candidate.id === draggingItemId);
        if (!item || item.quadrant === quadrant.id) {
          setDraggingItemId(null);
          return;
        }
        await api.moveDailyItem(draggingItemId, quadrant.id, dateKey);
        setDraggingItemId(null);
        await reload();
      }}
    >
      <div className="mb-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-1 rounded-full" style={{ background: quadrant.dot }} />
          <h2 className="text-[15px] font-bold text-fg">{quadrant.title}</h2>
        </div>
        <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-fg-muted">{quadrant.subtitle}</div>
        <p className="mt-1 text-[11px] text-fg-muted">{quadrant.helper}</p>
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.id}
            draggable
            onDragStart={(e) => {
              setDraggingItemId(item.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", item.id);
            }}
            onDragEnd={() => setDraggingItemId(null)}
            className={`cursor-grab rounded-xl border border-black/[0.06] bg-white/90 p-3 transition-all active:cursor-grabbing ${
              draggingItemId === item.id ? "scale-[0.99] opacity-55" : ""
            }`}
          >
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={async () => {
                  await api.completeDailyItem(item.id);
                  await reload();
                }}
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-black/15 text-fg-muted hover:bg-emerald-50 hover:text-emerald-700"
                aria-label="Oznacz jako wykonane"
              >
                <Check size={13} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold leading-snug text-fg">{item.title}</div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-[9.5px] font-medium text-fg-muted">
                  <span className="rounded-full bg-sunk px-2 py-0.5">{formatDuration(item.minutes)}</span>
                  <span className="hidden rounded-full bg-sunk px-2 py-0.5 text-fg-subtle sm:inline">przeciągnij</span>
                  {item.schedule_enabled && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">Planner</span>}
                  {item.carried && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                      przeniesione {item.carry_days}d
                    </span>
                  )}
                </div>

                {item.needs_decision && (
                  <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5">
                    <div className="text-[10.5px] font-semibold text-amber-900">
                      To zadanie wraca już {item.carry_days} dni.
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={async () => {
                          await api.keepDailyItem(item.id, dateKey);
                          await reload();
                        }}
                        className="rounded-lg bg-white px-2.5 py-1.5 text-[10px] font-semibold text-amber-900 shadow-sm"
                      >
                        Nadal ważne
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const tomorrow = new Date(`${dateKey}T12:00:00`);
                          tomorrow.setDate(tomorrow.getDate() + 1);
                          await api.deferDailyItem(item.id, dateKeyFromDate(tomorrow));
                          await reload();
                        }}
                        className="rounded-lg bg-white px-2.5 py-1.5 text-[10px] font-semibold text-amber-900 shadow-sm"
                      >
                        Przełóż świadomie
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={async () => {
                  await api.cancelDailyItem(item.id);
                  await reload();
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-red-50 hover:text-red-600"
                aria-label="Usuń z Daily"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="mt-3 rounded-xl border border-black/[0.08] bg-white p-3">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Co trzeba zrobić?"
            className="w-full border-0 bg-transparent text-[12.5px] font-medium outline-none"
          />
          <div className="mt-3 flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-[10px] font-medium text-fg-muted">
              <Clock3 size={13} />
              <select
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="rounded-lg border bg-white px-2 py-1"
              >
                {[15, 30, 45, 60, 90, 120].map((value) => (
                  <option key={value} value={value}>{value} min</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setAdding(false)} className="rounded-lg px-2.5 py-1.5 text-[10.5px] font-semibold text-fg-muted">Anuluj</button>
              <button type="button" onClick={() => void submit()} className="rounded-lg bg-primary px-3 py-1.5 text-[10.5px] font-semibold text-white">Dodaj</button>
            </div>
          </div>
          <p className="mt-2 text-[9.5px] text-fg-subtle">
            {quadrant.schedule
              ? "To zadanie automatycznie trafi też do Plannera."
              : "Domyślnie nie zajmuje miejsca w kalendarzu."}
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-black/15 bg-white/50 py-2.5 text-[11px] font-semibold text-fg-muted hover:bg-white"
        >
          <CirclePlus size={14} /> Dodaj
        </button>
      )}
    </section>
  );
}

function ReviewView({
  data,
  saveReview,
}: {
  data: DailyData;
  saveReview: (review: DailyReview) => Promise<void>;
}) {
  const filled = REVIEW_FIELDS.filter((field) => data.review[field.key].trim()).length;

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-muted">🌙 Koniec dnia</div>
            <h2 className="mt-1 font-serif text-[22px] font-bold">Zamknij dzień, nie oceniaj siebie.</h2>
          </div>
          <span className="rounded-full bg-sunk px-3 py-1.5 text-[10.5px] font-semibold text-fg-muted">
            {filled}/6 odpowiedzi
          </span>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <MiniFact label="Wykonane bloki" value={`${data.summary.completed_blocks}/${data.summary.total_blocks}`} />
          <MiniFact label="Przechodzi dalej" value={String(data.summary.carry_over)} />
          <MiniFact label="Plan na rano" value={data.plan.first_step ? "gotowy" : "brak"} />
        </div>
      </section>

      {data.summary.carry_over > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
          <div className="flex items-start gap-3">
            <Lightbulb size={16} className="mt-0.5 shrink-0 text-amber-700" />
            <p className="text-[12px] leading-relaxed text-amber-900">
              {data.summary.carry_over} {data.summary.carry_over === 1 ? "zadanie przechodzi" : "zadania przechodzą"} na kolejny dzień.
              To dobry kontekst do odpowiedzi „co zrobiłbym inaczej?” — bez automatycznego pisania refleksji za Ciebie.
            </p>
          </div>
        </section>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {REVIEW_FIELDS.map((field) => (
          <ReviewCard
            key={field.key}
            field={field}
            value={data.review[field.key]}
            review={data.review}
            saveReview={saveReview}
          />
        ))}
      </div>
    </div>
  );
}

function ReviewCard({
  field,
  value,
  review,
  saveReview,
}: {
  field: (typeof REVIEW_FIELDS)[number];
  value: string;
  review: DailyReview;
  saveReview: (review: DailyReview) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-start gap-2">
        <span className="text-lg">{field.icon}</span>
        <h3 className="pt-0.5 text-[13px] font-bold text-fg">{field.label}</h3>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void saveReview({ ...review, [field.key]: draft })}
        rows={5}
        placeholder={field.placeholder}
        className="w-full resize-none rounded-xl border bg-sunk/25 px-3 py-2.5 text-[12.5px] leading-relaxed outline-none focus:ring-2 focus:ring-black/10"
      />
    </section>
  );
}

function HistoryView({
  currentDate,
  onOpenDay,
}: {
  currentDate: Date;
  onOpenDay: (date: Date) => void;
}) {
  const [history, setHistory] = useState<DailyHistoryEntry[]>([]);
  const [weekly, setWeekly] = useState<DailyWeekly | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([api.dailyHistory(), api.dailyWeekly(dateKey(currentDate))])
      .then(([nextHistory, nextWeekly]) => {
        if (!alive) return;
        setHistory(nextHistory);
        setWeekly(nextWeekly);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [currentDate]);

  if (loading) {
    return <div className="h-80 animate-pulse rounded-2xl bg-sunk" />;
  }

  return (
    <div className="space-y-5">
      {weekly && (
        <section className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <CalendarRange size={16} />
                <h2 className="text-[15px] font-bold">Tydzień w skrócie</h2>
              </div>
              <p className="mt-1 text-[11px] text-fg-muted">
                {new Date(`${weekly.start}T12:00:00`).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
                {" – "}
                {new Date(`${weekly.end}T12:00:00`).toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}
              </p>
            </div>
            {weekly.stale_items > 0 && (
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700">
                {weekly.stale_items} wymaga decyzji
              </span>
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniFact label="Dni zaplanowane" value={`${weekly.planned_days}/7`} />
            <MiniFact label="Dni z review" value={`${weekly.reviewed_days}/7`} />
            <MiniFact label="Zadania wykonane" value={`${weekly.items_completed}/${weekly.items_created}`} />
            <MiniFact label="Carry-over" value={String(weekly.carry_over)} />
          </div>

          <div className="mt-4 grid grid-cols-7 gap-1.5">
            {weekly.days.map((day) => {
              const active = day.planned || day.review_answers > 0 || day.items > 0;
              return (
                <button
                  key={day.date}
                  type="button"
                  onClick={() => onOpenDay(new Date(`${day.date}T12:00:00`))}
                  className={`rounded-xl border px-1 py-2 text-center ${
                    active ? "bg-sunk/60" : "bg-white text-fg-subtle"
                  }`}
                >
                  <div className="text-[9px] font-semibold uppercase text-fg-muted">
                    {new Date(`${day.date}T12:00:00`).toLocaleDateString("pl-PL", { weekday: "short" })}
                  </div>
                  <div className="tabular mt-1 text-[12px] font-bold">
                    {new Date(`${day.date}T12:00:00`).getDate()}
                  </div>
                  {day.review_answers > 0 && <div className="mx-auto mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                </button>
              );
            })}
          </div>

          {weekly.reflection_highlights.length > 0 && (
            <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/35 p-3">
              <div className="flex items-center gap-2 text-[11px] font-bold text-indigo-900">
                <Brain size={14} />
                Wnioski z tygodnia
              </div>
              <div className="mt-2 space-y-2">
                {weekly.reflection_highlights.slice(0, 4).map((item) => (
                  <div key={`${item.date}-${item.kind}-${item.text}`} className="text-[11px] leading-relaxed text-indigo-950/80">
                    <span className="mr-2 font-semibold">
                      {item.kind === "learned" ? "Lekcja:" : "Jutro:"}
                    </span>
                    {item.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <History size={16} />
          <h2 className="text-[15px] font-bold">Historia Daily</h2>
        </div>

        {history.length === 0 ? (
          <p className="rounded-xl bg-sunk/40 p-5 text-center text-[12px] text-fg-muted">
            Historia zacznie się budować wraz z kolejnymi dniami.
          </p>
        ) : (
          <div className="divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.06]">
            {history.map((entry) => (
              <button
                key={entry.date}
                type="button"
                onClick={() => onOpenDay(new Date(`${entry.date}T12:00:00`))}
                className="flex w-full items-center gap-3 bg-white px-3 py-3 text-left hover:bg-sunk/35"
              >
                <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-sunk">
                  <span className="text-[9px] font-semibold uppercase text-fg-muted">
                    {new Date(`${entry.date}T12:00:00`).toLocaleDateString("pl-PL", { month: "short" })}
                  </span>
                  <span className="tabular text-[14px] font-bold">
                    {new Date(`${entry.date}T12:00:00`).getDate()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold">
                    {entry.win_condition || entry.first_step || "Daily"}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[9.5px] text-fg-muted">
                    <span>{entry.completed_items}/{entry.items} zadań</span>
                    <span>·</span>
                    <span>{entry.review_answers}/6 review</span>
                  </div>
                </div>
                <ChevronRight size={15} className="shrink-0 text-fg-subtle" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


function MiniFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-sunk/55 px-3 py-2.5">
      <div className="tabular text-[15px] font-bold text-fg">{value}</div>
      <div className="mt-0.5 text-[9.5px] font-medium text-fg-muted">{label}</div>
    </div>
  );
}
