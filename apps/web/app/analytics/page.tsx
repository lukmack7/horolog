"use client";

import { useLanguage } from "@/app/components/LanguageProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Shell } from "@/app/components/Shell";
import { Skeleton } from "@/app/components/Skeleton";
import {
  analytics,
  api,
  formatDuration,
  minutesBetween,
  PRIORITY_NAME,
  PRIORITY_TINT,
  type Analytics,
  type Block,
  type IntentKind,
  type Plan,
  type Priority,
} from "@/app/lib/api";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock,
  Flag,
  LayoutDashboard,
  Lightbulb,
  Sparkles,
  Target,
  TimerReset,
  Users,
} from "lucide-react";

type AnalyticsView = "overview" | "priorities" | "map" | "executive";

const VIEWS: { id: AnalyticsView; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "priorities", label: "Priorities", icon: Flag },
  { id: "map", label: "Week map", icon: CalendarDays },
  { id: "executive", label: "Executive", icon: Sparkles },
];

const KIND_COLOR: Record<IntentKind, string> = {
  task: "#2563eb",
  habit: "#16a34a",
  focus: "#7c3aed",
  meeting: "#f97316",
  buffer: "#94a3b8",
};

const KIND_LABEL: Record<IntentKind, string> = {
  task: "Task",
  habit: "Habit",
  focus: "Focus",
  meeting: "Meeting",
  buffer: "Buffer",
};

const KIND_ORDER: IntentKind[] = ["task", "focus", "habit", "meeting", "buffer"];
const PRIORITIES: Priority[] = [1, 2, 3, 4];

type WeekDay = {
  date: Date;
  key: string;
  label: string;
  short: string;
};

type Derived = {
  week: WeekDay[];
  kindMinutes: Record<IntentKind, number>;
  priorityMinutes: Record<Priority, number>;
  dayKind: Array<Record<IntentKind, number>>;
  dayPriority: Array<Record<Priority, number>>;
  totalBlockMinutes: number;
  totalVisibleMinutes: number;
  highPriorityShare: number;
  completedBlocks: number;
  totalBlocks: number;
};

function localDateKey(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function blankKindRecord(): Record<IntentKind, number> {
  return { task: 0, habit: 0, focus: 0, meeting: 0, buffer: 0 };
}

function blankPriorityRecord(): Record<Priority, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0 };
}

function buildDerived(plan: Plan): Derived {
  const start = new Date(plan.origin);
  start.setHours(0, 0, 0, 0);

  const week: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return {
      date,
      key: localDateKey(date),
      label: date.toLocaleDateString("en-US", { weekday: "short" }),
      short: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
  });

  const kindMinutes = blankKindRecord();
  const priorityMinutes = blankPriorityRecord();
  const dayKind = week.map(() => blankKindRecord());
  const dayPriority = week.map(() => blankPriorityRecord());

  let totalBlockMinutes = 0;
  let completedBlocks = 0;

  for (const block of plan.blocks) {
    const minutes = Math.max(0, minutesBetween(block.start, block.end));
    totalBlockMinutes += minutes;
    kindMinutes[block.kind] += minutes;
    priorityMinutes[block.priority] += minutes;
    if (block.completed) completedBlocks += 1;

    const index = week.findIndex((day) => day.key === localDateKey(new Date(block.start)));
    if (index >= 0) {
      dayKind[index]![block.kind] += minutes;
      dayPriority[index]![block.priority] += minutes;
    }
  }

  let externalMeetingMinutes = 0;
  for (const event of plan.busy) {
    const minutes = Math.max(0, minutesBetween(event.start, event.end));
    externalMeetingMinutes += minutes;
    kindMinutes.meeting += minutes;
    const index = week.findIndex((day) => day.key === localDateKey(new Date(event.start)));
    if (index >= 0) dayKind[index]!.meeting += minutes;
  }

  const highPriorityMinutes = priorityMinutes[1] + priorityMinutes[2];

  return {
    week,
    kindMinutes,
    priorityMinutes,
    dayKind,
    dayPriority,
    totalBlockMinutes,
    totalVisibleMinutes: totalBlockMinutes + externalMeetingMinutes,
    highPriorityShare: totalBlockMinutes > 0 ? highPriorityMinutes / totalBlockMinutes : 0,
    completedBlocks,
    totalBlocks: plan.blocks.length,
  };
}

