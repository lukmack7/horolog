"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Grid } from "@/app/components/Grid";
import { Glyph, KIND_LABEL } from "@/app/components/Glyph";
import { Shell } from "@/app/components/Shell";
import { Skeleton } from "@/app/components/Skeleton";
import { api, formatDuration, minutesBetween, type DailyData, type IntentKind, type Plan } from "@/app/lib/api";
import { ArrowRight, Sunrise, Target } from "lucide-react";
import Link from "next/link";

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Live "today" view: a single-day timeline with a moving now-line, plus
 *  what's in progress and what's next. Complements Planner (week grid) and
 *  Analytics (aggregate stats) rather than duplicating either. */
export default function TimePage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [daily, setDaily] = useState<DailyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      const now = new Date();
      const [nextPlan, nextDaily] = await Promise.all([
        api.plan(),
        api.daily(localDateKey(now)),
      ]);
      setPlan(nextPlan);
      setDaily(nextDaily);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the schedule.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // `now` (not a frozen mount-time snapshot) so the day key rolls over if the
  // tab is left open past midnight instead of filtering forever for a stale day.
  const todayKey = now.toISOString().slice(0, 10);

  const todaysBlocks = useMemo(
    () => (plan ? plan.blocks.filter((b) => dayKey(b.start) === todayKey) : []),
    [plan, todayKey],
  );

  // Blocks come back with the server's local UTC offset (e.g. `-05:00`), not
  // necessarily `Z` — comparing those strings against now.toISOString()
  // (always `Z`) lexicographically does not agree with chronological order.
  // Parse both sides to epoch ms instead.
  const nowMs = now.getTime();
  const current = todaysBlocks.find((b) => Date.parse(b.start) <= nowMs && nowMs < Date.parse(b.end));
  const next = todaysBlocks
    .filter((b) => Date.parse(b.start) > nowMs)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[1440px] overflow-x-hidden px-4 py-5 sm:px-6 sm:py-8">
        <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-bold text-fg">Time</h1>
            <p className="mt-1 text-[13.5px] text-fg-muted">
              {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            </p>
          </div>
          <div className="tabular text-[32px] font-semibold leading-none text-fg">
            {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
          </div>
        </header>

        {error && (
          <div className="mb-6 rounded-card border border-red-200 bg-red-50/70 p-4 text-[13.5px] text-danger shadow-xs">
            {error}
          </div>
        )}

        {daily && (daily.plan.first_step || daily.plan.win_condition) && (
          <section className="mb-5 grid gap-3 lg:grid-cols-[1.2fr_.8fr]">
            {daily.plan.first_step && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/55 p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-amber-700 shadow-sm">
                    <Sunrise size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-700">Start here</div>
                    <div className="mt-1 text-[14px] font-semibold leading-relaxed text-fg">{daily.plan.first_step}</div>
                    <Link href="/daily" className="mt-2 inline-flex text-[10.5px] font-semibold text-amber-800 hover:underline">
                      Otwórz Daily →
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {daily.plan.win_condition && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/45 p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-700 shadow-sm">
                    <Target size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">Dzisiaj wygrywam, jeśli</div>
                    <div className="mt-1 text-[13px] font-semibold leading-relaxed text-fg">{daily.plan.win_condition}</div>
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        <div className="mb-7 grid gap-4 sm:grid-cols-2">
          <StatusCard
            label="Right now"
            block={current}
            empty="Nothing scheduled — this time is open."
            loading={!plan}
          />
          <StatusCard
            label="Up next"
            block={next}
            empty="Nothing else scheduled for today."
            untilNow={now}
            loading={!plan}
          />
        </div>

        <Grid
          days={[now]}
          blocks={plan?.blocks ?? []}
          busy={plan?.busy ?? []}
          selected={selected}
          onSelect={setSelected}
        />
      </main>
    </Shell>
  );
}

function StatusCard({
  label,
  block,
  empty,
  untilNow,
  loading = false,
}: {
  label: string;
  block: { title: string; kind: IntentKind; priority: number; start: string; end: string } | undefined;
  empty: string;
  untilNow?: Date;
  loading?: boolean;
}) {
  return (
    <div className="rounded-card border border-black/[0.08] bg-surface p-5 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">{label}</div>
      {loading ? (
        <div aria-hidden className="mt-2 flex items-center gap-2.5">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ) : block ? (
        <div className="mt-2 flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sunk text-fg">
            <Glyph kind={block.kind} size={15} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-fg">{block.title}</div>
            <div className="tabular mt-0.5 flex items-center gap-1.5 text-[12px] text-fg-muted">
              <span>{KIND_LABEL[block.kind]}</span>
              <span>·</span>
              <span>
                {new Date(block.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                <ArrowRight size={10} className="mx-1 inline align-middle" />
                {new Date(block.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
              {untilNow && (
                <>
                  <span>·</span>
                  <span>in {formatDuration(minutesBetween(untilNow.toISOString(), block.start))}</span>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-2.5 text-[13.5px] text-fg-muted">{empty}</p>
      )}
    </div>
  );
}
