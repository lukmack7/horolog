"use client";

import { useLanguage } from "@/app/components/LanguageProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Glyph } from "@/app/components/Glyph";
import { PriorityPicker } from "@/app/components/PriorityPicker";
import { Shell } from "@/app/components/Shell";
import { Skeleton } from "@/app/components/Skeleton";
import {
  PRIORITY_TINT,
  api,
  createIntent,
  formatDuration,
  type EnergyLevel,
  type Intent,
  type IntentKind,
  type Plan,
  type Priority,
} from "@/app/lib/api";
import { Plus, Trash2, Pencil, X, RotateCcw, AlertTriangle, Sparkles, Clock, Zap } from "lucide-react";

/** Focus needs a >=90m minimum sitting (see docs/ARCHITECTURE.md's model
 *  table: `kind=focus, weekly, >=90m chunks`), enforced with a floor rather
 *  than by mutating the visible Duration input the user is controlling. */
const FOCUS_MIN_CHUNK = 90;

const PRESETS = [
  { title: "Gym", kind: "habit", times: 3, weeklyHours: 5, minutes: 60, from: 600, to: 960, priority: 4 },
  { title: "Deep work", kind: "focus", times: 5, weeklyHours: 10, minutes: 120, from: 540, to: 720, priority: 2 },
  { title: "Lunch", kind: "habit", times: 5, weeklyHours: 5, minutes: 45, from: 720, to: 840, priority: 3 },
  { title: "Inbox & admin", kind: "habit", times: 5, weeklyHours: 5, minutes: 30, from: 960, to: 1080, priority: 4 },
] as const;

