/** Wire types - mirror of the Pydantic models in `horolog/api.py`.
 *
 *  Hand-written for now. Once the API is stable these should be generated from
 *  its OpenAPI schema (`openapi-typescript`) so the two cannot drift; until
 *  then this file is the seam to check when an endpoint changes.
 */

export type IntentKind = "task" | "habit" | "focus" | "buffer" | "meeting";
export type Priority = 1 | 2 | 3 | 4;
export type EnergyLevel = "high" | "medium" | "low";


export type AssistantActionKind =
  | "create_task"
  | "create_meeting"
  | "create_break"
  | "swap_tasks"
  | "reschedule_task"
  | "reschedule_break"
  | "complete_task"
  | "update_daily_plan";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAction {
  action: AssistantActionKind;
  title?: string | null;
  intent_id?: string | null;
  second_intent_id?: string | null;
  date?: string | null;
  minutes?: number | null;
  quadrant?: 1 | 2 | 3 | 4 | null;
  start_min?: number | null;
  start_mode?: "fixed" | "preferred" | null;
  win_condition?: string | null;
  first_step?: string | null;
}

export interface AssistantDecision {
  reply: string;
  actions: AssistantAction[];
}

export interface Block {
  intent_id: string;
  title: string;
  kind: IntentKind;
  priority: Priority;
  energy?: EnergyLevel;
  occurrence: number;
  chunk: number;
  start: string;
  end: string;
  moved_from: string | null;
  completed?: boolean;
  recurring?: boolean;
}

export interface Unmet {
  intent_id: string;
  title: string;
  priority: Priority;
  shortfall_minutes: number;
}

export interface Busy {
  label: string;
  start: string;
  end: string;
  source: string;
}

export interface Plan {
  blocks: Block[];
  unmet: Unmet[];
  busy: Busy[];
  solve_ms: number;
  complete: boolean;
  generated_at: string;
  origin: string;
  horizon_days: number;
}


export interface DailyItem {
  id: string;
  plan_date: string;
  title: string;
  quadrant: 1 | 2 | 3 | 4;
  minutes: number;
  priority: Priority;
  intent_id?: string | null;
  schedule_enabled: boolean;
  completed_at?: string | null;
  cancelled_at?: string | null;
  carried: boolean;
  carry_days: number;
  defer_until?: string | null;
  needs_decision?: boolean;
}

export interface DailyHistoryEntry {
  date: string;
  win_condition: string;
  first_step: string;
  items: number;
  completed_items: number;
  review_answers: number;
  has_review: boolean;
}

export interface DailyWeekly {
  start: string;
  end: string;
  planned_days: number;
  reviewed_days: number;
  items_created: number;
  items_completed: number;
  carry_over: number;
  stale_items: number;
  days: Array<{
    date: string;
    planned: boolean;
    review_answers: number;
    items: number;
    completed_items: number;
  }>;
  reflection_highlights: Array<{
    date: string;
    kind: "learned" | "improve";
    text: string;
  }>;
}

export interface DailySuggestion {
  intent_id: string;
  title: string;
  priority: Priority;
  minutes: number;
}

export interface DailyReview {
  did_well: string;
  grateful_for: string;
  would_change: string;
  learned: string;
  improve_tomorrow: string;
  first_step_morning: string;
}

export interface DailyData {
  date: string;
  plan: {
    win_condition: string;
    first_step: string;
    closed_at?: string | null;
  };
  items: DailyItem[];
  suggestions: DailySuggestion[];
  yesterday: {
    improve: string;
    first_step: string;
  };
  review: DailyReview;
  summary: {
    completed_blocks: number;
    total_blocks: number;
    carry_over: number;
  };
}

export interface DailyWindow {
  start_min: number;
  end_min: number;
}

export interface Intent {
  id: string;
  title: string;
  kind: IntentKind;
  priority: Priority;
  energy?: EnergyLevel | null;
  minutes_per_period: number;
  period_days: number | null;
  min_chunk_minutes: number;
  max_chunk_minutes: number;
  max_per_day?: number | null;
  daily_windows?: DailyWindow[];
  allowed_weekdays?: number[];
  earliest_slot?: number | null;
  latest_slot?: number | null;
  due_slot?: number | null;
  preferred_start_min?: number | null;
  /** Set once, on a one-shot task only - see `complete`/`uncomplete` below. */
  completed_at?: string | null;
  /** Slot ranges (not clock times) other attendees are busy - present only
   *  on meeting-kind intents. Its length is the useful part for display. */
  blocked_slots?: [number, number][];
  /** Set automatically when HOROLOG_ZOOM_* is configured server-side - a
   *  no-fixed-time meeting link, present only on meeting-kind intents. */
  zoom_join_url?: string | null;
}