export default function AnalyticsPage() {
  const { t, language } = useLanguage();
  const [data, setData] = useState<Analytics | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [view, setView] = useState<AnalyticsView>("overview");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextData, nextPlan] = await Promise.all([analytics.get(), api.plan()]);
      setData(nextData);
      setPlan(nextPlan);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load analytics.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const derived = useMemo(() => (plan ? buildDerived(plan) : null), [plan]);

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[1180px] overflow-x-hidden px-4 py-5 sm:px-6 sm:py-8">
        <header className="mb-5 sm:mb-7">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[30px] font-bold leading-tight text-fg sm:text-[28px]">
                Productivity Analytics
              </h1>
              <p className="mt-1 text-[13px] text-fg-muted sm:text-[13.5px]">
                {data ? `Measured across your ${data.horizon_days}-day planning horizon` : "Reading the plan..."}
              </p>
            </div>
            {plan && (
              <div className="hidden rounded-full bg-sunk px-3 py-1.5 text-[11px] font-semibold text-fg-muted sm:block">
                {derived?.totalBlocks ?? 0} blocks · {formatDuration(derived?.totalVisibleMinutes ?? 0)}
              </div>
            )}
          </div>

          <AnalyticsTabs view={view} onChange={setView} />
        </header>

        {error && (
          <div className="mb-6 rounded-card border border-red-200 bg-red-50/70 p-4 text-[13.5px] text-danger shadow-xs">
            {error}
          </div>
        )}

        {(!data || !plan || !derived) && !error && <AnalyticsSkeleton />}

        {data && plan && derived && (
          <>
            {view === "overview" && <OverviewView data={data} plan={plan} derived={derived} />}
            {view === "priorities" && <PrioritiesView data={data} derived={derived} />}
            {view === "map" && <WeekMapView data={data} plan={plan} derived={derived} />}
            {view === "executive" && <ExecutiveView data={data} derived={derived} />}
          </>
        )}
      </main>
    </Shell>
  );
}

