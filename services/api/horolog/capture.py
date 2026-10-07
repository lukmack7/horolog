"""Natural language -> a validated scheduling intent.

The one place a language model touches this product. It fills in a form; it
never picks a time. Whatever it returns is a *request* for time that the placer
then satisfies or reports as unmet against the real calendar — so a bad
extraction produces a wrong-looking task, never a phantom event.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from pydantic import BaseModel, Field, model_validator

from horolog.domain.intent import IntentKind, Priority, WorkCategory
from horolog.llm import Provider, extract
from horolog.settings import settings

SYSTEM = """\
You convert a person's description of work into one scheduling request.

Rules:
- minutes_per_period is the TOTAL time needed, not the length of one sitting.
- period_days: null for one-off work. Use 7 or 1 ONLY when the person explicitly
  asks for repeated execution, e.g. "every week", "co tydzień", "every day",
  "codziennie", or "3 times per week".
- Words describing the thing being produced do NOT imply recurrence.
  "monthly P&L", "miesięczny P&L", "weekly report", "raport tygodniowy",
  or "annual budget" can all be one-off tasks when phrased as something to prepare.
- min_chunk_minutes / max_chunk_minutes bound a single sitting. Set them equal
  when the activity cannot be split (a gym session, a class, a meeting).
- Deep or focused work wants min_chunk_minutes of at least 60.
- max_per_day: 1 when the person implies it happens at most once a day
  ("three times a week", "every morning"). Otherwise null.
- allowed_weekdays is a list of ISO weekdays: Monday=0, Tuesday=1, Wednesday=2,
  Thursday=3, Friday=4, Saturday=5, Sunday=6.
- Use allowed_weekdays ONLY for recurring weekday constraints.
  Examples:
  "Mondays" / "w poniedziałki" -> [0]
  "Tuesdays and Thursdays" / "we wtorki i czwartki" -> [1, 3]
  "weekends" / "w weekendy" -> [5, 6]
  "weekdays" / "w dni robocze" -> [0, 1, 2, 3, 4]
  "every day except Sunday" / "codziennie oprócz niedzieli" -> [0, 1, 2, 3, 4, 5]
- A singular weekday referring to one upcoming date is NOT recurrence.
  "on Monday", "w poniedziałek", "next Thursday", "w najbliższy czwartek"
  should leave allowed_weekdays empty and use due_in_days when it is a deadline.
- When the person explicitly wants one session on each named recurring weekday,
  period_days = 7, max_per_day = 1, and minutes_per_period is the session length
  multiplied by the number of named weekdays.
  Example: "gym 90 minutes on Mondays, Wednesdays and Fridays" means
  minutes_per_period = 270, period_days = 7, max_per_day = 1,
  allowed_weekdays = [0, 2, 4], min_chunk_minutes = 90, max_chunk_minutes = 90.
- Do NOT multiply when the person explicitly gives a TOTAL weekly duration.
  "3 hours total per week on Monday, Wednesday and Friday" means
  minutes_per_period = 180, not 540.
- window_start_min / window_end_min are minutes from midnight ONLY for a preferred
  execution window, e.g. "in the mornings" (540-720), "rano", or
  "between 2 and 6" (840-1080).
- preferred_start_min is the preferred start time in minutes from midnight when
  the person gives a specific start time. Examples:
  "at 6:00", "od 6:00", "o 6:00 rano" -> 360.
  "at 14:30", "o 14:30" -> 870.
  This is a preferred start time, not a deadline.
- A deadline such as "by 16:00" or "do 16:00" is NOT an execution window.
  Put it only in due_time_min and leave window_start_min/window_end_min null
  unless a separate preferred work window is explicitly stated.
- due_in_days counts from today. Null when no deadline is mentioned.
- due_time_min is the deadline clock time in minutes from midnight when a
  specific time is stated ("by 16:00", "do 16:00" -> 960). Null when the
  deadline gives only a day/date and no exact clock time.
- Priority: 1 critical, 2 high, 3 normal, 4 low. Default 3 unless urgency,
  importance, or "whenever" language says otherwise.
- category is an optional work area, never a scheduling priority:
  "cmr" for CMR work, "macheta_data" for Macheta Data, "private" for personal
  matters. Set it only when the text clearly names or implies one of these
  areas. Otherwise null - do not guess.

Example:
"Przygotować miesięczny P&L, 90 minut, jutro do 16:00, wysoki priorytet"
means:
- period_days = null
- max_per_day = null
- window_start_min = null
- window_end_min = null
- due_in_days = 1
- due_time_min = 960
- minutes_per_period = 90
- priority = 2

