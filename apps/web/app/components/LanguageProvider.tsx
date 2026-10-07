"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { localeFor, translate, type Language } from "@/app/i18n";

export type { Language };

type LanguageContextValue = {
  language: Language;
  locale: string;
  setLanguage: (language: Language) => void;
  t: (key: string) => string;
};

const LanguageContext = createContext<LanguageContextValue>({
  language: "pl",
  locale: "pl-PL",
  setLanguage: () => undefined,
  t: (key) => key,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("pl");

  useEffect(() => {
    const saved = window.localStorage.getItem("horolog-language");
    if (saved === "pl" || saved === "en") setLanguageState(saved);
  }, []);

  const setLanguage = (next: Language) => {
    setLanguageState(next);
    window.localStorage.setItem("horolog-language", next);
  };

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      locale: localeFor(language),
      setLanguage,
      t: (key) => translate(language, key),
    }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
