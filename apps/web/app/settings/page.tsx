"use client";

import Link from "next/link";
import { useLanguage } from "@/app/components/LanguageProvider";
import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/app/components/Shell";
import {
  api,
  calendarPush,
  connections,
  sync,
  type NotificationPreferences,
  type Plan,
  type Provider,
} from "@/app/lib/api";
import {
  AlertCircle,
  BellRing,
  BookOpenText,
  Calendar,
  Check,
  CheckCircle2,
  Copy,
  Download,
  LogIn,
  Server,
  Unplug,
  UploadCloud,
} from "lucide-react";

type Result =
  | { ok: true; count: number; label: string; kind?: "sync" | "push" }
  | { ok: false; message: string }
  | null;

const CALENDAR_PROVIDERS: { id: Provider; label: string; icon: React.ReactNode }[] = [
  {
    id: "google",
    label: "Google Calendar",
    icon: (
      <svg viewBox="0 0 24 24" width="18" height="18" className="shrink-0">
        <path d="M21.35,11.1H12v2.7h5.38c-0.24,1.28 -0.96,2.37 -2.04,3.1v2.58h3.3c1.93,-1.78 3.04,-4.4 3.04,-7.48c0,-0.61 -0.05,-1.2 -0.15,-1.78Z" fill="#4285F4" />
        <path d="M12,20.6c2.43,0 4.47,-0.8 5.96,-2.18l-3.3,-2.58c-0.91,0.61 -2.08,0.98 -3.3,0.98c-2.35,0 -4.34,-1.58 -5.05,-3.72H2.9v2.66c1.48,2.94 4.51,4.84 8.02,4.84Z" fill="#34A853" />
        <path d="M6.95,13.1c-0.18,-0.54 -0.28,-1.11 -0.28,-1.7c0,-0.59 0.1,-1.16 0.28,-1.7V7.04H2.9C2.29,8.27 1.95,9.65 1.95,11.1c0,1.45 0.34,2.83 0.95,4.06l3.1,-2.42c-0.08,-0.22 -0.08,-0.42 -0.08,-0.64Z" fill="#FBBC05" />
        <path d="M12,4.18c1.32,0 2.5,0.45 3.44,1.35l2.58,-2.58C16.46,1.46 14.43,0.6 12,0.6C8.49,0.6 5.46,2.5 3.98,5.44l3.1,2.42c0.71,-2.14 2.7,-3.72 5.05,-3.72Z" fill="#EA4335" />
      </svg>
    ),
  },
  {
    id: "outlook",
    label: "Outlook / Microsoft 365",
    icon: (
      <svg viewBox="0 0 23 23" width="18" height="18" className="shrink-0">
        <rect x="0" y="0" width="11" height="11" fill="#F25022" />
        <rect x="12" y="0" width="11" height="11" fill="#7FBA00" />
        <rect x="0" y="12" width="11" height="11" fill="#00A1F1" />
        <rect x="12" y="12" width="11" height="11" fill="#FFB900" />
      </svg>
    ),
  },
];

const TRACKER_PROVIDERS: {
  id: Provider;
  label: string;
  className: string;
  /** No OAuth app exists for this provider (see integrations/<id>.py's
   *  docstring for why) — render the paste-a-credential input only, never
   *  the OAuth "Connect" button, which would point at a route that doesn't
   *  exist. */
  keyOnly?: boolean;
  placeholder?: string;
}[] = [
  { id: "linear", label: "Linear", className: "bg-[#5e6ad2] hover:bg-[#4b55a8] text-white" },
  {
    id: "todoist",
    label: "Todoist",
    className: "border border-red-200 bg-red-50/40 hover:bg-red-50 text-[#e44332]",
  },
  { id: "github", label: "GitHub", className: "bg-slate-900 hover:bg-slate-800 text-white" },
  {
    id: "notion",
    label: "Notion",
    className: "bg-black hover:bg-neutral-800 text-white",
    keyOnly: true,
    placeholder: "database_id:integration_token",
  },
  {
    id: "clickup",
    label: "ClickUp",
    className: "bg-[#7b68ee] hover:bg-[#6a58d6] text-white",
    keyOnly: true,
    placeholder: "team_id:api_token",
  },
  {
    id: "jira",
    label: "Jira",
    className: "bg-[#0052cc] hover:bg-[#0047b3] text-white",
    keyOnly: true,
    placeholder: "site:email:api_token",
  },
];