export const SLOT_MINUTES = 15;

function slotToISO(slot: number, origin: string): string {
  return new Date(Date.parse(origin) + slot * SLOT_MINUTES * 60000).toISOString();
}

/** Rebuilds a full `PUT /api/intents/{id}` body from a stored `Intent`, so an
 *  edit that only changes (say) duration doesn't silently drop the window,
 *  due date or chunk shape the intent already had - the API replaces the
 *  whole object, it does not merge. Not lossless for a Smart Meeting's
 *  attendee constraints: `blocked_slots` carries no attendee names, only the
 *  slot spans, so there is nothing to reconstruct `attendee_busy` from - the
 *  edit UI does not offer editing meetings for exactly this reason. */
export function intentToEditPayload(intent: Intent, origin: string): Record<string, unknown> {
  const window = intent.daily_windows?.[0];
  return {
    title: intent.title,
    kind: intent.kind,
    priority: intent.priority,
    energy: intent.energy ?? undefined,
    minutes_per_period: intent.minutes_per_period,
    period_days: intent.period_days ?? undefined,
    min_chunk_minutes: intent.min_chunk_minutes,
    max_chunk_minutes: intent.max_chunk_minutes,
    max_per_day: intent.max_per_day ?? undefined,
    allowed_weekdays: intent.allowed_weekdays ?? [],
    window_start_min: window?.start_min,
    window_end_min: window?.end_min,
    due: intent.due_slot != null ? slotToISO(intent.due_slot, origin) : undefined,
    earliest: intent.earliest_slot != null ? slotToISO(intent.earliest_slot, origin) : undefined,
    latest: intent.latest_slot != null ? slotToISO(intent.latest_slot, origin) : undefined,
    preferred_start_min: intent.preferred_start_min ?? undefined,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    // The API puts a human-readable reason in `detail` for every 4xx it raises
    // deliberately - surface that rather than a bare status code.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* non-JSON error body; keep the status line */
    }
    throw new Error(detail);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  plan: () => request<Plan>("/api/plan"),
  resolve: () => request<Plan>("/api/plan/solve", { method: "POST" }),
  intents: () => request<Intent[]>("/api/intents"),
  remove: (id: string) => request<void>(`/api/intents/${id}`, { method: "DELETE" }),
  update: (id: string, body: Record<string, unknown>) =>
    request<Intent>(`/api/intents/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  patchIntent: (id: string, body: { title?: string; priority?: Priority }) =>
    request<Intent>(`/api/intents/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  complete: (id: string) => request<Intent>(`/api/intents/${id}/complete`, { method: "POST" }),
  uncomplete: (id: string) =>
    request<Intent>(`/api/intents/${id}/complete`, { method: "DELETE" }),
  moveIntent: (id: string, start: string, end: string) =>
    request<{ intent_id: string; date: string; start: string; blocks: number }>(
      `/api/intents/${id}/move`,
      {
        method: "POST",
        body: JSON.stringify({ start, end }),
      },
    ),
  completeBlock: (id: string, start: string, end: string) =>
    request<Intent>(`/api/intents/${id}/complete-block`, {
      method: "POST",
      body: JSON.stringify({ start, end }),
    }),
  uncompleteBlock: (id: string, start: string, end: string) =>
    request<Intent>(`/api/intents/${id}/complete-block`, {
      method: "DELETE",
      body: JSON.stringify({ start, end }),
    }),
  capture: (text: string, provider?: string, model?: string, apiKey?: string) =>
    request<{ intent: Intent }>("/api/capture", {
      method: "POST",
      body: JSON.stringify({ text, provider, model, api_key: apiKey }),
    }),
  assistantChat: (
    messages: AssistantMessage[],
    pendingActions: AssistantAction[] = [],
    contextPage?: string,
  ) =>
    request<AssistantDecision>("/api/assistant/chat", {
      method: "POST",
      body: JSON.stringify({
        messages,
        pending_actions: pendingActions,
        context_page: contextPage,
      }),
    }),
  assistantExecute: (actions: AssistantAction[]) =>
    request<{
      count: number;
      results: Array<Record<string, unknown>>;
    }>("/api/assistant/execute", {
      method: "POST",
      body: JSON.stringify({ actions }),
    }),
  setBusy: (events: Omit<Busy, "source">[]) =>
    request<{ events: number; blocks: number }>("/api/busy", {
      method: "PUT",
      body: JSON.stringify(events),
    }),
  daily: (date: string) => request<DailyData>(`/api/daily/${date}`),
  saveDailyPlan: (date: string, body: { win_condition: string; first_step: string }) =>
    request<{ date: string; win_condition: string; first_step: string }>(`/api/daily/${date}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  createDailyItem: (
    date: string,
    body: {
      title: string;
      quadrant: 1 | 2 | 3 | 4;
      minutes: number;
      priority?: Priority;
      schedule_enabled: boolean;
      intent_id?: string;
    },
  ) =>
    request<DailyItem>(`/api/daily/${date}/items`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  captureDaily: (
    date: string,
    body: {
      text: string;
      quadrant: 1 | 2 | 3 | 4;
      default_minutes: number;
    },
  ) =>
    request<{
      source: string;
      count: number;
      created: Array<{
        kind: "task";
        date: string;
        item: DailyItem;
      }>;
      meeting_suggestions: Array<{
        title: string;
        date: string;
        start_min: number | null;
        minutes: number;
      }>;
    }>(`/api/daily/${date}/capture`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  confirmDailyMeeting: (body: {
    title: string;
    date: string;
    start_min: number;
    minutes: number;
    priority?: Priority;
  }) =>
    request<{
      intent_id: string;
      title: string;
      date: string;
      start: string;
      end: string;
    }>("/api/daily/confirm-meeting", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  completeDailyItem: (id: string) =>
    request<DailyItem>(`/api/daily/items/${id}/complete`, { method: "POST" }),
  cancelDailyItem: (id: string) =>
    request<DailyItem>(`/api/daily/items/${id}/cancel`, { method: "POST" }),
  moveDailyItem: (id: string, quadrant: 1 | 2 | 3 | 4, date: string) =>
    request<DailyItem>(`/api/daily/items/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ quadrant, date }),
    }),
  saveDailyReview: (date: string, body: DailyReview) =>
    request<{ date: string } & DailyReview>(`/api/daily/${date}/review`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  dailyHistory: () => request<DailyHistoryEntry[]>("/api/daily-history"),
  dailyWeekly: (date: string) => request<DailyWeekly>(`/api/daily-weekly/${date}`),
  keepDailyItem: (id: string, date: string) =>
    request<{ item_id: string; date: string; status: string }>(`/api/daily/items/${id}/keep`, {
      method: "POST",
      body: JSON.stringify({ date }),
    }),
  deferDailyItem: (id: string, until: string) =>
    request<{ item_id: string; until: string; status: string }>(`/api/daily/items/${id}/defer`, {
      method: "POST",
      body: JSON.stringify({ until }),
    }),
};

