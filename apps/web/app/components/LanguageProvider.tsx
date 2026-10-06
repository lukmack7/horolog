"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Language = "en" | "pl";

const PL: Record<string, string> = {
  "Time":"Dzień","Planner":"Planer","Daily":"Dziennik","Habits":"Nawyki","Task inbox":"Zadania","Task Inbox":"Zadania",
  "Meetings":"Spotkania","Analytics":"Analizy","Calendars":"Kalendarze","Defend Time":"Chroń swój czas","Ask Horolog":"Zapytaj Horologa",
  "More":"Więcej","Close":"Zamknij","Close more navigation":"Zamknij dodatkową nawigację","More navigation":"Dodatkowa nawigacja",
  "Reconnecting...":"Ponowne łączenie...","Optimizing...":"Optymalizuję...","Engine steady":"Plan aktualny",
  "Task":"Zadanie","Habit":"Nawyk","Focus":"Skupienie","Buffer":"Przerwa / bufor","Meeting":"Spotkanie","External":"Zewnętrzne",
  "Critical":"Krytyczny","High":"Wysoki","Normal":"Normalny","Low":"Niski","Moved":"Przeniesione","Locked":"Sztywne","Busy":"Zajęte",
  "Right now":"Teraz","Up next":"Następne","Nothing scheduled — this time is open.":"Nic nie zaplanowano — ten czas jest wolny.",
  "Nothing else scheduled for today.":"Na dziś nie ma już nic zaplanowanego.","Start here":"Zacznij tutaj",
  "Could not load the schedule.":"Nie udało się wczytać planu.","Could not reach the scheduler.":"Nie udało się połączyć z planerem.",
  "Loading schedule...":"Wczytuję plan...","Nothing scheduled yet":"Nic jeszcze nie zaplanowano","Export":"Eksportuj","Export .ics":"Eksportuj .ics",
  "Habits & Focus Time":"Nawyki i czas skupienia","Days":"Dni","optional fixed days":"opcjonalne stałe dni",
  "Frequency":"Częstotliwość","times / week":"razy / tydzień","Duration":"Czas trwania","per session":"na sesję",
  "Max sitting":"Maks. sesja","per sitting":"na sesję","Hours per week":"Godziny tygodniowo","weekly target":"cel tygodniowy",
  "Earliest":"Najwcześniej","window start":"początek okna","Latest":"Najpóźniej","window end":"koniec okna",
  "high energy":"wysoka energia","medium energy":"średnia energia","low energy":"niska energia",
  "Saving...":"Zapisuję...","Scheduling...":"Planuję...","Save Changes":"Zapisz zmiany","Add Routine":"Dodaj rutynę",
  "No active routines":"Brak aktywnych rutyn","Configure a habit above or use ⌘K to describe it.":"Skonfiguruj nawyk powyżej lub opisz go przez ⌘K.",
  "Gym, deep work, lunch...":"Siłownia, głęboka praca, lunch...","Edit routine":"Edytuj rutynę",
  "Mon":"Pon","Tue":"Wt","Wed":"Śr","Thu":"Czw","Fri":"Pt","Sat":"Sob","Sun":"Niedz",
  "Minutes":"Minuty","Priority":"Priorytet","Done":"Wykonane","Not placed":"Nie zaplanowano","Mark done":"Oznacz jako wykonane","Mark not done":"Cofnij wykonanie",
  "Smart Meetings":"Inteligentne spotkania","No smart meetings yet":"Brak inteligentnych spotkań",
  "Configure one above, with or without attendee ranges.":"Skonfiguruj spotkanie powyżej — z dostępnością uczestnika lub bez.",
  "Weekly sync":"Cotygodniowe spotkanie","attendee (optional)":"uczestnik (opcjonalnie)","Remove range":"Usuń zakres","Add Meeting":"Dodaj spotkanie",
  "Calendars & Sync":"Kalendarze i synchronizacja","Connect a calendar":"Połącz kalendarz","Connect a tracker":"Połącz narzędzie zadań",
  "Subscribe to your Horolog plan":"Subskrybuj plan Horolog","Connect":"Połącz","Working…":"Pracuję…","Syncing…":"Synchronizuję…",
  "Sync Feed":"Synchronizuj kanał","Copy Feed Link":"Kopiuj link kanału","Copied!":"Skopiowano!","Disconnect":"Rozłącz",
  "Overview":"Przegląd","Priorities":"Priorytety","Week map":"Mapa tygodnia","Executive":"Zarządczy",
  "Scheduled work":"Zaplanowana praca","Deep-work time":"Czas głębokiej pracy","No scheduled work":"Brak zaplanowanej pracy",
  "Meeting load":"Obciążenie spotkaniami","High priority":"Wysoki priorytet","Time per day":"Czas dziennie",
  "The next seven days, stacked by work type.":"Najbliższe siedem dni według rodzaju pracy.","Time by type":"Czas według typu",
  "What your plan is made of.":"Z czego składa się Twój plan.","Time by priority":"Czas według priorytetu",
  "How much time your important work receives.":"Ile czasu otrzymują ważne zadania.","High-priority share":"Udział wysokich priorytetów",
  "Critical work":"Praca krytyczna","High-priority work":"Praca o wysokim priorytecie","Unmet demand":"Niezaplanowane zapotrzebowanie",
  "Could not be placed":"Nie udało się zaplanować","All demand placed":"Wszystko zaplanowano","Priority heatmap":"Mapa priorytetów",
  "Priority mix by day":"Priorytety według dnia","Priority coverage":"Pokrycie priorytetów","Visible workload":"Widoczne obciążenie",
  "Deep work":"Głęboka praca","Average block":"Średni blok","Planned blocks":"Zaplanowane bloki","Weekly time map":"Tygodniowa mapa czasu",
  "Fragmentation":"Fragmentacja","Strong focus allocation":"Dobra ochrona skupienia","Focus time is limited":"Czas skupienia jest ograniczony",
  "Meeting load is controlled":"Spotkania są pod kontrolą","Meeting load is high":"Duże obciążenie spotkaniami",
  "Priority mix looks intentional":"Priorytety wyglądają świadomie","High-priority share could be higher":"Udział wysokich priorytetów mógłby być większy",
  "All demand fits":"Wszystko mieści się w planie","The plan is oversubscribed":"Plan jest przeciążony","Completed":"Wykonane",
  "Time distribution":"Rozkład czasu","The current workload mix.":"Aktualna struktura obciążenia.","Focus vs meetings":"Skupienie a spotkania",
  "Protected work against calendar pressure.":"Chroniona praca wobec presji kalendarza.","Recommendations":"Rekomendacje",
  "What to change next, based only on the current plan.":"Co zmienić dalej na podstawie aktualnego planu.","This plan at a glance":"Plan w skrócie",
  "Decision-oriented signals from the current planning horizon.":"Najważniejsze sygnały z aktualnego horyzontu planowania.","Key insights":"Kluczowe wnioski",
  "Month":"Miesiąc","Week":"Tydzień","Day":"Dzień","List":"Lista","All Events":"Wszystkie wydarzenia",
  "Filter by Color":"Filtruj według koloru","Filter by Tag":"Filtruj według tagu","Filter by Category":"Filtruj według kategorii",
  "Active filters:":"Aktywne filtry:","Search events...":"Szukaj wydarzeń...","Create Event":"Nowe wydarzenie","Event Details":"Szczegóły wydarzenia",
  "Add a new event to your calendar":"Dodaj nowe wydarzenie do kalendarza","View and edit event details":"Wyświetl i edytuj szczegóły wydarzenia",
  "Title":"Tytuł","Description":"Opis","Start Time":"Początek","End Time":"Koniec","Category":"Kategoria","Color":"Kolor","Tags":"Tagi",
  "Event title":"Tytuł wydarzenia","Event description":"Opis wydarzenia","Select category":"Wybierz kategorię","Select color":"Wybierz kolor",
  "Create":"Utwórz","Save":"Zapisz","Cancel":"Anuluj","Delete":"Usuń","No events found":"Nie znaleziono wydarzeń",
  "Blue":"Niebieski","Green":"Zielony","Purple":"Fioletowy","Orange":"Pomarańczowy","Pink":"Różowy","Red":"Czerwony",
  "Reminder":"Przypomnienie","Personal":"Osobiste","Important":"Ważne","Urgent":"Pilne","Work":"Praca","Team":"Zespół","Client":"Klient"
};

