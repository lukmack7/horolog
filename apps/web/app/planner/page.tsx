"use client";

import { useLanguage } from "@/app/components/LanguageProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Glyph, KIND_LABEL } from "@/app/components/Glyph";
import { PRIORITY_LABEL, RULE } from "@/app/components/Grid";
import { Shell } from "@/app/components/Shell";
import {
  api,
  createIntent,
  formatDuration,
  minutesBetween,
  numberBreakTitles,
  type Plan,
  type Block,
  type Busy,
  type IntentKind,
  type Priority,
} from "@/app/lib/api";
import { EventManager, type Event } from "@/components/ui/event-manager";
import Link from "next/link";
import {
  Download,
  AlertTriangle,
  Sparkles,
  Command,
  Link2,
} from "lucide-react";

/** Map backend priority number to EventManager color-filter values.
 *  Rendering itself no longer reads these — `EventCard`/`ListView` in
 *  `event-manager.tsx` read `Event.priority` directly and paint it with
 *  `PRIORITY_TINT`/`RULE`/`FILL`, the same accent system every other view
 *  uses. `color` only still drives the toolbar's "filter by color" chips
 *  and the manual create-event dialog's swatch picker, so it still needs a
 *  distinct, named value per priority. */
const PRIORITY_COLOR: Record<number, string> = {
  1: "p1",
  2: "p2",
  3: "p3",
  4: "p4",
};

/** Stone, the same neutral hue `--color-accent` is drawn from, at
 *  descending weights — so even the secondary filter/picker UI reads as
 *  the same one-hue system instead of introducing its own palette. One
 *  extra entry for real external events, which have no priority of their
 *  own and need to read as visually distinct rather than a fifth "normal"
 *  block. */
const COLORS = [
  { name: "Critical", value: "p1", bg: "bg-red-600", text: "text-red-700" },
  { name: "High", value: "p2", bg: "bg-amber-500", text: "text-amber-700" },
  { name: "Normal", value: "p3", bg: "bg-blue-600", text: "text-blue-700" },
  { name: "Low", value: "p4", bg: "bg-green-600", text: "text-green-700" },
  { name: "External", value: "slate", bg: "bg-slate-400", text: "text-slate-700" },
];

const EXTERNAL_PREFIX = "external-";