Infer only what the text supports. Use null rather than inventing a constraint.\
"""


DAILY_SYSTEM = """\
You interpret one Daily quick-add written in Polish or English.

Return:
1. actions: actionable TASKS the user explicitly wants to do.
2. meeting_suggestions: every meeting/call/appointment the text refers to that
   may deserve its own calendar entry, EVEN when it is only context for a task.

Important:
- Never create a meeting automatically. Meeting suggestions are only proposals
  shown to the user for confirmation.
- "przeanalizować odpowiedzi od Vafo i przygotować się na spotkanie jutro z
  Anną z AZAN" => one task in actions AND one meeting suggestion for tomorrow.
- "przeanalizować odpowiedzi od Vafo dziś i jutro o 10:00 spotkanie z Anną z
  AZAN na 45 minut" => one task AND one meeting suggestion tomorrow at 10:00,
  duration 45.
- "zadzwonić do Ani i wysłać ofertę do Marka" => two tasks, no meeting.
- Keep closely coupled work as one task when it describes one outcome, e.g.
  "przeanalizować dane i przygotować wnioski do prezentacji".
- Do not invent people, dates, times or durations.

Fields:
- day_offset: calendar days from the selected Daily date. 0 means selected day,
  1 means next day. Use another value only when the text supports it.
- minutes: explicit duration when stated, otherwise null.
- preferred_start_min: explicit start time as minutes from midnight, otherwise
  null. Never guess a clock time.
- title: short natural action/meeting title preserving names and business terms.
- category: use "cmr", "macheta_data" or "private" only when the text clearly
  identifies CMR, Macheta Data or a personal/private matter. Otherwise null.

