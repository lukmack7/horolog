"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Calendar,
  Clock,
  Inbox,
  RotateCcw,
  Users,
  BarChart3,
  Link2,
  Sparkles,
  Command,
  Activity,
  Hexagon,
  MoreHorizontal,
  X,
  ChevronRight,
  BookOpenCheck,
} from "lucide-react";
import { CommandBar } from "@/app/components/CommandBar";
import { useLanguage } from "@/app/components/LanguageProvider";

const NAV = [
  { href: "/time", label: "Time", icon: Clock },
  { href: "/planner", label: "Planner", icon: Calendar },
  { href: "/daily", label: "Daily", icon: BookOpenCheck },
  { href: "/habits", label: "Habits", icon: RotateCcw },
  { href: "/inbox", label: "Task inbox", icon: Inbox },
  { href: "/meetings", label: "Meetings", icon: Users },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/connect", label: "Calendars", icon: Link2 },
] as const;

/** Ultra-Luxury Shell Navigation for Horolog.
 *  Features Shadcn-style sidebar, Framer Motion animated active nav pill,
 *  Apple-style pulsing live indicator, and ⌘K trigger.
 */
export function Shell({
  children,
  onPlanChange,
}: {
  children: React.ReactNode;
  onPlanChange?: () => void;
}) {
  const pathname = usePathname();
  const { language, setLanguage, t } = useLanguage();
  const [commandOpen, setCommandOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [live, setLive] = useState(true);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const stream = new EventSource("/api/stream");
    stream.addEventListener("plan", () => {
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
      onPlanChange?.();
    });
    // The browser retries a dropped SSE connection on its own, so this isn't
    // a fatal error — but the "Engine steady" dot was previously static and
    // green regardless of whether the stream was actually alive, which is
    // misleading during a backend restart or outage.
    stream.onerror = () => setLive(false);
    stream.onopen = () => setLive(true);
    return () => stream.close();
  }, [onPlanChange]);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-[220px] shrink-0 flex-col border-r border-border bg-background px-3.5 py-5 lg:flex">
        {/* Brand Mark */}
        <Link
          href="/"
          className="group mb-7 flex items-center gap-2.5 px-2 transition-opacity duration-200 hover:opacity-80"
        >
          <div className="relative flex items-center justify-center text-primary">
            <Hexagon className="h-7 w-7" />
          </div>
          <div className="flex flex-col">
            <span className="text-[16px] font-serif tracking-tight text-foreground">Horolog</span>
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {t("Defend Time")}
            </span>
          </div>
        </Link>

        {/* Navigation items with spring layout active indicator */}
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex h-9.5 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors duration-150 ${
                  active ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {active && (
                  <motion.div
                    layoutId="activeNav"
                    className="absolute inset-0 rounded-lg bg-secondary"
                    transition={{ type: "spring", stiffness: 450, damping: 35 }}
                  />
                )}
                <span className="relative z-10">
                  <Icon size={17} className={active ? "text-foreground" : "text-muted-foreground"} />
                </span>
                <span className="relative z-10">{t(item.label)}</span>
              </Link>
            );
          })}
        </nav>

        {/* Quick Capture Button (⌘K) */}
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className="group mt-5 flex h-10 items-center justify-between rounded-xl border border-border bg-background px-3 text-[13px] text-muted-foreground transition-all duration-200 hover:bg-secondary hover:text-foreground"
        >
          <span className="flex items-center gap-2 font-medium">
            <Sparkles size={14} className="text-foreground transition-transform duration-200 group-hover:rotate-12" />
            {t("Ask Horolog")}
          </span>
          <kbd className="tabular inline-flex items-center gap-0.5 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10.5px] font-mono text-muted-foreground">
            <Command size={10} />K
          </kbd>
        </button>

        <div className="mt-4 flex items-center gap-1 rounded-xl border border-border bg-secondary/30 p-1" aria-label="Language">
          <button type="button" onClick={() => setLanguage("pl")} className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors ${language === "pl" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>PL</button>
          <button type="button" onClick={() => setLanguage("en")} className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors ${language === "en" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>EN</button>
        </div>

        {/* Live SSE Plan Status Indicator */}
        <div className="mt-auto flex items-center justify-between rounded-xl border border-border bg-secondary/30 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {live && (
                <span
                  className={`absolute inline-flex h-full w-full rounded-full opacity-75 transition-colors duration-300 ${
                    pulse ? "animate-ping bg-foreground" : "bg-green-500"
                  }`}
                />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full transition-colors duration-300 ${
                  !live ? "bg-red-400" : pulse ? "bg-foreground" : "bg-green-500"
                }`}
              />
            </span>
            <span className="text-[11.5px] font-medium text-muted-foreground">
              {t(!live ? "Reconnecting..." : pulse ? "Optimizing..." : "Engine steady")}
            </span>
          </div>
          <Activity size={13} className={pulse ? "animate-spin text-foreground" : "text-muted-foreground"} />
        </div>
      </aside>

      {/* Mobile-only capture button. Keep it above the bottom navigation and
          away from the device safe area. */}
      {!mobileMoreOpen && (
        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          aria-label={t("Ask Horolog")}
          className="fixed bottom-20 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-pop transition-transform active:scale-95 lg:hidden"
        >
          <Sparkles size={20} />
        </button>
      )}

      {/* Mobile secondary navigation: compact, opaque action sheet. */}
      {mobileMoreOpen && (
        <>
          <button
            type="button"
            aria-label={t("Close more navigation")}
            onClick={() => setMobileMoreOpen(false)}
            className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          />
          <div
            className="fixed left-3 right-3 z-40 rounded-[24px] border border-black/[0.08] p-3 shadow-2xl lg:hidden"
            style={{
              bottom: "calc(4.5rem + env(safe-area-inset-bottom))",
              backgroundColor: "#ffffff",
            }}
            role="dialog"
            aria-modal="true"
            aria-label={t("More navigation")}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <MoreHorizontal size={18} className="text-muted-foreground" />
                <span className="text-[13px] font-semibold text-foreground">{t("More")}</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMoreOpen(false)}
                aria-label={t("Close")}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <nav
              className="overflow-hidden rounded-2xl border border-black/[0.07]"
              style={{ backgroundColor: "#ffffff" }}
            >
              {NAV.slice(4).map((item, index) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMoreOpen(false)}
                    className={`flex h-[54px] items-center gap-3 px-3.5 transition-colors ${
                      index > 0 ? "border-t border-black/[0.06]" : ""
                    } ${
                      active
                        ? "bg-secondary font-semibold text-foreground"
                        : "text-foreground hover:bg-secondary/60"
                    }`}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0 flex-1 text-[13px] font-medium">{t(item.label)}</span>
                    <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
                  </Link>
                );
              })}
            </nav>
          </div>
        </>
      )}

      {/* Mobile Nav */}
      <div
        className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-5 border-t border-border bg-white px-1 lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {NAV.slice(0, 4).map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 ${
                active ? "font-semibold text-foreground" : "text-muted-foreground"
              }`}
            >
              <Icon size={19} className={active ? "text-foreground" : "text-muted-foreground"} />
              <span className="max-w-full truncate text-[9.5px] leading-tight">{t(item.label)}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileMoreOpen((open) => !open)}
          aria-expanded={mobileMoreOpen}
          className={`flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 ${
            mobileMoreOpen || NAV.slice(4).some((item) => pathname === item.href)
              ? "font-semibold text-foreground"
              : "text-muted-foreground"
          }`}
        >
          <MoreHorizontal size={20} />
          <span className="text-[9.5px] leading-tight">{t("More")}</span>
        </button>
      </div>

      <main id="main" className="min-w-0 flex-1 overflow-x-hidden pb-24 lg:overflow-visible lg:pb-0">{children}</main>
      <CommandBar
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onCaptured={() => onPlanChange?.()}
      />
    </div>
  );
}