export function minutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 60000);
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// --------------------------------------------------------------- analytics

export interface Slice {
  label: string;
  minutes: number;
  share: number;
}

export interface DayLoad {
  day: number;
  scheduled_minutes: number;
  meeting_minutes: number;
  longest_free_run_minutes: number;
}

export interface Analytics {
  horizon_days: number;
  window_minutes_per_day: number;
  focus_minutes: number;
  meeting_minutes: number;
  scheduled_minutes: number;
  unmet_minutes: number;
  meeting_load: number;
  fragmentation: number;
  longest_focus_run_minutes: number;
  after_hours_minutes: number;
  by_kind: Slice[];
  by_priority: Slice[];
  days: DayLoad[];
}

export const analytics = {
  get: () => request<Analytics>("/api/analytics"),
};

/** Every syncable provider. Google/Outlook are calendars — they land in the
 *  busy mirror; the rest are trackers — they land as tasks. Linear/Todoist/
 *  GitHub are OAuth-connectable (appear in `connections.list()`); Notion/
 *  ClickUp/Jira are pasted-credential only — see their integrations/*.py
 *  docstrings for why — and never appear in that list. */
export type Provider =
  | "google"
  | "outlook"
  | "linear"
  | "todoist"
  | "github"
  | "notion"
  | "clickup"
  | "jira";