For a preparation task whose sentence mentions a future meeting, keep the task
on the selected Daily date unless the task itself is explicitly assigned to a
different day. The meeting suggestion can have its own future day_offset.\
"""


class DailyActionDraft(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    day_offset: int = 0
    minutes: int | None = None
    category: WorkCategory | None = None

    @model_validator(mode="after")
    def _daily_sane(self) -> DailyActionDraft:
        if self.day_offset < 0 or self.day_offset > 14:
            raise ValueError("day_offset must be between 0 and 14")
        if self.minutes is not None and self.minutes <= 0:
            raise ValueError("minutes must be positive when provided")
        return self


class DailyMeetingSuggestionDraft(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    day_offset: int = 0
    minutes: int | None = None
    preferred_start_min: int | None = None

    @model_validator(mode="after")
    def _meeting_sane(self) -> DailyMeetingSuggestionDraft:
        if self.day_offset < 0 or self.day_offset > 14:
            raise ValueError("day_offset must be between 0 and 14")
        if self.minutes is not None and self.minutes <= 0:
            raise ValueError("minutes must be positive when provided")
        if self.preferred_start_min is not None and not 0 <= self.preferred_start_min < 1440:
            raise ValueError("preferred_start_min must satisfy 0 <= value < 1440")
        return self


class DailyBatchDraft(BaseModel):
    actions: list[DailyActionDraft]
    meeting_suggestions: list[DailyMeetingSuggestionDraft]

    @model_validator(mode="after")
    def _batch_sane(self) -> DailyBatchDraft:
        if not self.actions and not self.meeting_suggestions:
            raise ValueError("at least one action or meeting suggestion is required")
        if len(self.actions) > 8 or len(self.meeting_suggestions) > 4:
            raise ValueError("Daily quick-add contains too many separate items")
        return self


async def capture_daily_actions(
    text: str,
    selected_date: str,
    provider: Provider | None = None,
) -> DailyBatchDraft:
    system = (
        DAILY_SYSTEM
        + f"\n\nSelected Daily date: {selected_date}. "
        + "Interpret today/this day as the selected Daily date, not the server clock."
    )
    return await extract(DailyBatchDraft, system, text, provider=provider)


class IntentDraft(BaseModel):
    """What the model is allowed to say.

    Deliberately expressed in the units a person speaks in — minutes, days,
    times per week — rather than the engine's 15-minute slots. Asking a model
    to do the arithmetic invites errors that grammar constraints cannot catch,
    and the conversion is one line of Python.
    """

    title: str = Field(min_length=1, max_length=200)
    kind: IntentKind
    priority: Priority
    category: WorkCategory | None = None
    minutes_per_period: int
    period_days: int | None
    min_chunk_minutes: int
    max_chunk_minutes: int
    max_per_day: int | None
    allowed_weekdays: list[int] = Field(default_factory=list)
    window_start_min: int | None
    window_end_min: int | None
    preferred_start_min: int | None = None
    due_in_days: int | None
    due_time_min: int | None = None

    @model_validator(mode="after")
    def _sane(self) -> IntentDraft:
        # These are the checks constrained decoding cannot make: the grammar
        # guarantees an integer sits in `min_chunk_minutes`, not that it is
        # smaller than the maximum. A failure here triggers the repair round.
        if self.minutes_per_period <= 0:
            raise ValueError("minutes_per_period must be positive")
        if self.min_chunk_minutes <= 0 or self.max_chunk_minutes <= 0:
            raise ValueError("chunk minutes must be positive")
        if self.max_chunk_minutes < self.min_chunk_minutes:
            raise ValueError("max_chunk_minutes must be >= min_chunk_minutes")
        if self.minutes_per_period < self.min_chunk_minutes:
            raise ValueError(
                f"minutes_per_period ({self.minutes_per_period}) is less than one "
                f"chunk ({self.min_chunk_minutes}); reduce min_chunk_minutes"
            )
        if any(day < 0 or day > 6 for day in self.allowed_weekdays):
            raise ValueError("allowed_weekdays values must be between 0 (Monday) and 6 (Sunday)")
        if len(set(self.allowed_weekdays)) != len(self.allowed_weekdays):
            raise ValueError("allowed_weekdays must not contain duplicates")
        if (self.window_start_min is None) != (self.window_end_min is None):
            raise ValueError("window_start_min and window_end_min must both be set or both null")
        if self.window_start_min is not None and self.window_end_min is not None:
            if not 0 <= self.window_start_min < self.window_end_min <= 1440:
                raise ValueError("window must satisfy 0 <= start < end <= 1440")
            if self.window_end_min - self.window_start_min < self.min_chunk_minutes:
                raise ValueError(
                    f"window is {self.window_end_min - self.window_start_min}min but a chunk "
                    f"needs {self.min_chunk_minutes}min; widen the window or shorten the chunk"
                )
        if self.preferred_start_min is not None and not 0 <= self.preferred_start_min < 1440:
            raise ValueError("preferred_start_min must satisfy 0 <= value < 1440")
        if self.due_in_days is not None and self.due_in_days < 0:
            raise ValueError("due_in_days cannot be negative")
        if self.due_time_min is not None and not 0 <= self.due_time_min < 1440:
            raise ValueError("due_time_min must satisfy 0 <= value < 1440")
        if self.due_time_min is not None and self.due_in_days is None:
            raise ValueError("due_time_min requires due_in_days")
        return self


def to_payload(draft: IntentDraft, now: datetime) -> dict[str, object]:
    """Convert a draft into the body `POST /api/intents` accepts."""
    step = 15

    def up(minutes: int) -> int:
        """Snap up to the engine's 15-minute grid.

        Up, not nearest: a 20-minute task rounded down would be scheduled for
        15 minutes and then reported complete.
        """
        return max(step, -(-minutes // step) * step)

    payload: dict[str, object] = {
        "title": draft.title,
        "kind": draft.kind.value,
        "priority": int(draft.priority),
        "category": draft.category.value if draft.category is not None else None,
        "minutes_per_period": up(draft.minutes_per_period),
        "period_days": draft.period_days,
        "min_chunk_minutes": up(draft.min_chunk_minutes),
        "max_chunk_minutes": up(draft.max_chunk_minutes),
        "max_per_day": draft.max_per_day,
        "allowed_weekdays": draft.allowed_weekdays,
        "window_start_min": draft.window_start_min,
        "window_end_min": draft.window_end_min,
        "preferred_start_min": draft.preferred_start_min,
    }
    if draft.due_in_days is not None:
        target = now + timedelta(days=draft.due_in_days)
        due_min = draft.due_time_min if draft.due_time_min is not None else 23 * 60 + 59
        due = target.replace(
            hour=due_min // 60,
            minute=due_min % 60,
            second=0,
            microsecond=0,
        )
        payload["due"] = due.isoformat()
    return payload


async def capture(text: str, provider: Provider | None = None) -> IntentDraft:
    now = datetime.now(settings().zone)
    system = (
        SYSTEM
        + f"\n\nCurrent local date and time: {now.isoformat(timespec='minutes')} "
        + f"({now.strftime('%A')}). "
        + "Use this as the reference for today, tomorrow, weekdays, and relative deadlines."
    )
    return await extract(IntentDraft, system, text, provider=provider)