function minutesToTime(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
  const [hoursText, minutesText] = value.split(":");
  return Number(hoursText) * 60 + Number(minutesText);
}

export default function SettingsPage() {
  const { t, language, setLanguage } = useLanguage();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [icsUrl, setIcsUrl] = useState("");
  const [dav, setDav] = useState({ url: "", username: "", password: "" });
  const [trackerKeys, setTrackerKeys] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [feedUrl, setFeedUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("17:00");
  const [preferencesPending, setPreferencesPending] = useState(false);
  const [preferencesMessage, setPreferencesMessage] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationPreferences>({
    task_enabled: true,
    task_minutes_before: 15,
    task_at_start: true,
    meeting_enabled: true,
    meeting_minutes_before: 15,
    meeting_at_start: true,
    deadline_enabled: true,
    deadline_days_before: 1,
    deadline_time_min: 9 * 60,
    end_of_day_enabled: true,
    end_of_day_time_min: 20 * 60 + 30,
  });
  const [notificationsPending, setNotificationsPending] = useState(false);
  const [notificationsMessage, setNotificationsMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Two independent calls, so one failing doesn't have to take down a page
    // that's still partly usable — but a failure has to be visible somewhere,
    // or the API being down looks identical to a healthy fresh install with
    // nothing connected yet.
    let failure: string | null = null;
    try {
      setPlan(await api.plan());
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : "Could not reach the scheduler.";
    }
    try {
      setConnected(await connections.list());
    } catch (caught) {
      failure ??= caught instanceof Error ? caught.message : "Could not reach the scheduler.";
    }
    try {
      const preferences = await api.settings();
      setWorkStart(minutesToTime(preferences.preferred_workday_start_min));
      setWorkEnd(minutesToTime(preferences.preferred_workday_end_min));
    } catch (caught) {
      failure ??= caught instanceof Error ? caught.message : "Could not load settings.";
    }
    try {
      setNotifications(await api.notificationSettings());
    } catch (caught) {
      failure ??= caught instanceof Error ? caught.message : "Could not load notification settings.";
    }
    setLoadError(failure);
  }, []);

  useEffect(() => {
    void load();
    setFeedUrl(`${window.location.origin}/api/plan.ics`);

    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const provider = params.get("provider");
    if (status) {
      window.history.replaceState({}, document.title, window.location.pathname);
      if (status === "success" && provider) {
        void runSync(provider as Provider);
      } else if (status === "credentials_missing" && provider) {
        setResult({
          ok: false,
          message: `${provider} has no OAuth app configured on this server. Add HOROLOG_${provider.toUpperCase()}_CLIENT_ID / _SECRET to .env, or use a pasted key below if this provider supports one.`,
        });
      } else if (status === "error") {
        setResult({ ok: false, message: params.get("error") || "Authentication failed." });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function savePreferences() {
    const start = timeToMinutes(workStart);
    const end = timeToMinutes(workEnd);
    setPreferencesMessage(null);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setPreferencesMessage(t("Workday end must be after start."));
      return;
    }

    setPreferencesPending(true);
    try {
      const saved = await api.saveSettings({
        preferred_workday_start_min: start,
        preferred_workday_end_min: end,
      });
      setWorkStart(minutesToTime(saved.preferred_workday_start_min));
      setWorkEnd(minutesToTime(saved.preferred_workday_end_min));
      setPreferencesMessage(t("Settings saved."));
      await load();
    } catch (caught) {
      setPreferencesMessage(
        caught instanceof Error ? caught.message : t("Could not save settings."),
      );
    } finally {
      setPreferencesPending(false);
    }
  }

  async function saveNotificationPreferences() {
    setNotificationsMessage(null);
    setNotificationsPending(true);
    try {
      const saved = await api.saveNotificationSettings(notifications);
      setNotifications(saved);
      setNotificationsMessage(t("Notification settings saved."));
    } catch (caught) {
      setNotificationsMessage(
        caught instanceof Error
          ? caught.message
          : t("Could not save notification settings."),
      );
    } finally {
      setNotificationsPending(false);
    }
  }

  async function runSync(provider: Provider, credential?: string) {
    setPending(provider);
    setResult(null);
    try {
      let count = 0;
      let label = "events";
      if (provider === "google") {
        count = (await sync.google()).events;
      } else if (provider === "outlook") {
        count = (await sync.outlook()).events;
      } else if (provider === "linear") {
        count = (await sync.linear(credential)).issues;
        label = "issues";
      } else if (provider === "todoist") {
        count = (await sync.todoist(credential)).tasks;
        label = "tasks";
      } else if (provider === "github") {
        count = (await sync.github(credential)).issues;
        label = "issues";
      } else if (provider === "notion") {
        count = (await sync.notion(credential ?? "")).tasks;
        label = "tasks";
      } else if (provider === "clickup") {
        count = (await sync.clickup(credential ?? "")).tasks;
        label = "tasks";
      } else if (provider === "jira") {
        count = (await sync.jira(credential ?? "")).issues;
        label = "issues";
      }
      setResult({ ok: true, count, label });
      await load();
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : "Sync failed." });
    } finally {
      setPending(null);
    }
  }

  async function pushCalendar(provider: "google" | "outlook") {
    setPending(`push-${provider}`);
    setResult(null);
    try {
      const out = await calendarPush.push(provider);
      setResult({
        ok: true,
        count: out.created + out.moved + out.removed,
        label: `${out.created} created, ${out.moved} moved, ${out.removed} removed`,
        kind: "push",
      });
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : "Push failed." });
    } finally {
      setPending(null);
    }
  }

  async function disconnect(provider: Provider) {
    setPending(provider);
    try {
      await connections.disconnect(provider);
      await load();
    } finally {
      setPending(null);
    }
  }

  async function runIcs() {
    setPending("ics");
    setResult(null);
    try {
      const out = await sync.ics(icsUrl.trim());
      setResult({ ok: true, count: out.events, label: "events" });
      await load();
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : "Sync failed." });
    } finally {
      setPending(null);
    }
  }

  async function runCaldav() {
    setPending("caldav");
    setResult(null);
    try {
      const out = await sync.caldav(dav.url.trim(), dav.username, dav.password);
      setResult({ ok: true, count: out.events, label: "events" });
      await load();
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : "Sync failed." });
    } finally {
      setPending(null);
    }
  }

  function handleCopy() {
    if (!feedUrl) return;
    navigator.clipboard.writeText(feedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const mirrored = plan?.busy.length ?? 0;
  const bySource = (plan?.busy ?? []).reduce<Record<string, number>>((acc, event) => {
    acc[event.source] = (acc[event.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[800px] space-y-6 px-6 py-8">
        <header className="mb-4">
          <h1 className="text-[28px] font-bold text-fg">{t("Settings")}</h1>
          <p className="mt-1 text-[13.5px] font-medium text-fg-muted">
            {t("Planning preferences, language, calendars and export in one place.")}
          </p>
        </header>

        {loadError && (
          <div className="flex items-center gap-2.5 rounded-card border border-red-200 bg-red-50 p-4 text-[13.5px] font-medium text-danger shadow-sm">
            <AlertCircle size={18} className="shrink-0" />
            <span>
              {loadError} — {language === "pl"
                ? "status synchronizacji poniżej może być nieaktualny."
                : "sync status below may be stale."}
            </span>
          </div>
        )}

        {result && (
          <div
            className={`flex items-center gap-2.5 rounded-card border p-4 text-[13.5px] font-medium shadow-sm ${
              result.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-danger"
            }`}
          >
            {result.ok ? (
              <CheckCircle2 size={18} className="shrink-0 text-emerald-600" />
            ) : (
              <AlertCircle size={18} className="shrink-0" />
            )}
            <span>
              {result.ok
                ? result.kind === "push"
                  ? language === "pl"
                    ? `Wysłano do kalendarza: ${result.label}.`
                    : `Pushed to the calendar: ${result.label}.`
                  : language === "pl"
                    ? `Zsynchronizowano ${result.count} ${result.label}. Plan został przebudowany z uwzględnieniem tych danych.`
                    : `Synced ${result.count} ${result.label}. Your plan has been rebuilt around them.`
                : result.message}
            </span>
          </div>
        )}

        <section className="space-y-5 overflow-hidden rounded-card border border-black/[0.08] bg-surface p-6 shadow-sm">
          <div>
            <h2 className="text-[15px] font-bold text-fg">{t("Planning preferences")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              {t("Set the hours Horolog should prefer for automatically scheduled work. Manual fixed times can still be outside this range.")}
            </p>
          </div>

          <div className="border-t border-black/[0.06] pt-5">
            <div className="mb-2 text-[12px] font-semibold text-fg">{t("Language")}</div>
            <div className="grid max-w-[320px] grid-cols-2 gap-1 rounded-xl border border-black/[0.08] bg-sunk/40 p-1">
              <button
                type="button"
                onClick={() => setLanguage("pl")}
                className={`rounded-lg px-3 py-2 text-[12.5px] font-semibold transition-colors ${
                  language === "pl" ? "bg-white text-fg shadow-sm" : "text-fg-muted"
                }`}
              >
                {t("Polish")}
              </button>
              <button
                type="button"
                onClick={() => setLanguage("en")}
                className={`rounded-lg px-3 py-2 text-[12.5px] font-semibold transition-colors ${
                  language === "en" ? "bg-white text-fg shadow-sm" : "text-fg-muted"
                }`}
              >
                {t("English")}
              </button>
            </div>
          </div>

          <div className="border-t border-black/[0.06] pt-5">
            <div className="mb-2 text-[12px] font-semibold text-fg">{t("Suggested working hours")}</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1.5">
                <span className="block text-[11px] font-medium text-fg-muted">{t("From")}</span>
                <input
                  type="time"
                  step={900}
                  value={workStart}
                  onChange={(e) => setWorkStart(e.target.value)}
                  className="h-11 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
                />
              </label>
              <label className="space-y-1.5">
                <span className="block text-[11px] font-medium text-fg-muted">{t("To")}</span>
                <input
                  type="time"
                  step={900}
                  value={workEnd}
                  onChange={(e) => setWorkEnd(e.target.value)}
                  className="h-11 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-semibold outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                onClick={() => void savePreferences()}
                disabled={preferencesPending}
                className="inline-flex h-11 items-center rounded-xl bg-accent px-5 text-[13.5px] font-semibold text-on-accent shadow-sm transition-all hover:bg-accent-hover disabled:opacity-50"
              >
                {preferencesPending ? t("Saving...") : t("Save Changes")}
              </button>
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-subtle">
              {t("This is the default window for flexible auto-scheduling. A task, break or meeting you place manually at a specific time remains authoritative.")}
            </p>
            {preferencesMessage && (
              <div className="mt-3 text-[12px] font-medium text-fg-muted">
                {preferencesMessage}
              </div>
            )}
          </div>
        </section>

        <section className="space-y-5 overflow-hidden rounded-card border border-black/[0.08] bg-surface p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sunk text-fg">
              <BellRing size={18} />
            </span>
            <div>
              <h2 className="text-[15px] font-bold text-fg">{t("Notifications")}</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
                {t("Choose what Planer Horolog should remind you about and when. These settings are shared with the Android app.")}
              </p>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-black/[0.07] bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-fg">{t("Tasks")}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-muted">{t("Remind me before scheduled task blocks.")}</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setNotifications((current) => ({ ...current, task_enabled: !current.task_enabled }))
                  }
                  aria-pressed={notifications.task_enabled}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    notifications.task_enabled ? "bg-accent" : "bg-black/10"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      notifications.task_enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="text-[11px] font-medium text-fg-muted">
                  {t("Before start")}
                  <select
                    value={notifications.task_minutes_before}
                    disabled={!notifications.task_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({
                        ...current,
                        task_minutes_before: Number(e.target.value),
                      }))
                    }
                    className="ml-2 h-9 rounded-lg border border-black/[0.08] bg-surface px-2.5 text-[12px] font-semibold text-fg disabled:opacity-40"
                  >
                    {[0, 5, 10, 15, 30, 60].map((value) => (
                      <option key={value} value={value}>
                        {value === 0 ? t("Off") : `${value} min`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11.5px] font-medium text-fg-muted">
                  <input
                    type="checkbox"
                    checked={notifications.task_at_start}
                    disabled={!notifications.task_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({ ...current, task_at_start: e.target.checked }))
                    }
                  />
                  {t("At start time")}
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-black/[0.07] bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-fg">{t("Meetings")}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-muted">{t("Remind me before meetings.")}</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setNotifications((current) => ({ ...current, meeting_enabled: !current.meeting_enabled }))
                  }
                  aria-pressed={notifications.meeting_enabled}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    notifications.meeting_enabled ? "bg-accent" : "bg-black/10"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      notifications.meeting_enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="text-[11px] font-medium text-fg-muted">
                  {t("Before start")}
                  <select
                    value={notifications.meeting_minutes_before}
                    disabled={!notifications.meeting_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({
                        ...current,
                        meeting_minutes_before: Number(e.target.value),
                      }))
                    }
                    className="ml-2 h-9 rounded-lg border border-black/[0.08] bg-surface px-2.5 text-[12px] font-semibold text-fg disabled:opacity-40"
                  >
                    {[0, 5, 10, 15, 30, 60].map((value) => (
                      <option key={value} value={value}>
                        {value === 0 ? t("Off") : `${value} min`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11.5px] font-medium text-fg-muted">
                  <input
                    type="checkbox"
                    checked={notifications.meeting_at_start}
                    disabled={!notifications.meeting_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({ ...current, meeting_at_start: e.target.checked }))
                    }
                  />
                  {t("At start time")}
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-black/[0.07] bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-fg">{t("Max deadline")}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-muted">{t("Warn me before a task reaches its maximum deadline.")}</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setNotifications((current) => ({ ...current, deadline_enabled: !current.deadline_enabled }))
                  }
                  aria-pressed={notifications.deadline_enabled}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    notifications.deadline_enabled ? "bg-accent" : "bg-black/10"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      notifications.deadline_enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <label className="text-[11px] font-medium text-fg-muted">
                  {t("Days before")}
                  <select
                    value={notifications.deadline_days_before}
                    disabled={!notifications.deadline_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({
                        ...current,
                        deadline_days_before: Number(e.target.value),
                      }))
                    }
                    className="ml-2 h-9 rounded-lg border border-black/[0.08] bg-surface px-2.5 text-[12px] font-semibold text-fg disabled:opacity-40"
                  >
                    {[0, 1, 2, 3, 7].map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px] font-medium text-fg-muted">
                  {t("At")}
                  <input
                    type="time"
                    step={900}
                    value={minutesToTime(notifications.deadline_time_min)}
                    disabled={!notifications.deadline_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({
                        ...current,
                        deadline_time_min: timeToMinutes(e.target.value),
                      }))
                    }
                    className="ml-2 h-9 rounded-lg border border-black/[0.08] bg-surface px-2.5 text-[12px] font-semibold text-fg disabled:opacity-40"
                  />
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-black/[0.07] bg-bg p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-fg">{t("End of day")}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-muted">
                    {t("Remind me to review today and refine tomorrow's plan.")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setNotifications((current) => ({
                      ...current,
                      end_of_day_enabled: !current.end_of_day_enabled,
                    }))
                  }
                  aria-pressed={notifications.end_of_day_enabled}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    notifications.end_of_day_enabled ? "bg-accent" : "bg-black/10"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                      notifications.end_of_day_enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-4">
                <label className="text-[11px] font-medium text-fg-muted">
                  {t("Reminder time")}
                  <input
                    type="time"
                    step={900}
                    value={minutesToTime(notifications.end_of_day_time_min)}
                    disabled={!notifications.end_of_day_enabled}
                    onChange={(e) =>
                      setNotifications((current) => ({
                        ...current,
                        end_of_day_time_min: timeToMinutes(e.target.value),
                      }))
                    }
                    className="ml-2 h-9 rounded-lg border border-black/[0.08] bg-surface px-2.5 text-[12px] font-semibold text-fg disabled:opacity-40"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-black/[0.06] pt-4">
            <button
              type="button"
              onClick={() => void saveNotificationPreferences()}
              disabled={notificationsPending}
              className="inline-flex h-10 items-center rounded-xl bg-accent px-4 text-[12.5px] font-semibold text-on-accent shadow-sm transition-all hover:bg-accent-hover disabled:opacity-50"
            >
              {notificationsPending ? t("Saving...") : t("Save notification settings")}
            </button>
            {notificationsMessage && (
              <span className="text-[12px] font-medium text-fg-muted">{notificationsMessage}</span>
            )}
          </div>
        </section>

        <section className="space-y-5 overflow-hidden rounded-card border border-black/[0.08] bg-surface p-6 shadow-sm">
          <div>
            <h2 className="text-[15px] font-bold text-fg">{t("Access & Manifesto")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              {t("Access information and the principles behind Horolog live here instead of on the start page.")}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Link
              href="/login"
              className="group flex items-center gap-3 rounded-xl border border-black/[0.07] bg-bg px-4 py-3.5 transition-all hover:border-black/[0.12] hover:bg-sunk/60"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sunk text-fg">
                <LogIn size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-fg">{t("Login / access")}</span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-fg-muted">
                  {t("Open the instance access screen.")}
                </span>
              </span>
              <span className="text-[16px] text-fg-subtle transition-transform group-hover:translate-x-0.5">→</span>
            </Link>

            <div className="rounded-xl border border-black/[0.07] bg-bg px-4 py-3.5">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sunk text-fg">
                  <BookOpenText size={18} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-fg">{t("Horolog Manifesto")}</div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">
                    {t("Tasks, habits, focus time and meetings share one honest timeline. Horolog protects deliberate work, stays local-first and lets explicit user decisions override automation.")}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <details className="group rounded-xl border border-black/[0.07] bg-sunk/30">
            <summary className="cursor-pointer list-none px-4 py-3 text-[12.5px] font-semibold text-fg">
              {t("Read manifesto principles")}
            </summary>
            <div className="grid gap-3 border-t border-black/[0.06] p-4 sm:grid-cols-2">
              {[
                {
                  title: "One timeline",
                  description:
                    "Tasks, habits, focus blocks and meetings compete for the same real time instead of living in separate silos.",
                },
                {
                  title: "Cognitive scheduling",
                  description:
                    "Flexible work is fitted around hard commitments and can adapt when the plan changes.",
                },
                {
                  title: "Local-first",
                  description:
                    "The engine can run on your own infrastructure and use local models, keeping control close to the user.",
                },
                {
                  title: "User decisions win",
                  description:
                    "A manually fixed time, move or resize is authoritative; automation should assist rather than silently overrule it.",
                },
                {
                  title: "Open integrations",
                  description:
                    "Calendars and external task systems can feed the same planning engine without becoming the source of truth for your day.",
                },
              ].map(({ title, description }) => (
                <div key={title} className="rounded-lg bg-surface p-3">
                  <div className="text-[12px] font-semibold text-fg">{t(title)}</div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">{t(description)}</p>
                </div>
              ))}
            </div>
          </details>
        </section>

        <div className="flex items-center justify-between px-1">
          <div>
            <h2 className="text-[17px] font-bold text-fg">{t("Calendars & Sync")}</h2>
            <p className="mt-0.5 text-[12px] text-fg-muted">
              {mirrored} {mirrored === 1 ? t("event mirrored") : t("events mirrored")} ·{" "}
              {Object.keys(bySource).length || 0} {t("active sources")}
            </p>
          </div>
        </div>

        {/* Calendars — OAuth, or paste an ICS/CalDAV address directly */}
        <section className="space-y-5 overflow-hidden rounded-card border border-black/[0.08] bg-surface p-6 shadow-sm">
          <div>
            <h2 className="text-[15px] font-bold text-fg">{t("Connect a calendar")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              {t("OAuth needs your own app credentials — self-hosting means there is no shared client to hand out (see .env.example). The feed and server options below need none.")}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {CALENDAR_PROVIDERS.map((p) => {
              const isConnected = connected[p.id];
              return (
                <div key={p.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => (isConnected ? runSync(p.id) : (window.location.href = `/api/auth/${p.id}`))}
                    disabled={pending !== null}
                    className="flex h-11 flex-1 items-center justify-center gap-3 rounded-xl border border-black/[0.08] bg-white px-4 text-[13.5px] font-semibold text-stone-700 shadow-sm transition-all hover:bg-stone-50 disabled:opacity-50"
                  >
                    {p.icon}
                    <span>
                      {pending === p.id
                        ? t("Working…")
                        : isConnected
                          ? `${t("Re-sync")} ${p.label}`
                          : `${t("Connect")} ${p.label}`}
                    </span>
                    {isConnected && <CheckCircle2 size={15} className="text-emerald-600" />}
                  </button>
                  {isConnected && (
                    <button
                      type="button"
                      onClick={() => pushCalendar(p.id as "google" | "outlook")}
                      disabled={pending !== null}
                      aria-label={`${t("Push the plan to")} ${p.label}`}
                      title={`Push scheduled blocks onto a dedicated "Horolog" calendar on ${p.label} — needs HOROLOG_CALENDAR_WRITEBACK_ENABLED=true`}
                      className="flex h-11 w-11 items-center justify-center rounded-xl border border-black/[0.08] bg-white text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                    >
                      {pending === `push-${p.id}` ? (
                        <span className="tabular text-[10px] font-semibold">…</span>
                      ) : (
                        <UploadCloud size={15} />
                      )}
                    </button>
                  )}
                  {isConnected && (
                    <button
                      type="button"
                      onClick={() => disconnect(p.id)}
                      disabled={pending !== null}
                      aria-label={`${t("Disconnect")} ${p.label}`}
                      title={`${t("Disconnect")} ${p.label}`}
                      className="flex h-11 w-11 items-center justify-center rounded-xl border border-black/[0.08] bg-white text-fg-muted transition-colors hover:border-red-200 hover:text-danger disabled:opacity-50"
                    >
                      <Unplug size={15} />
                    </button>
                  )}
                </div>
              );
            })}
            <p className="text-[12px] leading-relaxed text-fg-subtle">
              <UploadCloud size={12} className="mb-0.5 mr-1 inline" />
              {t("Push writes scheduled blocks onto a dedicated Horolog calendar as real events — never your primary calendar. Off by default; enable with")}{" "}
              <code className="rounded bg-sunk px-1 py-0.5 font-mono">
                HOROLOG_CALENDAR_WRITEBACK_ENABLED=true
              </code>{" "}
              {t("and reconnect the account above once to grant write access.")}
            </p>
          </div>

          <div className="border-t border-black/[0.06] pt-5">
            <div className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-fg">
              <Calendar size={15} className="text-accent" />
              {t("Subscribe to a published iCal (.ics) feed")}
            </div>
            <div className="flex flex-wrap gap-2.5">
              <input
                value={icsUrl}
                onChange={(e) => setIcsUrl(e.target.value)}
                placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                className="h-11 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-medium outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={runIcs}
                disabled={!icsUrl.trim() || pending !== null}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-accent px-5 text-[13.5px] font-semibold text-on-accent shadow-sm transition-all hover:bg-accent-hover disabled:opacity-40"
              >
                {pending === "ics" ? t("Syncing…") : t("Sync Feed")}
              </button>
            </div>
          </div>

          <div className="border-t border-black/[0.06] pt-5">
            <div className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-fg">
              <Server size={15} className="text-accent" />
              {t("Connect a CalDAV server")}
            </div>
            <div className="grid gap-2.5 sm:grid-cols-3">
              <input
                value={dav.url}
                onChange={(e) => setDav({ ...dav, url: e.target.value })}
                placeholder="https://dav.example.com/"
                className="h-11 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-medium outline-none focus:border-accent sm:col-span-3"
              />
              <input
                value={dav.username}
                onChange={(e) => setDav({ ...dav, username: e.target.value })}
                placeholder={t("username")}
                autoComplete="username"
                className="h-11 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-medium outline-none focus:border-accent"
              />
              <input
                type="password"
                value={dav.password}
                onChange={(e) => setDav({ ...dav, password: e.target.value })}
                placeholder={t("app password")}
                autoComplete="current-password"
                className="h-11 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[14px] font-medium outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={runCaldav}
                disabled={!dav.url.trim() || pending !== null}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[13.5px] font-semibold text-on-accent shadow-sm transition-all hover:bg-accent-hover disabled:opacity-40"
              >
                {pending === "caldav" ? t("Connecting…") : t("Connect")}
              </button>
            </div>
          </div>
        </section>

        {/* Trackers — OAuth, or paste a personal key */}
        <section className="space-y-4 overflow-hidden rounded-card border border-black/[0.08] bg-surface p-6 shadow-sm">
          <div>
            <h2 className="text-[15px] font-bold text-fg">{t("Connect a tracker")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              {t("Started issues and open tasks are scheduled as tasks, fluidly, around everything else. A personal API key needs no OAuth app.")}
            </p>
          </div>
          <div className="space-y-3">
            {TRACKER_PROVIDERS.map((p) => {
              const isConnected = connected[p.id];
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-2">
                  {!p.keyOnly && (
                    <button
                      type="button"
                      onClick={() => (isConnected ? runSync(p.id) : (window.location.href = `/api/auth/${p.id}`))}
                      disabled={pending !== null}
                      className={`flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] font-semibold shadow-sm transition-all disabled:opacity-50 ${p.className}`}
                    >
                      <span>
                        {pending === p.id
                          ? t("Working…")
                          : isConnected
                            ? `${t("Re-sync")} ${p.label}`
                            : `${t("Connect")} ${p.label}`}
                      </span>
                      {isConnected && <CheckCircle2 size={15} />}
                    </button>
                  )}
                  {isConnected && (
                    <button
                      type="button"
                      onClick={() => disconnect(p.id)}
                      disabled={pending !== null}
                      aria-label={`Disconnect ${p.label}`}
                      title={`Disconnect ${p.label}`}
                      className="flex h-11 w-11 items-center justify-center rounded-xl border border-black/[0.08] bg-white text-fg-muted transition-colors hover:border-red-200 hover:text-danger disabled:opacity-50"
                    >
                      <Unplug size={15} />
                    </button>
                  )}
                  {!p.keyOnly && <span className="text-fg-subtle">{t("or")}</span>}
                  {p.keyOnly && (
                    <span className="flex h-11 items-center gap-2 rounded-xl px-4 text-[13.5px] font-semibold text-fg-muted">
                      {p.label}
                    </span>
                  )}
                  <input
                    type="password"
                    value={trackerKeys[p.id] ?? ""}
                    onChange={(e) => setTrackerKeys({ ...trackerKeys, [p.id]: e.target.value })}
                    placeholder={p.placeholder ?? "paste a personal API key"}
                    className="h-11 min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-bg px-3.5 text-[13px] font-medium outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => runSync(p.id, trackerKeys[p.id])}
                    disabled={!trackerKeys[p.id]?.trim() || pending !== null}
                    className="inline-flex h-11 items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-4 text-[13px] font-semibold text-fg shadow-sm transition-all hover:bg-sunk disabled:opacity-40"
                  >
                    {t("Sync")}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Subscribable Plan Feed */}
        <section className="overflow-hidden rounded-card border border-black/[0.08] bg-surface p-6 shadow-sm">
          <div>
            <h2 className="text-[15px] font-bold text-fg">{t("Subscribe to your Horolog plan")}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
              Read-only from Apple Calendar, Google, or Outlook — see your auto-scheduled blocks
              alongside external events.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <code className="tabular min-w-0 flex-1 truncate rounded-xl border border-black/[0.08] bg-bg px-4 py-2.5 text-[12.5px] font-mono font-medium text-fg-muted">
              {feedUrl || "/api/plan.ics"}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-black/[0.08] bg-surface px-4 text-[13px] font-semibold text-fg shadow-sm transition-all hover:bg-sunk"
            >
              {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} className="text-fg-muted" />}
              {copied ? t("Copied!") : t("Copy Feed Link")}
            </button>
            <a
              href="/api/plan.ics"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 text-[13px] font-semibold text-white shadow-sm transition-all hover:bg-slate-800"
            >
              <Download size={14} /> {t("Download .ics")}
            </a>
          </div>
        </section>
      </main>
    </Shell>
  );
}
