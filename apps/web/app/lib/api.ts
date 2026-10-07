/** Wire types - mirror of the Pydantic models in `horolog/api.py`.
 *
 *  Hand-written for now. Once the API is stable these should be generated from
 *  its OpenAPI schema (`openapi-typescript`) so the two cannot drift; until
 *  then this file is the seam to check when an endpoint changes.
 */

export type IntentKind = "task" | "habit" | "focus" | "buffer" | "meeting";
export type Priority = 1 | 2 | 3 | 4;
export type WorkCategory = "cmr" | "macheta_data" | "private";

export const WORK_CATEGORY_LABEL: Record<WorkCategory, string> = {
  cmr: "CMR",
  macheta_data: "Macheta Data",
  private: "Prywatne",
};

export const WORK_CATEGORIES: WorkCategory[] = ["cmr", "macheta_data", "private"];


export type AssistantActionKind =
  | "create_task"
  | "create_meeting"
  | "create_break"
  | "swap_tasks"
  | "reschedule_task"
  | "reschedule_break"
  | "reschedule_meeting"
  | "complete_task"
  | "update_daily_plan"
  | "find_time";

export interface AssistantReference {
  kind: "intent" | "category";
  token: string;
  intent_id?: string | null;
  category?: WorkCategory | null;
}

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  references?: AssistantReference[];
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
  category?: WorkCategory | null;
  win_condition?: string | null;
  first_step?: string | null;
  search_days?: number | null;
  count?: number | null;
  window_start_min?: number | null;
  window_end_min?: number | null;
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
  category?: WorkCategory | null;
  occurrence: number;
  chunk: number;
  start: string;
  end: string;
  moved_from: string | null;
  completed?: boolean;
  recurring?: boolean;
}

export function numberBreakTitles(blocks: Block[]): Block[] {
  const orderedBuffers = blocks
    .filter((block) => block.kind === "buffer")
    .slice()
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const numbers = new Map<string, number>();
  const perDay = new Map<string, number>();

  for (const block of orderedBuffers) {
    const day = block.start.slice(0, 10);
    const next = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, next);
    numbers.set(
      `${block.intent_id}:${block.occurrence}:${block.chunk}`,
      next,
    );
  }

  return blocks.map((block) => {
    if (block.kind !== "buffer") return block;
    const key = `${block.intent_id}:${block.occurrence}:${block.chunk}`;
    const number = numbers.get(key);
    if (!number) return block;

    const generic = block.title.trim().toLocaleLowerCase("pl-PL") === "przerwa";
    return {
      ...block,
      title: generic ? `Przerwa ${number}` : `${block.title} · #${number}`,
    };
  });
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


export interface TodoAISuggestion {
  minutes: number;
  quadrant: 1 | 2 | 3 | 4;
  category?: WorkCategory | null;
  deadline_date?: string | null;
  rationale: string;
}