function kindToCategory(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Convert backend Block[] to EventManager Event[] */
function blocksToEvents(blocks: Block[]): Event[] {
  return numberBreakTitles(blocks).map((block) => {
    const tags: string[] = [PRIORITY_LABEL[block.priority]];
    if (block.moved_from !== null && block.moved_from !== block.start) {
      tags.push("Moved");
    }
    if (block.energy) {
      tags.push(block.energy.charAt(0).toUpperCase() + block.energy.slice(1) + " Energy");
    }
    return {
      // Multiple chunks of the same occurrence (a long focus session split
      // into two sittings, say) share intent_id + occurrence — chunk has to
      // be part of the key too, or React sees duplicate ids and month view
      // (which lists several events per day cell) renders it visibly.
      id: `${block.intent_id}-${block.occurrence}-${block.chunk}`,
      intentId: block.intent_id,
      title: block.title,
      description: `${KIND_LABEL[block.kind]} · Chunk ${block.chunk} · ${formatDuration(minutesBetween(block.start, block.end))}`,
      startTime: new Date(block.start),
      endTime: new Date(block.end),
      color: PRIORITY_COLOR[block.priority] || "p3",
      category: kindToCategory(block.kind),
      priority: block.priority,
      kind: block.kind,
      completed: block.completed ?? false,
      recurring: block.recurring ?? false,
      tags,
    };
  });
}

/** Real, immovable commitments — meetings, decompression buffers, accepted
 *  bookings. Rendered read-only: nothing the solver placed may ever overlap
 *  these, and the planner has to show *why* rather than leave a silent gap. */
function busyToEvents(busy: Busy[]): Event[] {
  return busy.map((event, index) => ({
    id: `${EXTERNAL_PREFIX}${index}`,
    title: event.label || "Busy",
    description: `External · ${event.source}`,
    startTime: new Date(event.start),
    endTime: new Date(event.end),
    color: "slate",
    category: "External",
    tags: ["Locked"],
  }));
}

export default function Planner() {
  const { t, language } = useLanguage();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await api.plan());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the scheduler.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduledMinutes = useMemo(
    () => plan?.blocks.reduce((sum, b) => sum + minutesBetween(b.start, b.end), 0) ?? 0,
    [plan],
  );
  const movedCount = useMemo(
    () =>
      plan?.blocks.filter((b) => b.moved_from !== null && b.moved_from !== b.start).length ?? 0,
    [plan],
  );

  const calendarEvents = useMemo(
    () => [...blocksToEvents(plan?.blocks ?? []), ...busyToEvents(plan?.busy ?? [])],
    [plan],
  );

  const handleEventCreate = useCallback(
    async (event: Omit<Event, "id">) => {
      try {
        const durationMinutes = Math.round(
          (event.endTime.getTime() - event.startTime.getTime()) / 60000,
        );

        if (durationMinutes <= 0) {
          throw new Error("End time must be later than start time.");
        }

        const category = event.category?.toLowerCase();
        const kind: IntentKind =
          category === "habit" ||
          category === "focus" ||
          category === "buffer" ||
          category === "meeting"
            ? category
            : "task";

        const priorityByColor: Record<string, Priority> = {
          p1: 1,
          p2: 2,
          p3: 3,
          p4: 4,
        };
        const priority = priorityByColor[event.color ?? ""] ?? 3;

        const startMin =
          event.startTime.getHours() * 60 + event.startTime.getMinutes();
        const endMin =
          event.endTime.getHours() * 60 + event.endTime.getMinutes();

        await createIntent({
          title: event.title,
          kind,
          priority,
          minutes_per_period: durationMinutes,
          period_days: null,
          min_chunk_minutes: durationMinutes,
          max_chunk_minutes: durationMinutes,
          max_per_day: 1,
          window_start_min: startMin,
          window_end_min: endMin,
          earliest: event.startTime.toISOString(),
          due: event.endTime.toISOString(),
          preferred_start_min: startMin,
        });

        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to create event.");
      }
    },
    [load],
  );

  const handleEventComplete = useCallback(
    async (event: Event) => {
      if (!event.intentId) return;

      try {
        if (event.recurring) {
          if (event.completed) {
            await api.uncompleteBlock(
              event.intentId,
              event.startTime.toISOString(),
              event.endTime.toISOString(),
            );
          } else {
            await api.completeBlock(
              event.intentId,
              event.startTime.toISOString(),
              event.endTime.toISOString(),
            );
          }
        } else if (event.kind === "task") {
          if (event.completed) {
            await api.uncomplete(event.intentId);
          } else {
            await api.complete(event.intentId);
          }
        }

        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not update completion.");
      }
    },
    [load],
  );

  const handleEventUpdate = useCallback(
    async (id: string, event: Partial<Event>) => {
      if (id.startsWith(EXTERNAL_PREFIX)) {
        setError("Real calendar events are read-only here — move them in the source calendar.");
        await load();
        return;
      }

      const source = calendarEvents.find((candidate) => candidate.id === id);
      if (!source?.intentId || !event.startTime || !event.endTime) {
        await load();
        return;
      }

      if (source.recurring) {
        setError("Recurring routines are not draggable as whole tasks yet.");
        await load();
        return;
      }

      try {
        // Editing the event dialog is an explicit user decision. If only
        // the start changes, preserve the existing duration. If the end changes,
        // keep the start fixed so the user can deliberately resize the task.
        let start = event.startTime;
        let end = event.endTime;
        const originalDuration = source.endTime.getTime() - source.startTime.getTime();
        const startChanged = start.getTime() !== source.startTime.getTime();
        const endChanged = end.getTime() !== source.endTime.getTime();

        if (startChanged && !endChanged) {
          end = new Date(start.getTime() + originalDuration);
        }

        if (startChanged || endChanged) {
          await api.moveIntent(
            source.intentId,
            start.toISOString(),
            end.toISOString(),
          );
        }

        const priorityByColor: Record<string, Priority> = {
          p1: 1,
          p2: 2,
          p3: 3,
          p4: 4,
        };
        const nextPriority =
          priorityByColor[event.color ?? ""] ??
          event.priority ??
          source.priority;
        const nextTitle = event.title?.trim() || source.title;

        if (nextTitle !== source.title || nextPriority !== source.priority) {
          await api.patchIntent(source.intentId, {
            title: nextTitle,
            priority: nextPriority,
          });
        }

        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not update that event.");
        await load();
      }
    },
    [calendarEvents, load],
  );

  const handleEventDelete = useCallback(
    async (id: string) => {
      if (id.startsWith(EXTERNAL_PREFIX)) {
        setError("That's a real calendar event, not one Horolog placed — remove it at the source and re-sync.");
        return;
      }
      try {
        // id is `${intent_id}-${occurrence}-${chunk}` — strip both trailing
        // numeric segments to recover the bare intent_id.
        const parts = id.split("-");
        const intentId = parts.length > 2 ? parts.slice(0, -2).join("-") : parts[0] ?? id;
        await api.remove(intentId);
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to delete event.");
      }
    },
    [load],
  );

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[1440px] overflow-x-hidden px-4 py-5 sm:px-6 sm:py-8">
        {/* Header */}
        <header className="mb-5 flex items-start justify-between gap-3 sm:mb-7 sm:items-end sm:gap-4">
          <div>
            <h1 className="text-[30px] font-bold leading-tight text-fg sm:text-[28px]">{t("Planner")}</h1>
            <p className="mt-1 text-[13.5px] text-fg-muted">
              {plan ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-semibold text-fg">{plan.blocks.length} {language === "pl" ? (plan.blocks.length === 1 ? "blok" : "bloki") : (plan.blocks.length === 1 ? "block" : "blocks")}</span>
                  <span>·</span>
                  <span>{formatDuration(scheduledMinutes)} scheduled</span>
                  <span>·</span>
                  <span className="tabular text-accent font-medium">{language === "pl" ? "ułożono w" : "solved in"} {plan.solve_ms.toFixed(1)}ms</span>
                </span>
              ) : (
                "Loading schedule..."
              )}
            </p>
          </div>

          <a
            href="/api/plan.ics"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-black/[0.08] bg-surface px-3 text-[12.5px] font-semibold text-fg shadow-sm transition-all duration-150 hover:bg-sunk hover:shadow-md sm:h-9.5 sm:px-4 sm:text-[13px]"
          >
            <Download size={14} className="text-fg-muted" />
            <span className="sm:hidden">{t("Export")}</span>
            <span className="hidden sm:inline">{t("Export .ics")}</span>
          </a>
        </header>

        {error && (
          <div className="mb-6 rounded-card border border-red-200/80 bg-red-50/60 p-4 shadow-sm">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold text-danger">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
            <p className="mt-1 text-[12.5px] text-fg-muted">
              Ensure the backend API is running — check the terminal `npm run dev` is in for
              which port it picked.
            </p>
          </div>
        )}

        {plan && plan.blocks.length === 0 && plan.busy.length === 0 && (
          <div className="mb-6 rounded-card border border-black/[0.08] bg-surface p-5 shadow-sm">
            <h2 className="text-[14px] font-semibold text-fg">{t("Nothing scheduled yet")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              A fresh install starts with an empty calendar on purpose — nothing is faked. Get a
              real week on the board with any of these:
            </p>
            <ul className="mt-3 space-y-2 text-[13px] text-fg-muted">
              <li className="flex items-center gap-2">
                <kbd className="tabular inline-flex items-center gap-0.5 rounded-md border border-black/[0.08] bg-sunk px-1.5 py-0.5 text-[10.5px] font-mono">
                  <Command size={10} />K
                </kbd>
                capture something in plain language, e.g. &ldquo;gym 3x a week, an hour each&rdquo;
              </li>
              <li className="flex items-center gap-2">
                <Link2 size={13} className="text-accent" />
                <Link href="/connect" className="font-medium text-accent hover:underline">
                  Connect a calendar
                </Link>
                {" "}to pull in what you already have
              </li>
              <li className="flex items-center gap-2">
                <span className="rounded-md border border-black/[0.08] bg-sunk px-1.5 py-0.5 font-mono text-[10.5px]">
                  npm run seed:demo
                </span>
                for a sample week, if you're just trying it out
              </li>
            </ul>
          </div>
        )}

        {/* Calendar + Sidebar */}
        <div className="grid gap-6 lg:grid-cols-[1fr_270px]">
          <section aria-label={t("Calendar view")} className="min-w-0">
            <EventManager
              events={calendarEvents}
              onEventCreate={handleEventCreate}
              onEventUpdate={handleEventUpdate}
              onEventDelete={handleEventDelete}
              onEventComplete={handleEventComplete}
              categories={["Task", "Habit", "Focus", "Buffer", "Meeting", "External"]}
              availableTags={["Critical", "High", "Normal", "Low", "Moved", "Locked", "High Energy", "Medium Energy", "Low Energy"]}
              colors={COLORS}
              defaultView="month"
              className="min-h-[600px]"
            />
          </section>

          <aside className="hidden space-y-4 lg:block">
            {movedCount > 0 && (
              <Panel title={t("Shift Stability")}>
                <div className="flex items-start gap-2.5">
                  <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
                  <p className="text-[13px] leading-relaxed text-fg-muted">
                    <span className="font-semibold text-fg">{movedCount} {movedCount === 1 ? "block" : "blocks"}</span> shifted to fit new commitments. All other tasks remained untouched.
                  </p>
                </div>
              </Panel>
            )}

            {plan && !plan.complete && (
              <Panel title={t("Unmet Demand")}>
                <ul className="space-y-3">
                  {plan.unmet.map((item) => (
                    <li key={`${item.intent_id}-${item.title}`} className="flex gap-2.5">
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                        style={{ background: RULE[item.priority] }}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-fg">{item.title}</span>
                        <span className="tabular text-[11.5px] text-danger font-medium">
                          {formatDuration(item.shortfall_minutes)} short · {PRIORITY_LABEL[item.priority]}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-3.5 border-t border-black/[0.06] pt-3 text-[12px] text-fg-muted">
                  Widen daily windows or lower priority to fit remaining demand.
                </p>
              </Panel>
            )}

            <Panel title={t("Legend")}>
              <ul className="space-y-2.5">
                {(["task", "habit", "focus", "buffer", "meeting"] as const).map((kind) => (
                  <li key={kind} className="flex items-center gap-2.5 text-[13px] text-fg font-medium">
                    <span className="text-accent">
                      <Glyph kind={kind} size={15} />
                    </span>
                    {KIND_LABEL[kind]}
                  </li>
                ))}
              </ul>
              <div className="mt-4 space-y-2.5 border-t border-black/[0.06] pt-3.5">
                {([1, 2, 3, 4] as const).map((priority) => (
                  <div key={priority} className="flex items-center gap-2.5 text-[12.5px] text-fg-muted font-medium">
                    <span
                      className="h-3.5 w-1 rounded-full"
                      style={{ background: RULE[priority] }}
                      aria-hidden
                    />
                    {PRIORITY_LABEL[priority]} Priority
                  </div>
                ))}
                <div className="flex items-center gap-2.5 pt-1 text-[12px] text-fg-muted">
                  <span
                    className="h-3.5 border-l-2 border-dashed"
                    style={{ borderColor: RULE[3] }}
                    aria-hidden
                  />
                  Moved block
                </div>
                <div className="flex items-center gap-2.5 text-[12px] text-fg-muted">
                  <span className="h-3.5 w-1 rounded-full bg-slate-300" aria-hidden />
                  Real calendar meeting
                </div>
              </div>
            </Panel>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-black/[0.06] bg-surface p-4.5 shadow-sm">
      <h2 className="mb-3 text-[11px] font-semibold tracking-wider uppercase text-fg-muted">
        {title}
      </h2>
      {children}
    </div>
  );
}
