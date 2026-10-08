"""The single scheduling primitive.

Focus Time, Habits, Tasks, Buffers and Smart Meetings are one activity type under
five names (see plan §1.2 — SelfPlanner models exactly this as a COP). `kind` is
carried for presentation and for tie-breaking only; the solver reads the numeric
fields and nothing else. Adding a sixth feature means adding a `kind` and a
factory, never a new solver path.
"""

from __future__ import annotations

from datetime import datetime
from enum import IntEnum, StrEnum

from pydantic import BaseModel, Field, model_validator

from horolog.domain.time import SLOT_MINUTES, minutes_to_slots


class Priority(IntEnum):
    """P1 (critical) .. P4 (low). Lower value = more important, matching Reclaim."""

    P1 = 1
    P2 = 2
    P3 = 3
    P4 = 4


class WorkCategory(StrEnum):
    CMR = "cmr"
    MACHETA_DATA = "macheta_data"
    PRIVATE = "private"


class EnergyRequired(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class IntentKind(StrEnum):
    TASK = "task"
    HABIT = "habit"
    FOCUS = "focus"
    BUFFER = "buffer"
    MEETING = "meeting"


# Tie-break order when priorities are equal, mirroring Reclaim's documented
# behaviour: Smart Meetings first, then Habits, then Tasks.
KIND_RANK: dict[IntentKind, int] = {
    IntentKind.MEETING: 0,
    IntentKind.BUFFER: 1,
    IntentKind.HABIT: 2,
    IntentKind.FOCUS: 3,
    IntentKind.TASK: 4,
}


class DailyWindow(BaseModel):
    """An allowed time-of-day range, in minutes from local midnight."""

    start_min: int = Field(ge=0, le=24 * 60)
    end_min: int = Field(ge=0, le=24 * 60)

    @model_validator(mode="after")
    def _ordered(self) -> DailyWindow:
        if self.end_min <= self.start_min:
            raise ValueError(f"window end {self.end_min} must exceed start {self.start_min}")
        return self


class CompletedBlock(BaseModel):
    """One concrete scheduled block that the user marked as completed.

    Stored as absolute datetimes rather than solver occurrence numbers or
    relative slots, because the scheduling horizon origin moves every day.
    """

    start: datetime
    end: datetime
    completed_at: datetime

    @model_validator(mode="after")
    def _ordered(self) -> CompletedBlock:
        if self.end <= self.start:
            raise ValueError("completed block end must be after start")
        return self


class NotNowBlock(BaseModel):
    """A concrete placement the user explicitly rejected for this intent."""

    start: datetime
    end: datetime

    @model_validator(mode="after")
    def _ordered(self) -> NotNowBlock:
        if self.end <= self.start:
            raise ValueError("not-now block end must be after start")
        return self


class Intent(BaseModel):
    """A demand for time that the solver must satisfy."""

    id: str
    kind: IntentKind
    title: str
    priority: Priority = Priority.P3
    category: WorkCategory | None = None
    first_step: str | None = None
    energy_required: EnergyRequired | None = None
    original_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    # How much time, over what repeating period.
    minutes_per_period: int = Field(gt=0)
    period_days: int | None = Field(default=None, gt=0)
    """None = a one-shot demand (a task). 7 = "per week" (a habit, focus goal)."""

    # Chunking. Equal min/max means non-interruptible.
    min_chunk_minutes: int = Field(gt=0)
    max_chunk_minutes: int = Field(gt=0)
    max_per_day: int | None = Field(default=None, gt=0)

    # Where in the day it may land. Empty = anywhere.
    daily_windows: list[DailyWindow] = Field(default_factory=list)

    # Which ISO weekdays it may land on: Monday=0 ... Sunday=6.
    # Empty = any day, preserving the existing scheduling behaviour.
    allowed_weekdays: list[int] = Field(default_factory=list)

    # Absolute bounds, as slots from the horizon origin.
    earliest_slot: int | None = None
    latest_slot: int | None = None
    """Hard upper bound for placement. Unlike due_slot, work may never be
    placed at or beyond this slot. Used for a meeting constrained to one
    selected calendar day/window."""

    due_slot: int | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    """Optional explicit user-facing maximum deadline (local calendar date).

    Unlike due_slot, this survives as readable metadata so the UI can
    distinguish a real deadline from other solver bounds.
    """

    preferred_start_min: int | None = Field(default=None, ge=0, le=24 * 60)
    """Time-of-day the user would rather this land at. A soft objective term."""

    blocked_slots: list[tuple[int, int]] = Field(default_factory=list)
    """Spans this intent alone may not occupy — the union of the other
    attendees' busy time for a Smart Meeting.

    Kept per-intent rather than folded into the global busy list because these
    are not *your* commitments: a colleague's 2pm meeting must stop this one
    meeting landing at 2pm, while leaving 2pm perfectly available for your own
    focus time. Merging the two would quietly blank out your calendar with
    other people's schedules."""

    zoom_meeting_id: str | None = None
    zoom_join_url: str | None = None
    """Set automatically for a Smart Meeting when HOROLOG_ZOOM_* is
    configured (see integrations/zoom.py). Server-set only — never accepted
    from `IntentIn`, so a client cannot fabricate a fake link. Created as a
    "no fixed time" meeting, so `zoom_join_url` stays correct regardless of
    which slot the solver places it in, or how a later re-solve moves it —
    nothing here has to stay in sync with the placement engine."""

    completed_blocks: list[CompletedBlock] = Field(default_factory=list)
    not_now_blocks: list[NotNowBlock] = Field(default_factory=list)
    """Concrete scheduled occurrences already completed by the user.

    Stored as absolute datetimes so completion remains stable when the
    scheduling horizon origin advances.
    """

    completed_at: datetime | None = None
    """Set once, never cleared automatically. `solver/expand.py` skips a
    completed intent entirely, so its capacity is freed on the very next
    solve — the row itself is kept rather than deleted, so the inbox and
    analytics can still show it was done. Scoped to one-shot tasks
    (`period_days is None`) at the API layer (`api.py`'s complete/uncomplete
    routes) — checking off one occurrence of a recurring habit needs
    per-occurrence state, a real feature and not this one.
    ponytail: upgrade path is per-occurrence completion for habits, when
    someone actually asks for habit streaks."""

    @model_validator(mode="after")
    def _coherent(self) -> Intent:
        if self.max_chunk_minutes < self.min_chunk_minutes:
            raise ValueError(
                f"max_chunk {self.max_chunk_minutes} < min_chunk {self.min_chunk_minutes}"
            )
        if self.minutes_per_period < self.min_chunk_minutes:
            raise ValueError(
                f"minutes_per_period {self.minutes_per_period} is smaller than one "
                f"min chunk ({self.min_chunk_minutes}); it could never be placed"
            )
        for field in ("minutes_per_period", "min_chunk_minutes", "max_chunk_minutes"):
            value: int = getattr(self, field)
            if value % SLOT_MINUTES:
                raise ValueError(f"{field}={value} must be a multiple of {SLOT_MINUTES} minutes")
        if (
            self.earliest_slot is not None
            and self.latest_slot is not None
            and self.latest_slot <= self.earliest_slot
        ):
            raise ValueError(
                f"latest_slot {self.latest_slot} must exceed earliest_slot {self.earliest_slot}"
            )
        if (
            self.earliest_slot is not None
            and self.due_slot is not None
            and self.due_slot <= self.earliest_slot
        ):
            raise ValueError(f"due_slot {self.due_slot} must exceed earliest_slot")
        if any(day < 0 or day > 6 for day in self.allowed_weekdays):
            raise ValueError("allowed_weekdays values must be between 0 (Monday) and 6 (Sunday)")
        if len(set(self.allowed_weekdays)) != len(self.allowed_weekdays):
            raise ValueError("allowed_weekdays must not contain duplicates")
        for window in self.daily_windows:
            span = window.end_min - window.start_min
            if span < self.min_chunk_minutes:
                raise ValueError(
                    f"window {window.start_min}-{window.end_min} is {span}min, shorter "
                    f"than min_chunk {self.min_chunk_minutes}; nothing could fit in it"
                )
        return self

    @property
    def required_slots(self) -> int:
        return minutes_to_slots(self.minutes_per_period)

    @property
    def min_chunk_slots(self) -> int:
        return minutes_to_slots(self.min_chunk_minutes)

    @property
    def max_chunk_slots(self) -> int:
        return minutes_to_slots(self.max_chunk_minutes)