const PATTERNS: Array<[RegExp,(m:RegExpMatchArray)=>string]> = [
  [/^(\d+) blocks$/,m=>`${m[1]} bloków`],
  [/^(\d+) block$/,m=>`${m[1]} blok`],
  [/^solved in (.+)$/,m=>`ułożono w ${m[1]}`],
  [/^in (.+)$/,m=>`za ${m[1]}`],
  [/^Measured across your (\d+)-day planning horizon$/,m=>`Pomiar dla ${m[1]}-dniowego horyzontu planowania`],
  [/^(\d+) external calendar commitments are visible\.$/,m=>`Widoczne zobowiązania z kalendarza: ${m[1]}.`],
];

function translate(text:string):string {
  const trimmed=text.trim();
  if (!trimmed) return text;
  const direct=PL[trimmed];
  let translated=direct;
  if (!translated) for (const [re,fn] of PATTERNS) { const m=trimmed.match(re); if(m){ translated=fn(m); break; } }
  if (!translated) return text;
  return text.replace(trimmed,translated);
}

type LanguageContextValue={language:Language;setLanguage:(language:Language)=>void;t:(text:string)=>string};
const LanguageContext=createContext<LanguageContextValue>({language:"pl",setLanguage:()=>undefined,t:(text)=>text});

export function LanguageProvider({children}:{children:React.ReactNode}){
  const [language,setLanguageState]=useState<Language>("pl");
  useEffect(()=>{const saved=window.localStorage.getItem("horolog-language");if(saved==="pl"||saved==="en")setLanguageState(saved);},[]);
  const setLanguage=(next:Language)=>{setLanguageState(next);window.localStorage.setItem("horolog-language",next);document.documentElement.lang=next;};
  useEffect(()=>{document.documentElement.lang=language;},[language]);
  const value=useMemo(()=>({language,setLanguage,t:(text:string)=>language==="pl"?translate(text):text}),[language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
export function useLanguage(){return useContext(LanguageContext);}