function AnalyticsTabs({
  view,
  onChange,
}: {
  view: AnalyticsView;
  onChange: (view: AnalyticsView) => void;
}) {
  return (
    <div className="mt-5 grid grid-cols-4 gap-1 rounded-2xl border border-black/[0.08] bg-surface p-1 shadow-sm">
      {VIEWS.map((item) => {
        const Icon = item.icon;
        const active = item.id === view;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-1.5 text-[10px] font-semibold transition-all sm:text-[12.5px] ${
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-fg-muted hover:bg-sunk hover:text-fg"
            }`}
          >
            <Icon size={15} />
            <span className="hidden xs:inline sm:inline">{item.label}</span>
            <span className="sm:hidden">{item.id === "priorities" ? "Priority" : item.id === "executive" ? "Exec" : item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function OverviewView({
  data,
  plan,
  derived,
}: {
  data: Analytics;
  plan: Plan;
  derived: Derived;
}) {
  return (
    <div className="space-y-5 sm:space-y-6">
      <KpiGrid
        items={[
          {
            value: formatDuration(data.scheduled_minutes),
            label: "Scheduled work",
            note: `${Math.round((data.scheduled_minutes / Math.max(1, data.horizon_days * data.window_minutes_per_day)) * 100)}% of working capacity`,
            accent: "#2563eb",
          },
          {
            value: formatDuration(data.focus_minutes),
            label: "Deep-work time",
            note: data.scheduled_minutes > 0 ? `${Math.round((data.focus_minutes / data.scheduled_minutes) * 100)}% of scheduled work` : "No scheduled work",
            accent: "#7c3aed",
          },
          {
            value: `${Math.round(data.meeting_load * 100)}%`,
            label: "Meeting load",
            note: `${formatDuration(data.meeting_minutes)} across the horizon`,
            accent: "#f97316",
            warn: data.meeting_load > 0.4,
          },
          {
            value: `${Math.round(derived.highPriorityShare * 100)}%`,
            label: "High priority",
            note: "P1 + P2 share of planned work",
            accent: "#dc2626",
          },
        ]}
      />

      <SectionCard>
        <SectionHeading
          title="Time per day"
          subtitle="The next seven days, stacked by work type."
          right={<MiniLegend entries={KIND_ORDER.map((kind) => ({ label: KIND_LABEL[kind], color: KIND_COLOR[kind] }))} />}
        />
        <StackedDayChart week={derived.week} rows={derived.dayKind} mode="kind" />
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard>
          <SectionHeading title="Time by type" subtitle="What your plan is made of." />
          <DistributionRows
            rows={KIND_ORDER.map((kind) => ({
              label: KIND_LABEL[kind],
              minutes: derived.kindMinutes[kind],
              color: KIND_COLOR[kind],
            }))}
          />
        </SectionCard>

        <SectionCard>
          <SectionHeading title="Time by priority" subtitle="How much time your important work receives." />
          <DistributionRows
            rows={PRIORITIES.map((priority) => ({
              label: `P${priority} · ${PRIORITY_NAME[priority]}`,
              minutes: derived.priorityMinutes[priority],
              color: PRIORITY_TINT[priority],
            }))}
          />
        </SectionCard>
      </div>

      <InsightStrip data={data} derived={derived} plan={plan} />
    </div>
  );
}

function PrioritiesView({ data, derived }: { data: Analytics; derived: Derived }) {
  const maxCell = Math.max(
    1,
    ...derived.dayPriority.flatMap((row) => PRIORITIES.map((priority) => row[priority])),
  );

  return (
    <div className="space-y-5 sm:space-y-6">
      <KpiGrid
        items={[
          {
            value: `${Math.round(derived.highPriorityShare * 100)}%`,
            label: "High-priority share",
            note: "P1 + P2 of planned work",
            accent: "#dc2626",
          },
          {
            value: formatDuration(derived.priorityMinutes[1]),
            label: "Critical work",
            note: "P1 scheduled time",
            accent: PRIORITY_TINT[1],
          },
          {
            value: formatDuration(derived.priorityMinutes[2]),
            label: "High-priority work",
            note: "P2 scheduled time",
            accent: PRIORITY_TINT[2],
          },
          {
            value: data.unmet_minutes > 0 ? formatDuration(data.unmet_minutes) : "0m",
            label: "Unmet demand",
            note: data.unmet_minutes > 0 ? "Could not be placed" : "All demand placed",
            accent: data.unmet_minutes > 0 ? "#dc2626" : "#16a34a",
            warn: data.unmet_minutes > 0,
          },
        ]}
      />

      <SectionCard>
        <SectionHeading
          title="Priority heatmap"
          subtitle="Minutes scheduled by priority across the next seven days."
        />
        <div className="mt-5 grid grid-cols-[54px_repeat(7,minmax(0,1fr))] gap-1.5 sm:gap-2">
          <div />
          {derived.week.map((day) => (
            <div key={day.key} className="text-center">
              <div className="text-[10px] font-semibold text-fg-muted">{day.label}</div>
              <div className="hidden text-[9px] text-fg-subtle sm:block">{day.short}</div>
            </div>
          ))}
          {PRIORITIES.map((priority) => (
            <>
              <div key={`label-${priority}`} className="flex items-center gap-1.5 pr-1 text-[11px] font-bold">
                <span className="h-2.5 w-1 rounded-full" style={{ background: PRIORITY_TINT[priority] }} />
                P{priority}
              </div>
              {derived.dayPriority.map((row, index) => {
                const minutes = row[priority];
                const opacity = minutes === 0 ? 0.045 : 0.16 + (minutes / maxCell) * 0.72;
                return (
                  <div
                    key={`${priority}-${index}`}
                    className="flex h-11 items-center justify-center rounded-lg border border-black/[0.04] text-[9px] font-semibold sm:h-12 sm:text-[10px]"
                    style={{
                      background: `color-mix(in srgb, ${PRIORITY_TINT[priority]} ${Math.round(opacity * 100)}%, white)`,
                      color: minutes > maxCell * 0.55 ? "#ffffff" : "#292524",
                    }}
                    title={`${derived.week[index]!.label}: ${formatDuration(minutes)}`}
                  >
                    {minutes > 0 ? formatDuration(minutes) : "—"}
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <SectionCard>
          <SectionHeading title="Priority mix by day" subtitle="Daily workload split across P1–P4." />
          <StackedDayChart week={derived.week} rows={derived.dayPriority} mode="priority" />
        </SectionCard>

        <SectionCard>
          <SectionHeading title="Priority coverage" subtitle="Share of all scheduled work." />
          <DistributionRows
            rows={PRIORITIES.map((priority) => ({
              label: `P${priority} · ${PRIORITY_NAME[priority]}`,
              minutes: derived.priorityMinutes[priority],
              color: PRIORITY_TINT[priority],
            }))}
          />
        </SectionCard>
      </div>
    </div>
  );
}

function WeekMapView({
  data,
  plan,
  derived,
}: {
  data: Analytics;
  plan: Plan;
  derived: Derived;
}) {
  const startHour = 7;
  const endHour = 21;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  const cells = derived.week.map((day) =>
    hours.map((hour) => {
      const totals = blankKindRecord();

      for (const block of plan.blocks) {
        const start = new Date(block.start);
        if (localDateKey(start) !== day.key || start.getHours() !== hour) continue;
        totals[block.kind] += minutesBetween(block.start, block.end);
      }
      for (const event of plan.busy) {
        const start = new Date(event.start);
        if (localDateKey(start) !== day.key || start.getHours() !== hour) continue;
        totals.meeting += minutesBetween(event.start, event.end);
      }

      const dominant = KIND_ORDER.reduce<IntentKind | null>((best, kind) => {
        if (!best) return totals[kind] > 0 ? kind : null;
        return totals[kind] > totals[best] ? kind : best;
      }, null);
      const minutes = KIND_ORDER.reduce((sum, kind) => sum + totals[kind], 0);
      return { dominant, minutes };
    }),
  );

  return (
    <div className="space-y-5 sm:space-y-6">
      <KpiGrid
        items={[
          {
            value: formatDuration(derived.totalVisibleMinutes),
            label: "Visible workload",
            note: "Scheduled work + calendar commitments",
            accent: "#2563eb",
          },
          {
            value: formatDuration(data.focus_minutes),
            label: "Deep work",
            note: "Long uninterrupted blocks",
            accent: "#7c3aed",
          },
          {
            value: formatDuration(data.fragmentation),
            label: "Average block",
            note: "Longer blocks mean less switching",
            accent: "#16a34a",
          },
          {
            value: String(derived.totalBlocks),
            label: "Planned blocks",
            note: "Across the planning horizon",
            accent: "#0c0a09",
          },
        ]}
      />

      <SectionCard>
        <SectionHeading
          title="Weekly time map"
          subtitle="A compact heatmap of what occupies each part of the day."
          right={<MiniLegend entries={KIND_ORDER.map((kind) => ({ label: KIND_LABEL[kind], color: KIND_COLOR[kind] }))} />}
        />

        <div className="mt-5 grid grid-cols-[34px_repeat(7,minmax(0,1fr))] gap-[3px] sm:grid-cols-[46px_repeat(7,minmax(0,1fr))] sm:gap-1">
          <div />
          {derived.week.map((day) => (
            <div key={day.key} className="pb-1 text-center text-[9px] font-semibold text-fg-muted sm:text-[10px]">
              {day.label}
            </div>
          ))}

          {hours.map((hour, hourIndex) => (
            <>
              <div key={`hour-${hour}`} className="flex items-center justify-end pr-1 text-[8px] font-medium text-fg-subtle sm:pr-2 sm:text-[9px]">
                {hour}:00
              </div>
              {derived.week.map((day, dayIndex) => {
                const cell = cells[dayIndex]![hourIndex]!;
                const intensity = Math.min(1, cell.minutes / 60);
                return (
                  <div
                    key={`${day.key}-${hour}`}
                    className="h-6 rounded-[5px] border border-black/[0.035] sm:h-7 sm:rounded-md"
                    style={{
                      background: cell.dominant
                        ? `color-mix(in srgb, ${KIND_COLOR[cell.dominant]} ${Math.round(32 + intensity * 58)}%, white)`
                        : "#f5f5f4",
                    }}
                    title={cell.dominant ? `${day.label} ${hour}:00 · ${KIND_LABEL[cell.dominant]} · ${formatDuration(cell.minutes)}` : `${day.label} ${hour}:00 · open`}
                  />
                );
              })}
            </>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard>
          <SectionHeading title="Time by type" subtitle="What fills the map." />
          <DonutSummary
            rows={KIND_ORDER.map((kind) => ({
              label: KIND_LABEL[kind],
              minutes: derived.kindMinutes[kind],
              color: KIND_COLOR[kind],
            }))}
            center={formatDuration(derived.totalVisibleMinutes)}
            caption="visible time"
          />
        </SectionCard>

        <SectionCard>
          <SectionHeading title="Fragmentation" subtitle="How chopped-up the plan feels." />
          <div className="mt-5 grid grid-cols-3 gap-2">
            <MiniMetric value={String(derived.totalBlocks)} label="blocks" icon={<BarChart3 size={15} />} />
            <MiniMetric value={formatDuration(data.fragmentation)} label="avg block" icon={<TimerReset size={15} />} />
            <MiniMetric value={formatDuration(data.longest_focus_run_minutes)} label="best focus" icon={<Target size={15} />} />
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-fg-muted">
            The map is deliberately compact: color shows the dominant type in each hour, while stronger saturation means more of that hour is committed.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}

function ExecutiveView({ data, derived }: { data: Analytics; derived: Derived }) {
  const focusShare = data.scheduled_minutes > 0 ? data.focus_minutes / data.scheduled_minutes : 0;
  const meetingShare = derived.totalVisibleMinutes > 0 ? data.meeting_minutes / derived.totalVisibleMinutes : 0;
  const completionShare = derived.totalBlocks > 0 ? derived.completedBlocks / derived.totalBlocks : 0;

  const insights = [
    {
      positive: focusShare >= 0.25,
      title: focusShare >= 0.25 ? "Strong focus allocation" : "Focus time is limited",
      text: `${Math.round(focusShare * 100)}% of scheduled work qualifies as deep work.`,
    },
    {
      positive: data.meeting_load <= 0.3,
      title: data.meeting_load <= 0.3 ? "Meeting load is controlled" : "Meeting load is high",
      text: `${Math.round(data.meeting_load * 100)}% of open hours are consumed by meetings.`,
    },
    {
      positive: derived.highPriorityShare >= 0.35,
      title: derived.highPriorityShare >= 0.35 ? "Priority mix looks intentional" : "High-priority share could be higher",
      text: `P1 + P2 account for ${Math.round(derived.highPriorityShare * 100)}% of planned work.`,
    },
    {
      positive: data.unmet_minutes === 0,
      title: data.unmet_minutes === 0 ? "All demand fits" : "The plan is oversubscribed",
      text: data.unmet_minutes === 0
        ? "The solver placed all requested work."
        : `${formatDuration(data.unmet_minutes)} could not be placed.`,
    },
  ];

  const recommendations: string[] = [];
  if (data.fragmentation > 0 && data.fragmentation < 45) {
    recommendations.push("Consolidate small tasks into fewer, longer blocks to reduce context switching.");
  }
  if (focusShare < 0.25) {
    recommendations.push("Reserve at least one longer focus block on a lighter day.");
  }
  if (derived.highPriorityShare < 0.35) {
    recommendations.push("Increase the share of P1/P2 work before adding more normal-priority tasks.");
  }
  if (data.meeting_load > 0.3) {
    recommendations.push("Protect a meeting-free window to keep deep work from being fragmented.");
  }
  if (data.unmet_minutes > 0) {
    recommendations.push("Widen work windows or reduce lower-priority demand until the unmet queue clears.");
  }
  if (recommendations.length === 0) {
    recommendations.push("The plan is balanced. Keep the current mix and protect the longest focus blocks.");
    recommendations.push("Review priority allocation after the next major calendar change.");
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <KpiGrid
        items={[
          {
            value: formatDuration(data.focus_minutes),
            label: "Deep work",
            note: `${Math.round(focusShare * 100)}% of scheduled work`,
            accent: "#7c3aed",
          },
          {
            value: `${Math.round(data.meeting_load * 100)}%`,
            label: "Meeting load",
            note: formatDuration(data.meeting_minutes),
            accent: "#f97316",
          },
          {
            value: `${Math.round(derived.highPriorityShare * 100)}%`,
            label: "High priority",
            note: "P1 + P2",
            accent: "#dc2626",
          },
          {
            value: `${Math.round(completionShare * 100)}%`,
            label: "Completed",
            note: `${derived.completedBlocks} of ${derived.totalBlocks} blocks`,
            accent: "#16a34a",
          },
        ]}
      />

      <section className="rounded-card border border-amber-200/70 bg-amber-50/45 p-4 shadow-sm sm:p-5">
        <div className="mb-4">
          <h2 className="text-[17px] font-bold text-fg">This plan at a glance</h2>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">Decision-oriented signals from the current planning horizon.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {insights.map((item) => (
            <div key={item.title} className="flex gap-3 rounded-xl border border-black/[0.06] bg-white p-3">
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                item.positive ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
              }`}>
                {item.positive ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              </span>
              <div>
                <h3 className="text-[12.5px] font-semibold text-fg">{item.title}</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{item.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <SectionCard>
          <SectionHeading title="Time distribution" subtitle="The current workload mix." />
          <DonutSummary
            rows={KIND_ORDER.map((kind) => ({
              label: KIND_LABEL[kind],
              minutes: derived.kindMinutes[kind],
              color: KIND_COLOR[kind],
            }))}
            center={formatDuration(derived.totalVisibleMinutes)}
            caption="visible time"
          />
        </SectionCard>

        <SectionCard>
          <SectionHeading title="Focus vs meetings" subtitle="Protected work against calendar pressure." />
          <div className="mt-7 flex h-40 items-end justify-center gap-10">
            <MetricColumn label="Focus" minutes={data.focus_minutes} color="#7c3aed" max={Math.max(data.focus_minutes, data.meeting_minutes, 1)} />
            <MetricColumn label="Meetings" minutes={data.meeting_minutes} color="#f97316" max={Math.max(data.focus_minutes, data.meeting_minutes, 1)} />
          </div>
        </SectionCard>
      </div>

      <SectionCard>
        <SectionHeading title="Recommendations" subtitle="What to change next, based only on the current plan." />
        <div className="mt-4 divide-y divide-black/[0.06] overflow-hidden rounded-xl border border-black/[0.06]">
          {recommendations.slice(0, 4).map((recommendation, index) => (
            <div key={recommendation} className="flex items-start gap-3 bg-white px-3.5 py-3.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sunk text-fg">
                {index === 0 ? <Lightbulb size={15} /> : <Target size={15} />}
              </span>
              <p className="pt-1 text-[12.5px] font-medium leading-relaxed text-fg">{recommendation}</p>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function KpiGrid({
  items,
}: {
  items: Array<{
    value: string;
    label: string;
    note: string;
    accent: string;
    warn?: boolean;
  }>;
}) {
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-px sm:overflow-hidden sm:rounded-card sm:border sm:border-black/[0.08] sm:bg-line sm:shadow-sm">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-black/[0.07] bg-surface p-3.5 shadow-sm sm:rounded-none sm:border-0 sm:p-5 sm:shadow-none">
          <div
            className={`tabular text-[23px] font-bold leading-none sm:text-[27px] ${item.warn ? "text-danger" : "text-fg"}`}
            style={item.warn ? undefined : { color: item.accent }}
          >
            {item.value}
          </div>
          <div className="mt-2 text-[12px] font-semibold text-fg sm:text-[13px]">{item.label}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-fg-muted sm:text-[11px]">{item.note}</div>
        </div>
      ))}
    </section>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-black/[0.08] bg-surface p-4 shadow-sm sm:p-5">
      {children}
    </section>
  );
}

function SectionHeading({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-[16px] font-bold text-fg sm:text-[17px]">{title}</h2>
        <p className="mt-0.5 text-[11.5px] text-fg-muted sm:text-[12.5px]">{subtitle}</p>
      </div>
      {right}
    </div>
  );
}

function MiniLegend({ entries }: { entries: Array<{ label: string; color: string }> }) {
  return (
    <div className="flex max-w-full flex-wrap gap-x-3 gap-y-1">
      {entries.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1.5 text-[9.5px] font-medium text-fg-muted sm:text-[10.5px]">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          {entry.label}
        </span>
      ))}
    </div>
  );
}

function StackedDayChart({
  week,
  rows,
  mode,
}: {
  week: WeekDay[];
  rows: Array<Record<IntentKind, number>> | Array<Record<Priority, number>>;
  mode: "kind" | "priority";
}) {
  const totals = rows.map((row) =>
    mode === "kind"
      ? KIND_ORDER.reduce((sum, kind) => sum + (row as Record<IntentKind, number>)[kind], 0)
      : PRIORITIES.reduce((sum, priority) => sum + (row as Record<Priority, number>)[priority], 0),
  );
  const max = Math.max(1, ...totals);

  return (
    <div className="mt-5">
      <div className="flex h-48 items-end gap-2 sm:gap-4">
        {week.map((day, index) => {
          const total = totals[index]!;
          const row = rows[index]!;
          return (
            <div key={day.key} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
              <div
                className="flex w-full flex-col-reverse overflow-hidden rounded-t-lg bg-sunk"
                style={{ height: `${Math.max(4, (total / max) * 164)}px` }}
                title={`${day.label} · ${formatDuration(total)}`}
              >
                {mode === "kind"
                  ? KIND_ORDER.map((kind) => {
                      const minutes = (row as Record<IntentKind, number>)[kind];
                      if (!minutes || !total) return null;
                      return (
                        <div
                          key={kind}
                          style={{ height: `${(minutes / total) * 100}%`, background: KIND_COLOR[kind] }}
                        />
                      );
                    })
                  : PRIORITIES.slice().reverse().map((priority) => {
                      const minutes = (row as Record<Priority, number>)[priority];
                      if (!minutes || !total) return null;
                      return (
                        <div
                          key={priority}
                          style={{ height: `${(minutes / total) * 100}%`, background: PRIORITY_TINT[priority] }}
                        />
                      );
                    })}
              </div>
              <div className="mt-2 truncate text-center text-[9.5px] font-semibold text-fg-muted sm:text-[11px]">
                {day.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DistributionRows({
  rows,
}: {
  rows: Array<{ label: string; minutes: number; color: string }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.minutes, 0);
  const sorted = [...rows].sort((a, b) => b.minutes - a.minutes);

  return (
    <div className="mt-4 space-y-3.5">
      {sorted.map((row) => {
        const share = total > 0 ? row.minutes / total : 0;
        return (
          <div key={row.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] font-semibold text-fg">{row.label}</span>
              <span className="tabular text-[11px] font-medium text-fg-muted">
                {formatDuration(row.minutes)}
                <span className="ml-2 font-bold" style={{ color: row.color }}>{Math.round(share * 100)}%</span>
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-sunk">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(row.minutes > 0 ? 2 : 0, share * 100)}%`, background: row.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DonutSummary({
  rows,
  center,
  caption,
}: {
  rows: Array<{ label: string; minutes: number; color: string }>;
  center: string;
  caption: string;
}) {
  const total = rows.reduce((sum, row) => sum + row.minutes, 0);
  let cursor = 0;
  const stops = rows
    .filter((row) => row.minutes > 0 && total > 0)
    .map((row) => {
      const start = cursor;
      cursor += (row.minutes / total) * 100;
      return `${row.color} ${start}% ${cursor}%`;
    })
    .join(", ");

  return (
    <div className="mt-5 flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div
        className="relative h-36 w-36 shrink-0 rounded-full"
        style={{ background: stops ? `conic-gradient(${stops})` : "#f5f5f4" }}
      >
        <div className="absolute inset-[18px] flex flex-col items-center justify-center rounded-full bg-white text-center">
          <span className="tabular text-[14px] font-bold text-fg">{center}</span>
          <span className="text-[9px] text-fg-muted">{caption}</span>
        </div>
      </div>

      <div className="grid w-full gap-2">
        {rows.map((row) => {
          const share = total > 0 ? row.minutes / total : 0;
          return (
            <div key={row.label} className="flex items-center justify-between gap-3 text-[11px]">
              <span className="flex items-center gap-2 font-medium text-fg">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
                {row.label}
              </span>
              <span className="tabular font-semibold text-fg-muted">{Math.round(share * 100)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InsightStrip({ data, derived, plan }: { data: Analytics; derived: Derived; plan: Plan }) {
  const busiestIndex = derived.dayKind
    .map((row) => KIND_ORDER.reduce((sum, kind) => sum + row[kind], 0))
    .reduce((best, value, index, values) => (value > values[best]! ? index : best), 0);

  const insights = [
    {
      icon: <Target size={15} />,
      text: `${Math.round(derived.highPriorityShare * 100)}% of planned work is P1/P2.`,
    },
    {
      icon: <Clock size={15} />,
      text: `Average block length is ${formatDuration(data.fragmentation)}.`,
    },
    {
      icon: <CalendarDays size={15} />,
      text: `${derived.week[busiestIndex]?.label ?? "—"} is the busiest of the next seven days.`,
    },
    {
      icon: <Users size={15} />,
      text: plan.busy.length > 0
        ? `${plan.busy.length} external calendar commitments are visible.`
        : "No external calendar commitments are blocking time.",
    },
  ];

  return (
    <section className="rounded-card border border-indigo-100 bg-indigo-50/35 p-4 shadow-sm sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <Lightbulb size={16} className="text-indigo-600" />
        <h2 className="text-[15px] font-bold text-fg">Key insights</h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {insights.map((insight) => (
          <div key={insight.text} className="flex items-start gap-2.5 rounded-xl bg-white/80 px-3 py-2.5 text-[11.5px] leading-relaxed text-fg-muted">
            <span className="mt-0.5 text-indigo-600">{insight.icon}</span>
            {insight.text}
          </div>
        ))}
      </div>
    </section>
  );
}

function MiniMetric({ value, label, icon }: { value: string; label: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-black/[0.06] bg-sunk/50 p-3 text-center">
      <div className="mb-2 flex justify-center text-fg-muted">{icon}</div>
      <div className="tabular text-[16px] font-bold text-fg">{value}</div>
      <div className="mt-0.5 text-[9.5px] font-medium text-fg-muted">{label}</div>
    </div>
  );
}

function MetricColumn({
  label,
  minutes,
  color,
  max,
}: {
  label: string;
  minutes: number;
  color: string;
  max: number;
}) {
  const height = Math.max(minutes > 0 ? 8 : 2, (minutes / max) * 112);
  return (
    <div className="flex h-full w-20 flex-col items-center justify-end">
      <div className="tabular mb-2 text-[12px] font-bold text-fg">{formatDuration(minutes)}</div>
      <div className="w-12 rounded-t-lg" style={{ height, background: color }} />
      <div className="mt-2 text-[10px] font-semibold text-fg-muted">{label}</div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div aria-hidden className="space-y-5">
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </section>
      <Skeleton className="h-[300px] rounded-card" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-[250px] rounded-card" />
        <Skeleton className="h-[250px] rounded-card" />
      </div>
    </div>
  );
}