export interface TodoInboxItem {
  id: string;
  title: string;
  minutes: number;
  category?: WorkCategory | null;
  deadline_date?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyItem {
  id: string;
  plan_date: string;
  title: string;
  quadrant: 1 | 2 | 3 | 4;
  minutes: number;
  priority: Priority;
  category?: WorkCategory | null;
  deadline_date?: string | null;
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

export interface TimeTrackingEntry {
  id: string;
  intent_id: string;
  title: string;
  status: "running" | "paused" | "stopped";
  started_at: string;
  last_resumed_at?: string | null;
  accumulated_seconds: number;
  elapsed_seconds: number;
  ended_at?: string | null;
}

export interface TimeTrackingStats {
  intent_id: string;
  title: string;
  planned_minutes: number;
  sessions: number;
  total_seconds: number;
  average_seconds: number;
}

export interface ChangeHistoryEntry {
  id: string;
  source: string;
  title: string;
  summary: Array<Record<string, unknown>>;
  created_at: string;
  undone_at?: string | null;
  can_undo: boolean;
}


export interface UserPreferences {
  preferred_workday_start_min: number;
  preferred_workday_end_min: number;
}

export interface NotificationPreferences {
  task_enabled: boolean;
  task_minutes_before: number;
  task_at_start: boolean;

  meeting_enabled: boolean;
  meeting_minutes_before: number;
  meeting_at_start: boolean;

  deadline_enabled: boolean;
  deadline_days_before: number;
  deadline_time_min: number;

  end_of_day_enabled: boolean;
  end_of_day_time_min: number;
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
  category?: WorkCategory | null;
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
  deadline_date?: string | null;
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
    category: intent.category ?? undefined,
    minutes_per_period: intent.minutes_per_period,
    period_days: intent.period_days ?? undefined,
    min_chunk_minutes: intent.min_chunk_minutes,
    max_chunk_minutes: intent.max_chunk_minutes,
    max_per_day: intent.max_per_day ?? undefined,
    allowed_weekdays: intent.allowed_weekdays ?? [],
    window_start_min: window?.start_min,
    window_end_min: window?.end_min,
    due: intent.due_slot != null ? slotToISO(intent.due_slot, origin) : undefined,
    deadline_date: intent.deadline_date ?? undefined,
    earliest: intent.earliest_slot != null ? slotToISO(intent.earliest_slot, origin) : undefined,
    latest: intent.latest_slot != null ? slotToISO(intent.latest_slot, origin) : undefined,
    preferred_start_min: intent.preferred_start_min ?? undefined,
  };
}

function formatApiDetail(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const messages = value
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          const msg = (item as { msg?: unknown }).msg;
          return typeof msg === "string" ? msg : null;
        }
        return null;
      })
      .filter((message): message is string => Boolean(message));
    if (messages.length > 0) return messages.join("; ");
  }
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
      const body = (await response.json()) as { detail?: unknown };
      const parsed = formatApiDetail(body.detail);
      if (parsed) detail = parsed;
    } catch {
      /* non-JSON error body; keep the status line */
    }
    throw new Error(detail);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  plan: () => request<Plan>("/api/plan"),
  settings: () => request<UserPreferences>("/api/settings"),
  saveSettings: (body: UserPreferences) =>
    request<UserPreferences>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  notificationSettings: () =>
    request<NotificationPreferences>("/api/settings/notifications"),
  saveNotificationSettings: (body: NotificationPreferences) =>
    request<NotificationPreferences>("/api/settings/notifications", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  resolve: () => request<Plan>("/api/plan/solve", { method: "POST" }),
  intents: () => request<Intent[]>("/api/intents"),
  remove: (id: string) => request<void>(`/api/intents/${id}`, { method: "DELETE" }),
  update: (id: string, body: Record<string, unknown>) =>
    request<Intent>(`/api/intents/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  patchIntent: (
    id: string,
    body: {
      title?: string;
      priority?: Priority;
      category?: WorkCategory | null;
      deadline_date?: string | null;
    },
  ) =>
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
  activeTimeTracking: () =>
    request<TimeTrackingEntry | null>("/api/time-tracking/active"),
  timeTrackingStats: (intentId: string) =>
    request<TimeTrackingStats>(`/api/time-tracking/${intentId}/stats`),
  startTimeTracking: (intentId: string) =>
    request<TimeTrackingEntry>(`/api/time-tracking/${intentId}/start`, {
      method: "POST",
    }),
  pauseTimeTracking: (intentId: string) =>
    request<TimeTrackingEntry>(`/api/time-tracking/${intentId}/pause`, {
      method: "POST",
    }),
  resumeTimeTracking: (intentId: string) =>
    request<TimeTrackingEntry>(`/api/time-tracking/${intentId}/resume`, {
      method: "POST",
    }),
  stopTimeTracking: (intentId: string) =>
    request<TimeTrackingEntry>(`/api/time-tracking/${intentId}/stop`, {
      method: "POST",
    }),
  history: (limit = 50) =>
    request<ChangeHistoryEntry[]>(`/api/history?limit=${limit}`),
  undoHistory: (id: string) =>
    request<{ id: string; status: string; undone_at: string }>(
      `/api/history/${id}/undo`,
      { method: "POST" },
    ),
  setBusy: (events: Omit<Busy, "source">[]) =>
    request<{ events: number; blocks: number }>("/api/busy", {
      method: "PUT",
      body: JSON.stringify(events),
    }),
  todos: () => request<TodoInboxItem[]>("/api/todos"),
  createTodo: (body: {
    title: string;
    minutes: number;
    category?: WorkCategory | null;
    deadline_date?: string | null;
  }) =>
    request<TodoInboxItem>("/api/todos", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  suggestTodo: (id: string) =>
    request<TodoAISuggestion>(`/api/todos/${id}/suggest`, {
      method: "POST",
    }),
  patchTodo: (
    id: string,
    body: {
      title?: string;
      minutes?: number;
      category?: WorkCategory | null;
      deadline_date?: string | null;
    },
  ) =>
    request<TodoInboxItem>(`/api/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteTodo: (id: string) =>
    request<void>(`/api/todos/${id}`, { method: "DELETE" }),
  assignTodo: (id: string, body: { date: string; quadrant: 1 | 2 | 3 | 4 }) =>
    request<DailyItem>(`/api/todos/${id}/assign`, {
      method: "POST",
      body: JSON.stringify(body),
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
      category?: WorkCategory;
      deadline_date?: string | null;
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
      category?: WorkCategory;
      deadline_date?: string | null;
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
        category?: WorkCategory | null;
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
    category?: WorkCategory;
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
  moveDailyItemToTodo: (id: string) =>
    request<{ item_id: string; todo_id: string; status: string }>(
      `/api/daily/items/${id}/to-todo`,
      { method: "POST" },
    ),
  closeDaily: (date: string) =>
    request<{
      date: string;
      closed_at: string;
      change_set_id?: string;
      already_closed: boolean;
    }>(`/api/daily/${date}/close`, { method: "POST" }),
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
