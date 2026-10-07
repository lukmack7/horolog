import { en, type TranslationKey } from "./en";
import { pl } from "./pl";

export const messages = { en, pl } as const;
export type Language = keyof typeof messages;
export type { TranslationKey };

export function translate(language: Language, key: string): string {
  if (language === "en") return key;
  return pl[key as TranslationKey] ?? key;
}

export function localeFor(language: Language): string {
  return language === "pl" ? "pl-PL" : "en-US";
}
