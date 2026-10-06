"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Language = "en" | "pl";

const PL: Record<string, string> = {
  "Time": "Dzień", "Planner": "Planer", "Daily": "Dziennik", "Habits": "Nawyki",
  "Task inbox": "Zadania", "Meetings": "Spotkania", "Analytics": "Analizy", "Calendars": "Kalendarze",
  "Defend Time": "Chroń swój czas", "Ask Horolog": "Zapytaj Horologa",
  "Reconnecting...": "Ponowne łączenie...", "Optimizing...": "Optymalizuję...", "Engine steady": "Plan aktualny",
  "More": "Więcej", "Close": "Zamknij", "Close more navigation": "Zamknij dodatkową nawigację",
  "More navigation": "Dodatkowa nawigacja", "Task": "Zadanie", "Habit": "Nawyk", "Focus": "Skupienie",
  "Buffer": "Przerwa / bufor", "Meeting": "Spotkanie", "External": "Zewnętrzne",
  "Critical": "Krytyczny", "High": "Wysoki", "Normal": "Normalny", "Low": "Niski",
};

type LanguageContextValue = { language: Language; setLanguage: (language: Language) => void; t: (text: string) => string };
const LanguageContext = createContext<LanguageContextValue>({ language: "en", setLanguage: () => undefined, t: (text) => text });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  useEffect(() => {
    const saved = window.localStorage.getItem("horolog-language");
    if (saved === "pl" || saved === "en") setLanguageState(saved);
  }, []);
  const setLanguage = (next: Language) => {
    setLanguageState(next);
    window.localStorage.setItem("horolog-language", next);
    document.documentElement.lang = next;
  };
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const value = useMemo(() => ({ language, setLanguage, t: (text: string) => language === "pl" ? PL[text] ?? text : text }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() { return useContext(LanguageContext); }
