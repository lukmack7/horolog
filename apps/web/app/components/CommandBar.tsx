"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/app/components/LanguageProvider";
import {
  AlertCircle,
  AtSign,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  CirclePlus,
  Hash,
  Loader2,
  RefreshCcw,
  Send,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import {
  api,
  WORK_CATEGORIES,
  WORK_CATEGORY_LABEL,
  type AssistantAction,
  type AssistantMessage,
  type AssistantReference,
  type Block,
  type TodoInboxItem,
} from "@/app/lib/api";

type MentionTrigger = {
  kind: "intent" | "category";
  query: string;
  start: number;
};

type MentionOption = {
  key: string;
  label: string;
  meta: string;
  reference: AssistantReference;
};

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pl-PL");
}

function localDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function detectMentionTrigger(value: string): MentionTrigger | null {
  const match = value.match(/(^|\s)([@#])([^@#\[\]\n]*)$/);
  if (!match) return null;
  const prefix = match[1] ?? "";
  const symbol = match[2];
  const query = (match[3] ?? "").trim();
  return {
    kind: symbol === "@" ? "intent" : "category",
    query,
    start: (match.index ?? 0) + prefix.length,
  };
}

function safeTokenLabel(value: string): string {
  return value.replaceAll("]", ")");
}

function blockTime(block: Block): string {
  const start = new Date(block.start);
  const end = new Date(block.end);
  return `${start.toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  })}–${end.toLocaleTimeString("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function actionLabel(action: AssistantAction): string {
  if (action.action === "create_task") {
    const quadrant = action.quadrant ? `Q${action.quadrant}` : "";
    return `Dodaj zadanie · ${action.date ?? "bez daty"} · ${action.minutes ?? "?"} min ${quadrant}`;
  }
  if (action.action === "create_meeting") {
    const hour =
      action.start_min == null
        ? "bez godziny"
        : `${String(Math.floor(action.start_min / 60)).padStart(2, "0")}:${String(
            action.start_min % 60,
          ).padStart(2, "0")}`;
    return `Dodaj spotkanie · ${action.date ?? "bez daty"} · ${hour} · ${action.minutes ?? "?"} min`;
  }
  if (action.action === "create_break") {
    const hour =
      action.start_min == null
        ? "bez godziny"
        : `${String(Math.floor(action.start_min / 60)).padStart(2, "0")}:${String(
            action.start_min % 60,
          ).padStart(2, "0")}`;
    return `Dodaj przerwę · ${action.date ?? "bez daty"} · ${hour} · ${action.minutes ?? "?"} min`;
  }
  if (action.action === "swap_tasks") {
    return "Zamień miejscami dwa zaplanowane zadania";
  }
  if (
    action.action === "reschedule_task" ||
    action.action === "reschedule_break" ||
    action.action === "reschedule_meeting"
  ) {
    const parts = [
      action.action === "reschedule_break"
        ? "Edytuj przerwę"
        : action.action === "reschedule_meeting"
          ? "Edytuj spotkanie"
          : "Edytuj zadanie",
    ];
    if (action.date) parts.push(action.date);
    if (action.start_min != null) {
      parts.push(
        `${String(Math.floor(action.start_min / 60)).padStart(2, "0")}:${String(
          action.start_min % 60,
        ).padStart(2, "0")}`,
      );
    }
    if (action.minutes != null) parts.push(`${action.minutes} min`);
    return parts.join(" · ");
  }
  if (action.action === "complete_task") {
    return "Oznacz zadanie jako wykonane";
  }
  if (action.action === "find_time") {
    return `Znajdź wolne miejsce · ${action.minutes ?? "?"} min`;
  }
  return `Aktualizuj Daily · ${action.date ?? ""}`;
}

function actionTitle(action: AssistantAction): string {
  if (action.action === "swap_tasks") return "Zamień zadania miejscami";
  if (action.title) return action.title;
  if (action.win_condition) return `Dzisiaj wygrywam, jeśli: ${action.win_condition}`;
  if (action.first_step) return `Zaczynam od: ${action.first_step}`;
  return action.intent_id ?? "Zmiana w planie";
}


function executionSummary(results: Array<Record<string, unknown>>): string {
  const lines = results.map((result) => {
    const action = typeof result.action === "string" ? result.action : "change";
    const title = typeof result.title === "string" ? result.title : "Zmiana";
    const status = typeof result.status === "string" ? result.status : "done";
    const detail = typeof result.detail === "string" ? result.detail : "";
    if (status === "failed") {
      return `⚠ Nie wykonano: ${title}${detail ? ` — ${detail}` : ""}`;
    }
    const scheduled = Array.isArray(result.scheduled) ? result.scheduled : [];
    const first = scheduled[0];

    let when = "";
    if (first && typeof first === "object" && first !== null) {
      const start = (first as Record<string, unknown>).start;
      const end = (first as Record<string, unknown>).end;
      if (typeof start === "string" && typeof end === "string") {
        const startDate = new Date(start);
        const endDate = new Date(end);
        when = ` — ${startDate.toLocaleDateString("pl-PL", {
          weekday: "short",
          day: "numeric",
          month: "short",
        })} ${startDate.toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
        })}–${endDate.toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
        })}`;
      }
    }

    if (action === "swap_tasks") {
      const otherTitle =
        typeof result.other_title === "string" ? result.other_title : "drugie zadanie";
      const scheduledItems = Array.isArray(result.scheduled) ? result.scheduled : [];
      const describe = (item: unknown) => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        const itemTitle = typeof record.title === "string" ? record.title : "Zadanie";
        const start = typeof record.start === "string" ? new Date(record.start) : null;
        const end = typeof record.end === "string" ? new Date(record.end) : null;
        if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          return itemTitle;
        }
        return `${itemTitle} → ${start.toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
        })}–${end.toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
        })}`;
      };
      const details = scheduledItems.map(describe).filter(Boolean).join("; ");
      return `✓ Zamieniono miejscami: ${title} ↔ ${otherTitle}${details ? ` — ${details}` : ""}`;
    }
    if (action === "complete_task") return `✓ Wykonane: ${title}`;
    if (action === "update_daily_plan") return "✓ Daily zaktualizowane";
    if (action === "reschedule_task") return `✓ Zadanie zmienione: ${title}${when}`;
    if (action === "reschedule_break") return `✓ Przerwa zmieniona: ${title}${when}`;
    if (action === "reschedule_meeting") return `✓ Spotkanie zmienione: ${title}${when}`;
    if (action === "create_meeting") return `✓ Spotkanie: ${title}${when}`;
    if (action === "create_break") return `✓ Przerwa: ${title}${when}`;
    return `✓ Zadanie: ${title}${when}`;
  });

  return ["Gotowe. Wykonałem uzgodnione zmiany:", ...lines].join("\n");
}

export function CommandBar({
  open,
  onClose,
  onCaptured,
}: {
  open: boolean;
  onClose: () => void;
  onCaptured: () => void;
}) {
  const pathname = usePathname();
  const { t } = useLanguage();
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      role: "assistant",
      content:
        "Co chcesz zaplanować albo zmienić? Użyj @, aby wskazać wpis z Plannera lub „Do zrobienia”, oraz #, aby wskazać kategorię. Niczego nie zmienię bez Twojego potwierdzenia.",
    },
  ]);
  const [input, setInput] = useState("");
  const [inputReferences, setInputReferences] = useState<AssistantReference[]>([]);
  const [mentionBlocks, setMentionBlocks] = useState<Block[]>([]);
  const [mentionTodos, setMentionTodos] = useState<TodoInboxItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pendingActions, setPendingActions] = useState<AssistantAction[]>([]);
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const executingRef = useRef(false);

  const hasProposal = pendingActions.length > 0;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([api.plan(), api.todos()])
      .then(([plan, todos]) => {
        if (cancelled) return;
        setMentionBlocks(plan.blocks);
        setMentionTodos(todos);
      })
      .catch(() => {
        if (cancelled) return;
        setMentionBlocks([]);
        setMentionTodos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const mentionTrigger = useMemo(() => detectMentionTrigger(input), [input]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionTrigger) return [];

    const query = normalizeSearch(mentionTrigger.query);

    if (mentionTrigger.kind === "category") {
      return WORK_CATEGORIES.map((category) => {
        const label = WORK_CATEGORY_LABEL[category];
        const token = `#[${safeTokenLabel(label)}]`;
        return {
          key: `category:${category}`,
          label,
          meta: "Kategoria",
          reference: {
            kind: "category" as const,
            token,
            category,
          },
        };
      })
        .filter((option) => normalizeSearch(option.label).includes(query))
        .slice(0, 8);
    }

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const allowedDays = new Set([localDayKey(now), localDayKey(tomorrow)]);

    const candidates = mentionBlocks
      .filter((block) => {
        if (block.completed || block.recurring) return false;
        if (!["task", "meeting", "buffer"].includes(block.kind)) return false;
        return allowedDays.has(localDayKey(new Date(block.start)));
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

    const duplicateTitles = new Map<string, number>();
    for (const block of candidates) {
      const key = normalizeSearch(block.title);
      duplicateTitles.set(key, (duplicateTitles.get(key) ?? 0) + 1);
    }

    const plannerOptions = candidates
      .map((block) => {
        const start = new Date(block.start);
        const dateLabel =
          localDayKey(start) === localDayKey(now) ? "Dzisiaj" : "Jutro";
        const categoryLabel = block.category
          ? WORK_CATEGORY_LABEL[block.category]
          : null;
        const typeLabel =
          block.kind === "meeting"
            ? "Spotkanie"
            : block.kind === "buffer"
              ? "Przerwa"
              : "Zadanie";
        const searchable = normalizeSearch(
          [
            block.title,
            categoryLabel ?? "",
            typeLabel,
            dateLabel,
            blockTime(block),
          ].join(" "),
        );
        const needsTime =
          (duplicateTitles.get(normalizeSearch(block.title)) ?? 0) > 1;
        const tokenStart = start.toLocaleTimeString("pl-PL", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const tokenLabel = needsTime
          ? `${block.title} · ${tokenStart}`
          : block.title;
        const token = `@[${safeTokenLabel(tokenLabel)}]`;

        return {
          key: `intent:${block.intent_id}:${block.start}`,
          label: block.title,
          meta: [
            dateLabel,
            blockTime(block),
            typeLabel,
            categoryLabel,
          ]
            .filter(Boolean)
            .join(" · "),
          searchable,
          reference: {
            kind: "intent" as const,
            token,
            intent_id: block.intent_id,
          },
        };
      })
      .filter((option) => !query || option.searchable.includes(query));

    const todoOptions = mentionTodos
      .map((todo) => {
        const categoryLabel = todo.category
          ? WORK_CATEGORY_LABEL[todo.category]
          : null;
        const deadlineLabel = todo.deadline_date
          ? `max ${new Date(`${todo.deadline_date}T12:00:00`).toLocaleDateString("pl-PL")}`
          : null;
        const searchable = normalizeSearch(
          [
            todo.title,
            "Do zrobienia",
            categoryLabel ?? "",
            deadlineLabel ?? "",
            `${todo.minutes} min`,
          ].join(" "),
        );
        const token = `@[${safeTokenLabel(todo.title)}]`;

        return {
          key: `todo:${todo.id}`,
          label: todo.title,
          meta: [
            "Do zrobienia",
            `${todo.minutes} min`,
            categoryLabel,
            deadlineLabel,
          ]
            .filter(Boolean)
            .join(" · "),
          searchable,
          reference: {
            kind: "todo" as const,
            token,
            todo_id: todo.id,
          },
        };
      })
      .filter((option) => !query || option.searchable.includes(query));

    const selected = query
      ? [...plannerOptions, ...todoOptions].slice(0, 10)
      : [...plannerOptions.slice(0, 6), ...todoOptions.slice(0, 6)];

    return selected.map(({ searchable: _searchable, ...option }) => option);
  }, [mentionBlocks, mentionTodos, mentionTrigger]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionTrigger?.kind, mentionTrigger?.query]);

  const selectMention = (option: MentionOption) => {
    const trigger = mentionTrigger;
    if (!trigger) return;
    const next = `${input.slice(0, trigger.start)}${option.reference.token} `;
    setInput(next);
    setInputReferences((current) => [
      ...current.filter(
        (reference) =>
          reference.token !== option.reference.token &&
          !(
            reference.kind === "intent" &&
            option.reference.kind === "intent" &&
            reference.intent_id === option.reference.intent_id
          ) &&
          !(
            reference.kind === "todo" &&
            option.reference.kind === "todo" &&
            reference.todo_id === option.reference.todo_id
          ) &&
          !(
            reference.kind === "category" &&
            option.reference.kind === "category" &&
            reference.category === option.reference.category
          ),
      ),
      option.reference,
    ]);
    requestAnimationFrame(() => {
      const element = document.getElementById("horolog-assistant-input");
      if (element instanceof HTMLTextAreaElement) {
        element.focus();
        element.setSelectionRange(next.length, next.length);
      }
    });
  };

  const updateInput = (value: string) => {
    setInput(value);
    setInputReferences((current) =>
      current.filter((reference) => value.includes(reference.token)),
    );
  };

  const scrollDown = () => {
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sendingRef.current || executingRef.current || busy || executing) return;

    sendingRef.current = true;
    const references = inputReferences.filter((reference) =>
      text.includes(reference.token),
    );
    const nextMessages: AssistantMessage[] = [
      ...messages,
      {
        role: "user",
        content: text,
        references,
      },
    ];
    setMessages(nextMessages);
    setInput("");
    setInputReferences([]);
    setBusy(true);
    setError(null);
    scrollDown();

    try {
      const result = await api.assistantChat(
        nextMessages,
        pendingActions,
        pathname,
      );
      setMessages((current) => [
        ...current,
        { role: "assistant", content: result.reply },
      ]);
      setPendingActions(result.actions);
      scrollDown();
    } catch (caught) {
      // A failed model call must not permanently append the user's message.
      // Otherwise every retry grows the context with duplicates and makes the
      // local model progressively slower.
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "user" && last.content === text) {
          return current.slice(0, -1);
        }
        return current;
      });
      setInput(text);
      setInputReferences(references);
      setError(
        caught instanceof Error
          ? caught.message
          : "Nie udało się porozmawiać z Horologiem.",
      );
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!pendingActions.length || executingRef.current || sendingRef.current || executing) return;
    executingRef.current = true;
    setExecuting(true);
    setError(null);
    try {
      const result = await api.assistantExecute(pendingActions);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: executionSummary(result.results),
        },
      ]);
      setPendingActions([]);
      onCaptured();
      void Promise.all([api.plan(), api.todos()])
        .then(([plan, todos]) => {
          setMentionBlocks(plan.blocks);
          setMentionTodos(todos);
        })
        .catch(() => undefined);
      scrollDown();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Nie udało się wykonać uzgodnionych zmian.",
      );
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  };

  const reset = () => {
    setMessages([
      {
        role: "assistant",
        content:
          "Nowa rozmowa. Możesz użyć @ do wskazania wpisu z Plannera lub „Do zrobienia” i # do wskazania kategorii.",
      },
    ]);
    setPendingActions([]);
    setInput("");
    setInputReferences([]);
    setError(null);
  };

  const contextLabel = useMemo(() => {
    if (pathname.startsWith("/daily")) return "Kontekst: Daily";
    if (pathname.startsWith("/planner")) return "Kontekst: Planner";
    if (pathname.startsWith("/time")) return "Kontekst: Time";
    return "Kontekst: cały plan";
  }, [pathname]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:px-4">
          <motion.button
            type="button"
            aria-label="Zamknij Horolog Assistant"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-900/30"
          />

          <motion.section
            initial={{ opacity: 0, y: 20, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            role="dialog"
            aria-modal="true"
            aria-label="Horolog Assistant"
            className="relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-[26px] border border-black/[0.08] bg-white shadow-2xl sm:rounded-[26px]"
          >
            <header className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3.5 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <Sparkles size={17} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[14px] font-bold text-fg">{t("Horolog Assistant")}</h2>
                  <p className="truncate text-[10.5px] font-medium text-fg-muted">
                    {contextLabel} · niczego nie zmieniam bez potwierdzenia
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={reset}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted hover:bg-sunk hover:text-fg"
                  aria-label={t("Nowa rozmowa")}
                  title={t("Nowa rozmowa")}
                >
                  <RefreshCcw size={15} />
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted hover:bg-sunk hover:text-fg"
                  aria-label={t("Zamknij")}
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            <div ref={scrollRef} className="min-h-[280px] flex-1 overflow-y-auto px-4 py-4 sm:min-h-[420px] sm:px-5">
              <div className="space-y-4">
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex gap-2.5 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {message.role === "assistant" && (
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sunk text-fg-muted">
                        <Bot size={14} />
                      </span>
                    )}
                    <div
                      className={`max-w-[86%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                        message.role === "user"
                          ? "rounded-br-md bg-primary text-primary-foreground"
                          : "rounded-bl-md border border-black/[0.06] bg-sunk/45 text-fg"
                      }`}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}

                {busy && (
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sunk text-fg-muted">
                      <Bot size={14} />
                    </span>
                    <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border bg-sunk/45 px-3.5 py-2.5 text-[12px] text-fg-muted">
                      <Loader2 size={13} className="animate-spin" />
                      Analizuję plan…
                    </div>
                  </div>
                )}

                {hasProposal && !busy && (
                  <div className="ml-0 rounded-2xl border border-amber-200 bg-amber-50/55 p-3.5 sm:ml-9">
                    <div className="flex items-start gap-2.5">
                      <Target size={15} className="mt-0.5 shrink-0 text-amber-700" />
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-amber-800">
                          Do potwierdzenia
                        </div>
                        <p className="mt-0.5 text-[11px] text-amber-900/75">
                          {pendingActions.length > 1
                            ? `Pakiet atomowy: ${pendingActions.length} zmian. Jeśli jedna się nie powiedzie, nie zostanie zapisana żadna.`
                            : "Ta zmiana nie została jeszcze wykonana."}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      {pendingActions.map((action, index) => (
                        <div
                          key={`${action.action}-${index}`}
                          className="rounded-xl border border-amber-200/70 bg-white p-3"
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 text-amber-700">
                              {action.action === "create_meeting" ? (
                                <CalendarClock size={14} />
                              ) : action.action === "update_daily_plan" ? (
                                <Target size={14} />
                              ) : (
                                <CirclePlus size={14} />
                              )}
                            </span>
                            <div className="min-w-0">
                              <div className="text-[12px] font-semibold text-fg">
                                {actionTitle(action)}
                              </div>
                              <div className="mt-0.5 text-[10px] font-medium text-fg-muted">
                                {actionLabel(action)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setInput("Zmień proszę: ");
                          requestAnimationFrame(() => {
                            const element = document.getElementById("horolog-assistant-input");
                            if (element instanceof HTMLTextAreaElement) element.focus();
                          });
                        }}
                        className="h-9 rounded-xl border bg-white px-3 text-[11px] font-semibold text-fg-muted hover:bg-sunk"
                      >
                        Zmień
                      </button>
                      <button
                        type="button"
                        onClick={() => void execute()}
                        disabled={executing}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
                      >
                        {executing ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Check size={13} />
                        )}
                        Potwierdź i wykonaj
                      </button>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11.5px] text-red-700 sm:ml-9">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            </div>

            <footer className="border-t border-black/[0.06] bg-white p-3 sm:p-4">
              <div className="rounded-2xl border border-black/[0.08] bg-sunk/20 p-2 focus-within:border-black/20">
                {mentionTrigger && mentionOptions.length > 0 && (
                  <div className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-black/[0.08] bg-white p-1.5 shadow-lg">
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[9.5px] font-bold uppercase tracking-[0.1em] text-fg-subtle">
                      {mentionTrigger.kind === "intent" ? (
                        <AtSign size={11} />
                      ) : (
                        <Hash size={11} />
                      )}
                      {mentionTrigger.kind === "intent"
                        ? "Planner + Do zrobienia"
                        : "Kategorie"}
                    </div>
                    <div className="space-y-0.5">
                      {mentionOptions.map((option, index) => (
                        <button
                          key={option.key}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectMention(option)}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                            index === mentionIndex
                              ? "bg-sunk text-fg"
                              : "text-fg hover:bg-sunk/60"
                          }`}
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sunk text-fg-muted">
                            {option.reference.kind === "intent" ? (
                              <AtSign size={13} />
                            ) : (
                              <Hash size={13} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11.5px] font-semibold">
                              {option.label}
                            </span>
                            <span className="block truncate text-[9.5px] text-fg-muted">
                              {option.meta}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <textarea
                  id="horolog-assistant-input"
                  value={input}
                  onChange={(event) => updateInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (mentionTrigger && mentionOptions.length > 0) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setMentionIndex((current) =>
                          (current + 1) % mentionOptions.length,
                        );
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setMentionIndex((current) =>
                          (current - 1 + mentionOptions.length) %
                          mentionOptions.length,
                        );
                        return;
                      }
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        const option =
                          mentionOptions[
                            Math.min(mentionIndex, mentionOptions.length - 1)
                          ];
                        if (option) selectMention(option);
                        return;
                      }
                    }
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={busy || executing}
                  rows={2}
                  placeholder={
                    hasProposal
                      ? t("Doprecyzuj albo zmień propozycję…")
                      : "Np. jutro mam spotkanie z Anną o 10:30, wcześniej potrzebuję 45 min na przygotowanie…"
                  }
                  className="min-h-[54px] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-fg-subtle"
                />
                <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
                  <span className="text-[9.5px] text-fg-subtle">
                    @ Planner/Do zrobienia · # kategoria · Enter wysyła
                  </span>
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={!input.trim() || busy || executing}
                    aria-label={t("Wyślij")}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-35"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-center gap-1.5 text-[9.5px] text-fg-subtle">
                <CheckCircle2 size={11} />
                AI proponuje · backend sprawdza · Ty zatwierdzasz
              </div>
            </footer>
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  );
}