export const sync = {
  ics: (url: string) =>
    request<{ events: number; blocks: number }>("/api/sync/ics", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  caldav: (url: string, username: string, password: string) =>
    request<{ events: number; blocks: number }>("/api/sync/caldav", {
      method: "POST",
      body: JSON.stringify({ url, username, password }),
    }),
  // A pasted key is optional on all three trackers — omitted, the API falls
  // back to whatever OAuth connection is already stored server-side.
  linear: (apiKey = "") =>
    request<{ issues: number; blocks: number }>("/api/sync/linear", {
      method: "POST",
      body: JSON.stringify({ api_key: apiKey }),
    }),
  todoist: (token = "") =>
    request<{ tasks: number; blocks: number }>("/api/sync/todoist", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  github: (token = "") =>
    request<{ issues: number; blocks: number }>("/api/sync/github", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  // These three have no OAuth fallback — a credential is required, not optional.
  notion: (credential: string) =>
    request<{ tasks: number; blocks: number }>("/api/sync/notion", {
      method: "POST",
      body: JSON.stringify({ token: credential }),
    }),
  clickup: (credential: string) =>
    request<{ tasks: number; blocks: number }>("/api/sync/clickup", {
      method: "POST",
      body: JSON.stringify({ token: credential }),
    }),
  jira: (credential: string) =>
    request<{ issues: number; blocks: number }>("/api/sync/jira", {
      method: "POST",
      body: JSON.stringify({ token: credential }),
    }),
  google: () => request<{ events: number; blocks: number }>("/api/sync/google", { method: "POST" }),
  outlook: () =>
    request<{ events: number; blocks: number }>("/api/sync/outlook", { method: "POST" }),
};

export interface CalendarPushResult {
  created: number;
  moved: number;
  removed: number;
}

export const calendarPush = {
  /** Pushes the plan onto the connected provider's "Horolog" calendar right
   *  now. 409s if write-back is off (`HOROLOG_CALENDAR_WRITEBACK_ENABLED`)
   *  or the provider isn't connected; 502 with a reconnect message if the
   *  stored token predates the write scope. */
  push: (provider: "google" | "outlook") =>
    request<CalendarPushResult>("/api/calendar/push", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
};

export const connections = {
  /** Which providers have a live, usable OAuth connection right now. */
  list: () => request<Record<Provider, boolean>>("/api/connections"),
  disconnect: (provider: Provider) =>
    request<void>(`/api/connections/${provider}`, { method: "DELETE" }),
};

// --------------------------------------------------------------- booking

export interface FreeSlot {
  start: string;
  end: string;
}

export interface Booked {
  start: string;
  end: string;
  /** How many of your own blocks the solver moved to make room. */
  rescheduled_blocks: number;
}

export const booking = {
  availability: (minutes: number, days: number) =>
    request<FreeSlot[]>(`/api/availability?minutes=${minutes}&days=${days}`),
  book: (body: { name: string; email: string; start: string; minutes: number }) =>
    request<Booked>("/api/book", { method: "POST", body: JSON.stringify(body) }),
};

export const createIntent = (body: Record<string, unknown>) =>
  request<Intent>("/api/intents", { method: "POST", body: JSON.stringify(body) });

/** A span one attendee is busy - the solver treats these as blocked only for
 *  the meeting requirement they're attached to, never the shared calendar. */
export interface AttendeeBusy {
  start: string;
  end: string;
  attendee?: string;
}

export const KIND_ORDER: IntentKind[] = ["focus", "task", "habit", "meeting", "buffer"];

export const PRIORITY_NAME: Record<Priority, string> = {
  1: "Critical",
  2: "High",
  3: "Normal",
  4: "Low",
};

/** Accent tint per priority - one hue, four weights. Shared by every view so
 *  the same block reads the same way on the grid, in the inbox, and in a chart. */
export const PRIORITY_TINT: Record<Priority, string> = {
  1: "#dc2626", // Critical - red
  2: "#f59e0b", // High - amber
  3: "#2563eb", // Normal - blue
  4: "#16a34a", // Low - green
};