const WEEKDAYS = [
  { label: "Mon", value: 0 },
  { label: "Tue", value: 1 },
  { label: "Wed", value: 2 },
  { label: "Thu", value: 3 },
  { label: "Fri", value: 4 },
  { label: "Sat", value: 5 },
  { label: "Sun", value: 6 },
] as const;

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function toMinutes(value: string): number {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/** Ultra-Luxury Habit Builder & Routine Manager.
 *  Allows configuring recurring routines in natural human terms.
 */
export default function Habits() {
  const { t, language } = useLanguage();
  const [intents, setIntents] = useState<Intent[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<IntentKind>("habit");
  const [times, setTimes] = useState(3);
  const [weeklyHours, setWeeklyHours] = useState(5);
  const [minutes, setMinutes] = useState(60);
  const [from, setFrom] = useState(600);
  const [to, setTo] = useState(960);
  const [priority, setPriority] = useState<Priority>(4);
  const [energy, setEnergy] = useState<EnergyLevel | "">("");
  const [selectedDays, setSelectedDays] = useState<number[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [i, p] = await Promise.all([api.intents(), api.plan()]);
      setIntents(i);
      setPlan(p);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the scheduler.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const habits = useMemo(
    () => intents.filter((i) => i.period_days !== null),
    [intents],
  );

  const chunkMinutes = kind === "focus" ? Math.max(minutes, FOCUS_MIN_CHUNK) : minutes;
  const windowTooSmall = to - from < chunkMinutes;

  function resetForm() {
    setEditingId(null);
    setTitle("");
    setKind("habit");
    setTimes(3);
    setWeeklyHours(5);
    setMinutes(60);
    setFrom(600);
    setTo(960);
    setPriority(4);
    setEnergy("");
    setSelectedDays([]);
  }

  function editHabit(habit: Intent) {
    const window = habit.daily_windows?.[0];

    setEditingId(habit.id);
    setTitle(habit.title);
    setKind(habit.kind);
    setMinutes(habit.min_chunk_minutes);
    setPriority(habit.priority);
    setEnergy(habit.energy ?? "");
    setSelectedDays(habit.allowed_weekdays ?? []);
    setFrom(window?.start_min ?? 600);
    setTo(window?.end_min ?? 960);

    if (habit.kind === "focus") {
      setWeeklyHours(Math.max(1, Math.round(habit.minutes_per_period / 60)));
    } else {
      setTimes(
        Math.max(
          1,
          Math.round(habit.minutes_per_period / habit.min_chunk_minutes),
        ),
      );
    }

    requestAnimationFrame(() => {
      document.getElementById("habit-title")?.focus();
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || windowTooSmall || saving) return;
    setSaving(true);
    setError(null);

    const payload = {
      title: title.trim(),
      kind,
      priority,
      energy: energy || undefined,
      minutes_per_period: kind === "focus" ? weeklyHours * 60 : times * minutes,
      period_days: 7,
      min_chunk_minutes: chunkMinutes,
      max_chunk_minutes: chunkMinutes,
      max_per_day: kind === "focus" ? undefined : 1,
      allowed_weekdays: selectedDays,
      window_start_min: from,
      window_end_min: to,
    };

    try {
      if (editingId) {
        await api.update(editingId, payload);
      } else {
        await createIntent(payload);
      }

      resetForm();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save that routine.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[920px] px-6 py-8">
        <header className="mb-8">
          <h1 className="text-[28px] font-bold text-fg">{t("Habits & Focus Time")}</h1>
          <p className="mt-1 text-[13.5px] text-fg-muted">
            {t("Recurring commitments placed around real calendar events and moved automatically when meetings land.")}
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-card border border-red-200 bg-red-50/70 p-4 text-[13.5px] text-danger shadow-xs">
            {error}
          </div>
        )}

        {/* Habit Creation Form */}
        <form
          onSubmit={save}
          className="mb-9 overflow-hidden rounded-card border border-black/[0.08] bg-surface shadow-sm transition-shadow hover:shadow-md"
        >
          <div className="border-b border-black/[0.06] px-6 py-4.5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor="habit-title" className="block text-[12px] font-semibold tracking-wider uppercase text-fg-muted">
                {t("Routine Title")}
              </label>
              <div className="flex items-center gap-1 rounded-lg bg-sunk/60 p-0.5">
                {(["habit", "focus"] as const).map((k) => (
                  <button
                    key={t(k === "habit" ? "Habit" : "Focus")}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => {
                      setKind(k);
                      // Keep the Duration select on a value its own option
                      // list actually contains when switching modes by hand.
                      setMinutes(k === "focus" ? Math.max(FOCUS_MIN_CHUNK, minutes) : Math.min(120, minutes));
                    }}
                    className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold capitalize transition-all duration-150 ${
                      kind === k ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            <input
              id="habit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("Gym, deep work, lunch...")}
              className="h-11 w-full rounded-xl border border-black/[0.08] bg-bg px-4 text-[15px] font-medium outline-none transition-colors focus:border-accent"
            />
            {/* Quick Presets */}
            <div className="mt-3 flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={t(preset.title)}
                  type="button"
                  onClick={() => {
                    setTitle(preset.title);
                    setKind(preset.kind);
                    setTimes(preset.times);
                    setWeeklyHours(preset.weeklyHours);
                    setMinutes(preset.minutes);
                    setFrom(preset.from);
                    setTo(preset.to);
                    setPriority(preset.priority as Priority);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-bg px-3 py-1 text-[12px] font-medium text-fg-muted transition-all duration-150 hover:border-accent hover:bg-secondary/50 hover:text-accent"
                >
                  <Sparkles size={12} className="text-accent" />
                  {preset.title}
                </button>
              ))}
            </div>
          </div>

          <div className="border-b border-black/[0.06] px-6 py-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-fg-muted">
                {t("Days")} <span className="font-normal text-fg-subtle">· {t("optional fixed days")}</span>
              </span>
              {selectedDays.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedDays([])}
                  className="text-[11px] font-medium text-fg-subtle hover:text-fg"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => {
                const selected = selectedDays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      const next = selected
                        ? selectedDays.filter((value) => value !== day.value)
                        : [...selectedDays, day.value].sort((a, b) => a - b);

                      setSelectedDays(next);
                      if (next.length > 0 && kind === "habit") {
                        setTimes(next.length);
                      }
                    }}
                    className={`min-w-11 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-all ${
                      selected
                        ? "border-accent bg-accent text-on-accent shadow-sm"
                        : "border-black/[0.08] bg-bg text-fg-muted hover:border-accent hover:text-accent"
                    }`}
                  >
                    {t(day.label)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-5 px-6 py-5 sm:grid-cols-2 lg:grid-cols-4">
            {kind === "focus" ? (
              <Field label="Hours per week" hint="weekly target">
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={weeklyHours}
                  onChange={(e) => setWeeklyHours(Math.max(1, Number(e.target.value)))}
                  className="tabular h-10 w-full rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
                />
              </Field>
            ) : (
              <Field label="Frequency" hint="times / week">
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={times}
                  onChange={(e) => setTimes(Math.max(1, Number(e.target.value)))}
                  className="tabular h-10 w-full rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
                />
              </Field>
            )}
            <Field
              label={kind === "focus" ? "Max sitting" : "Duration"}
              hint={kind === "focus" ? `per sitting, min ${FOCUS_MIN_CHUNK}` : "per session"}
            >
              <select
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="tabular h-10 w-full rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
              >
                {(kind === "focus" ? [90, 120, 150, 180] : [15, 30, 45, 60, 90, 120]).map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Earliest" hint="window start">
              <input
                type="time"
                value={clock(from)}
                onChange={(e) => setFrom(toMinutes(e.target.value))}
                className="tabular h-10 w-full rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
              />
            </Field>
            <Field label="Latest" hint="window end">
              <input
                type="time"
                value={clock(to)}
                onChange={(e) => setTo(toMinutes(e.target.value))}
                className="tabular h-10 w-full rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-black/[0.06] bg-sunk/40 px-6 py-3.5">
            <div className="flex items-center gap-1.5">
              <PriorityPicker value={priority} onChange={setPriority} />
              <span className="mx-1 h-4 w-px bg-black/[0.08]" aria-hidden />
              {(["high", "medium", "low"] as const).map((level) => (
                <button
                  key={t(`${level.charAt(0).toUpperCase()}${level.slice(1)} energy`)}
                  type="button"
                  onClick={() => setEnergy(energy === level ? "" : level)}
                  aria-pressed={energy === level}
                  title={t(`${level.charAt(0).toUpperCase()}${level.slice(1)} energy`)}
                  className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold capitalize transition-all duration-150 ${
                    energy === level ? "bg-surface shadow-sm border border-black/[0.08] text-fg" : "text-fg-muted hover:bg-surface/60"
                  }`}
                >
                  <Zap size={12} className={energy === level ? "text-accent" : ""} />
                  {level}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  disabled={saving}
                  className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-black/[0.08] bg-surface px-4 text-[13px] font-semibold text-fg-muted transition-all hover:bg-bg hover:text-fg disabled:opacity-40"
                >
                  <X size={15} />
                  Cancel
                </button>
              )}

              <button
                type="submit"
                disabled={!title.trim() || windowTooSmall || saving}
                className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-accent px-5 text-[13.5px] font-semibold text-on-accent shadow-sm transition-all duration-150 hover:bg-accent-hover hover:shadow-md disabled:opacity-40"
              >
                {editingId ? <Pencil size={15} /> : <Plus size={16} />}
                {saving
                  ? editingId
                    ? t("Saving...")
                    : t("Scheduling...")
                  : editingId
                    ? t("Save Changes")
                    : t("Add Routine")}
              </button>
            </div>
          </div>

          {windowTooSmall && (
            <div className="flex items-center gap-2 border-t border-red-200 bg-red-50/70 px-6 py-3 text-[12.5px] font-medium text-danger">
              <AlertTriangle size={15} />
              <span>
                Window ({formatDuration(Math.max(0, to - from))}) is shorter than session duration ({formatDuration(minutes)}).
              </span>
            </div>
          )}
        </form>

        <h2 className="mb-3.5 text-[12px] font-semibold tracking-wider uppercase text-fg-muted">
          {t("Active Routines")} {plan ? `(${habits.length})` : ""}
        </h2>

        {!plan ? (
          <ul aria-hidden className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <li
                key={i}
                className="flex items-center gap-4 rounded-card border border-black/[0.06] bg-surface p-4.5 shadow-sm"
              >
                <Skeleton className="h-10 w-1 shrink-0 rounded-full" />
                <Skeleton className="h-[18px] w-[18px] shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </li>
            ))}
          </ul>
        ) : habits.length === 0 ? (
          <div className="rounded-card border border-black/[0.06] bg-surface p-10 text-center shadow-sm">
            <p className="text-[14px] font-semibold text-fg">{t("No active routines")}</p>
            <p className="mt-1 text-[13px] text-fg-muted">{t("Configure a habit above or use ⌘K to describe it.")}</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {habits.map((habit) => {
              const blocks = plan?.blocks.filter((b) => b.intent_id === habit.id) ?? [];
              const fixed = habit.min_chunk_minutes === habit.max_chunk_minutes;
              const cadence = fixed
                ? `${Math.round(habit.minutes_per_period / habit.min_chunk_minutes)}× weekly · ${formatDuration(habit.min_chunk_minutes)} each`
                : `${formatDuration(habit.minutes_per_period)} weekly · ${formatDuration(habit.min_chunk_minutes)}–${formatDuration(habit.max_chunk_minutes)} blocks`;

              const weekdayLabel =
                habit.allowed_weekdays && habit.allowed_weekdays.length > 0
                  ? habit.allowed_weekdays
                      .map((value) => WEEKDAYS.find((day) => day.value === value)?.label)
                      .filter(Boolean)
                      .join(" · ")
                  : null;
              return (
                <li
                  key={habit.id}
                  className="group flex items-center gap-4 rounded-card border border-black/[0.06] bg-surface p-4.5 shadow-sm transition-all duration-200 hover:shadow-md"
                >
                  <span
                    className="h-10 w-1 shrink-0 rounded-full"
                    style={{ background: PRIORITY_TINT[habit.priority as Priority] }}
                    aria-hidden
                  />
                  <span className="shrink-0 text-accent">
                    <Glyph kind={habit.kind} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-fg">{habit.title}</div>
                    <div className="tabular mt-1 text-[12.5px] font-medium text-fg-muted">
                      {cadence} · <span className="text-accent font-semibold">{blocks.length} placed</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => editHabit(habit)}
                      aria-label={`Edit ${habit.title}`}
                      title={t("Edit routine")}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle opacity-0 transition-all duration-150 hover:bg-secondary hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Pencil size={15} />
                    </button>

                    <button
                      type="button"
                      onClick={async () => {
                        await api.remove(habit.id);
                        if (editingId === habit.id) resetForm();
                        await load();
                      }}
                      aria-label={`Remove ${habit.title}`}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle opacity-0 transition-all duration-150 hover:bg-red-50 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </Shell>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-fg-muted">
        {label} <span className="font-normal text-fg-subtle">· {hint}</span>
      </span>
      {children}
    </label>
  );
}
