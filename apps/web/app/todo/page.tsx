"use client";

import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/app/components/Shell";
import {
  WORK_CATEGORIES,
  WORK_CATEGORY_LABEL,
  api,
  formatDuration,
  type TodoInboxItem,
  type WorkCategory,
} from "@/app/lib/api";
import { useLanguage } from "@/app/components/LanguageProvider";
import { CalendarDays, Check, Clock3, Inbox, Pencil, Plus, Trash2, X } from "lucide-react";

type Draft = {
  title: string;
  minutes: number;
  category: WorkCategory | "";
  deadline_date: string;
};

const EMPTY: Draft = {
  title: "",
  minutes: 30,
  category: "",
  deadline_date: "",
};

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function TodoPage() {
  const { t } = useLanguage();
  const [items, setItems] = useState<TodoInboxItem[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.todos());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się wczytać listy.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const prefill = params.get("prefill")?.trim();
    if (!prefill) return;

    setDraft((current) =>
      current.title ? current : { ...current, title: prefill },
    );
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  async function createItem() {
    if (!draft.title.trim()) return;
    setBusy("new");
    try {
      await api.createTodo({
        title: draft.title.trim(),
        minutes: draft.minutes,
        category: draft.category || null,
        deadline_date: draft.deadline_date || null,
      });
      setDraft(EMPTY);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się dodać zadania.");
    } finally {
      setBusy(null);
    }
  }

  function startEdit(item: TodoInboxItem) {
    setEditing(item.id);
    setEditDraft({
      title: item.title,
      minutes: item.minutes,
      category: item.category ?? "",
      deadline_date: item.deadline_date ?? "",
    });
  }

  async function saveEdit(id: string) {
    if (!editDraft.title.trim()) return;
    setBusy(id);
    try {
      await api.patchTodo(id, {
        title: editDraft.title.trim(),
        minutes: editDraft.minutes,
        category: editDraft.category || null,
        deadline_date: editDraft.deadline_date || null,
      });
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się zapisać zmian.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await api.deleteTodo(id);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się usunąć wpisu.");
    } finally {
      setBusy(null);
    }
  }

  const today = todayKey();

  return (
    <Shell onPlanChange={load}>
      <main className="mx-auto max-w-[920px] px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sunk text-fg">
              <Inbox size={20} />
            </span>
            <div>
              <h1 className="text-[28px] font-bold text-fg">{t("To do")}</h1>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                Zapisz temat teraz. Priorytet w macierzy nada Pan dopiero wtedy, gdy będzie planowany dzień.
              </p>
            </div>
          </div>
        </header>

        {error && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-[12.5px] font-medium text-red-700">
            {error}
          </div>
        )}

        <section className="mb-6 rounded-2xl border border-black/[0.08] bg-surface p-4 shadow-sm">
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => setDraft((current) => ({ ...current, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void createItem();
            }}
            placeholder="Temat do zrobienia…"
            className="w-full border-0 bg-transparent px-1 py-2 text-[15px] font-semibold text-fg outline-none placeholder:text-fg-subtle"
          />

          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-black/[0.06] pt-3">
            <label className="space-y-1">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Czas</span>
              <select
                value={draft.minutes}
                onChange={(e) => setDraft((current) => ({ ...current, minutes: Number(e.target.value) }))}
                className="h-9 rounded-lg border border-black/[0.08] bg-bg px-2.5 text-[12px] font-medium text-fg"
              >
                {[15, 30, 45, 60, 90, 120, 180, 240].map((value) => (
                  <option key={value} value={value}>{formatDuration(value)}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Kategoria</span>
              <select
                value={draft.category}
                onChange={(e) => setDraft((current) => ({ ...current, category: e.target.value as WorkCategory | "" }))}
                className="h-9 rounded-lg border border-black/[0.08] bg-bg px-2.5 text-[12px] font-medium text-fg"
              >
                <option value="">Brak kategorii</option>
                {WORK_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{WORK_CATEGORY_LABEL[category]}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Max deadline</span>
              <input
                type="date"
                value={draft.deadline_date}
                onChange={(e) => setDraft((current) => ({ ...current, deadline_date: e.target.value }))}
                className="h-9 rounded-lg border border-black/[0.08] bg-bg px-2.5 text-[12px] font-medium text-fg"
              />
            </label>

            <button
              type="button"
              onClick={() => void createItem()}
              disabled={!draft.title.trim() || busy === "new"}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-semibold text-on-accent disabled:opacity-40"
            >
              <Plus size={14} /> Dodaj
            </button>
          </div>
        </section>

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-bold text-fg">Nieprzydzielone</h2>
          <span className="rounded-full bg-sunk px-2.5 py-1 text-[11px] font-semibold text-fg-muted">
            {items.length}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/[0.12] bg-surface p-10 text-center">
            <Inbox className="mx-auto text-fg-subtle" size={24} />
            <div className="mt-3 text-[14px] font-semibold text-fg">Skrzynka jest pusta</div>
            <p className="mt-1 text-[12px] text-fg-muted">
              Tutaj trafiają tematy, które jeszcze nie mają miejsca w macierzy Eisenhowera.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const overdue = Boolean(item.deadline_date && item.deadline_date < today);
              const editingThis = editing === item.id;
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-black/[0.07] bg-surface p-3.5 shadow-xs"
                >
                  {editingThis ? (
                    <div className="space-y-3">
                      <input
                        value={editDraft.title}
                        onChange={(e) => setEditDraft((current) => ({ ...current, title: e.target.value }))}
                        className="w-full rounded-lg border border-black/[0.08] bg-bg px-3 py-2 text-[13px] font-semibold outline-none focus:border-accent"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={editDraft.minutes}
                          onChange={(e) => setEditDraft((current) => ({ ...current, minutes: Number(e.target.value) }))}
                          className="h-9 rounded-lg border border-black/[0.08] bg-bg px-2 text-[12px]"
                        >
                          {[15, 30, 45, 60, 90, 120, 180, 240].map((value) => (
                            <option key={value} value={value}>{formatDuration(value)}</option>
                          ))}
                        </select>
                        <select
                          value={editDraft.category}
                          onChange={(e) => setEditDraft((current) => ({ ...current, category: e.target.value as WorkCategory | "" }))}
                          className="h-9 rounded-lg border border-black/[0.08] bg-bg px-2 text-[12px]"
                        >
                          <option value="">Brak kategorii</option>
                          {WORK_CATEGORIES.map((category) => (
                            <option key={category} value={category}>{WORK_CATEGORY_LABEL[category]}</option>
                          ))}
                        </select>
                        <input
                          type="date"
                          value={editDraft.deadline_date}
                          onChange={(e) => setEditDraft((current) => ({ ...current, deadline_date: e.target.value }))}
                          className="h-9 rounded-lg border border-black/[0.08] bg-bg px-2 text-[12px]"
                        />
                        <button
                          type="button"
                          onClick={() => void saveEdit(item.id)}
                          disabled={busy === item.id}
                          className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-on-accent disabled:opacity-40"
                          aria-label="Zapisz"
                        >
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="flex h-9 w-9 items-center justify-center rounded-lg bg-sunk text-fg-muted"
                          aria-label="Anuluj"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold text-fg">{item.title}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px] font-medium text-fg-muted">
                          <span className="inline-flex items-center gap-1 rounded-full bg-sunk px-2 py-1">
                            <Clock3 size={11} /> {formatDuration(item.minutes)}
                          </span>
                          {item.category && (
                            <span className="rounded-full bg-sunk px-2 py-1 font-semibold">
                              {WORK_CATEGORY_LABEL[item.category]}
                            </span>
                          )}
                          {item.deadline_date && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold ${
                              overdue ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                            }`}>
                              <CalendarDays size={11} />
                              max {new Date(`${item.deadline_date}T12:00:00`).toLocaleDateString("pl-PL")}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => startEdit(item)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-sunk hover:text-fg"
                        aria-label="Edytuj"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(item.id)}
                        disabled={busy === item.id}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                        aria-label="Usuń"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </Shell>
  );
}
