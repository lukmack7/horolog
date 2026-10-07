"""HTTP surface.

Slots stop at this boundary: everything crossing the wire is an ISO datetime.
The UI never learns that the engine thinks in 15-minute integers.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import AfterValidator, BaseModel, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from horolog import oauth
from horolog.analytics import Analytics, analyse
from horolog.assistant import (
    AssistantAction,
    AssistantMessage,
    converse,
    suggest_todo_item,
)
from horolog.capture import capture, capture_daily_actions, to_payload
from horolog.db import (
    BusyRow,
    ChangeSetRow,
    DailyItemDecisionRow,
    DailyItemMetaRow,
    DailyPlanItemRow,
    DailyPlanRow,
    DailyReviewRow,
    IntentRow,
    NotificationSettingsRow,
    SyncedBlockRow,
    TimeEntryRow,
    TodoInboxRow,
    UserSettingsRow,
    init_db,
    load_intents,
    load_previous_plan,
    save_plan,
    session,
)
from horolog.domain.events import BusyInterval
from horolog.domain.intent import (
    CompletedBlock,
    DailyWindow,
    Intent,
    IntentKind,
    Priority,
    WorkCategory,
)
from horolog.domain.plan import Plan
from horolog.domain.time import (
    SLOT_MINUTES,
    SLOTS_PER_DAY,
    from_slot,
    minutes_to_slots,
    to_slot,
)
from horolog.integrations.clickup import ClickUpError, fetch_clickup_tasks
from horolog.integrations.github import GithubError, fetch_github_issues
from horolog.integrations.google_calendar import GoogleCalendarProvider, GoogleCalendarWriter
from horolog.integrations.jira import JiraError, fetch_jira_issues
from horolog.integrations.linear import LinearError, fetch_linear_issues
from horolog.integrations.notion import NotionError, fetch_notion_tasks
from horolog.integrations.outlook_calendar import OutlookCalendarProvider, OutlookCalendarWriter
from horolog.integrations.todoist import TodoistError, fetch_todoist_tasks
from horolog.integrations.zoom import ZoomError, create_meeting, delete_meeting
from horolog.llm import (
    AnthropicProvider,
    ExtractionFailed,
    OpenAICompatible,
    Provider,
    ProviderError,
)
from horolog.providers import (
    BUFFER_SOURCE,
    CalDAVProvider,
    CalendarProvider,
    ICSProvider,
    SyncError,
    decompression_buffers,
    to_ics,
)
from horolog.settings import settings
from horolog.solver.solve import merge_busy, solve

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Time origin
# --------------------------------------------------------------------------


def origin() -> datetime:
    """Midnight today in the configured zone.

    Recomputed per request rather than pinned at boot, so a process that stays
    up across midnight does not keep scheduling into yesterday.
    """
    now = datetime.now(settings().zone)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def horizon_slots() -> int:
    return settings().horizon_days * SLOTS_PER_DAY


USER_SETTINGS_ID = 1


async def _preferred_workday(db: AsyncSession) -> tuple[int, int]:
    """Return the editable single-user workday preference, falling back to env."""

    row = await db.get(UserSettingsRow, USER_SETTINGS_ID)
    cfg = settings()
    if (
        row is None
        or row.preferred_workday_start_min is None
        or row.preferred_workday_end_min is None
    ):
        return cfg.workday_start_min, cfg.workday_end_min
    return row.preferred_workday_start_min, row.preferred_workday_end_min


MAX_PUSH_OPS = 200
"""Hard cap on create/patch/delete calls in one calendar push — same
convention as `integrations/notion.py`'s `MAX_PAGES`. A first push against a
large plan must not exhaust the provider's write quota in one call; whatever
does not fit catches up on the next background tick or the next explicit
push, since the diff against `synced_blocks` is what decides what is left."""


def _clip(start: int, end: int) -> tuple[int, int] | None:
    """Trim a span to the horizon, or None if it falls entirely outside it.

    Guards the write path. `BusyInterval` refuses a negative slot, so storing a
    yesterday event — trivially posted by a client in a timezone behind the
    server, or by anyone entering a meeting that has already begun — used to
    make every later read of the plan raise on the way out. The row could then
    only be removed from the database by hand. Feed events have always been
    clipped in `_to_interval`; the hand-entered path just never was.
    """
    lo, hi = max(start, 0), min(end, horizon_slots())
    return (lo, hi) if hi > lo else None


def _localise(value: datetime | None) -> datetime | None:
    """Attach the configured zone to a naive datetime.

    ICS files and plenty of calendar clients emit "floating" local times with no
    offset, and a browser's `toISOString()` drops the zone too. The engine
    requires aware datetimes, so without normalising here every such input
    reaches `to_slot` and raises — a 500 for input that is entirely ordinary.

    Applied as a field validator on every wire model rather than at each call
    site, so a new datetime field cannot reintroduce the bug by omission.
    """
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=settings().zone)


LocalDateTime = Annotated[datetime, AfterValidator(_localise)]


# --------------------------------------------------------------------------
# Wire contracts
# --------------------------------------------------------------------------


class IntentIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    kind: IntentKind = IntentKind.TASK
    priority: Priority = Priority.P3
    category: WorkCategory | None = None
    minutes_per_period: int = Field(gt=0)
    period_days: int | None = Field(default=None, gt=0)
    min_chunk_minutes: int = Field(default=30, gt=0)
    max_chunk_minutes: int = Field(default=120, gt=0)
    max_per_day: int | None = Field(default=None, gt=0)
    allowed_weekdays: list[int] = Field(default_factory=list)
    window_start_min: int | None = None
    window_end_min: int | None = None
    due: LocalDateTime | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    earliest: LocalDateTime | None = None
    latest: LocalDateTime | None = None
    preferred_start_min: int | None = None

    attendee_busy: list[AttendeeBusy] = Field(default_factory=list)
    """Other attendees' commitments, for a Smart Meeting.

    Constrains this intent only. Deliberately not merged into the shared busy
    mirror: a colleague being booked at 2pm must stop *this meeting* landing at
    2pm without blanking 2pm out for your own focus time."""

    @model_validator(mode="after")
    def _snap_to_solver_grid(self) -> IntentIn:
        """Accept human minute values at the HTTP boundary.

        The solver operates on 15-minute slots. Direct UI/API calls used to
        leak values such as 123 minutes into the domain model and fail with a
        Pydantic validation error. Capture already snaps durations; every other
        entry point should have the same forgiving boundary behaviour.
        """
        step = SLOT_MINUTES

        def up(value: int) -> int:
            return max(step, -(-value // step) * step)

        self.minutes_per_period = up(self.minutes_per_period)
        self.min_chunk_minutes = up(self.min_chunk_minutes)
        self.max_chunk_minutes = max(self.min_chunk_minutes, up(self.max_chunk_minutes))

        if self.window_start_min is not None:
            self.window_start_min = max(0, (self.window_start_min // step) * step)
        if self.window_end_min is not None:
            self.window_end_min = min(24 * 60, -(-self.window_end_min // step) * step)
        if self.preferred_start_min is not None:
            snapped = ((self.preferred_start_min + step // 2) // step) * step
            self.preferred_start_min = min(24 * 60 - step, max(0, snapped))

        return self

    def to_domain(
        self,
        ident: str,
        base: datetime,
        default_workday: tuple[int, int] | None = None,
    ) -> Intent:
        cfg = settings()
        default_start, default_end = default_workday or (
            cfg.workday_start_min,
            cfg.workday_end_min,
        )
        start = (
            self.window_start_min if self.window_start_min is not None else default_start
        )
        end = self.window_end_min if self.window_end_min is not None else default_end

        # A specific preferred start outside the normal workday must still be
        # schedulable. Keep it soft: widen the default window rather than
        # turning the requested clock time into a fixed appointment.
        if (
            self.window_start_min is None
            and self.window_end_min is None
            and self.preferred_start_min is not None
        ):
            start = min(start, self.preferred_start_min)
            end = max(
                end,
                min(24 * 60, self.preferred_start_min + self.min_chunk_minutes),
            )

        return Intent(
            id=ident,
            kind=self.kind,
            title=self.title,
            priority=self.priority,
            category=self.category,
            minutes_per_period=self.minutes_per_period,
            period_days=self.period_days,
            min_chunk_minutes=self.min_chunk_minutes,
            max_chunk_minutes=self.max_chunk_minutes,
            max_per_day=self.max_per_day,
            daily_windows=[DailyWindow(start_min=start, end_min=end)],
            allowed_weekdays=self.allowed_weekdays,
            earliest_slot=to_slot(self.earliest, base) if self.earliest else None,
            latest_slot=to_slot(self.latest, base) if self.latest else None,
            due_slot=to_slot(self.due, base) if self.due else None,
            deadline_date=self.deadline_date,
            preferred_start_min=self.preferred_start_min,
            blocked_slots=[
                (to_slot(a.start, base), to_slot(a.end, base))
                for a in self.attendee_busy
                if to_slot(a.end, base) > to_slot(a.start, base)
            ],
        )


class AttendeeBusy(BaseModel):
    """One span in which some other attendee is unavailable."""

    start: LocalDateTime
    end: LocalDateTime
    attendee: str = ""


class CompletedBlockIn(BaseModel):
    start: LocalDateTime
    end: LocalDateTime


class MoveIntentIn(BaseModel):
    start: LocalDateTime
    end: LocalDateTime
    exact: bool = True


class UserPreferencesIn(BaseModel):
    preferred_workday_start_min: int = Field(ge=0, lt=24 * 60)
    preferred_workday_end_min: int = Field(gt=0, le=24 * 60)

    @model_validator(mode="after")
    def _valid_workday(self) -> "UserPreferencesIn":
        if self.preferred_workday_end_min <= self.preferred_workday_start_min:
            raise ValueError("workday end must be after workday start")
        if (
            self.preferred_workday_start_min % SLOT_MINUTES
            or self.preferred_workday_end_min % SLOT_MINUTES
        ):
            raise ValueError(
                f"workday times must use {SLOT_MINUTES}-minute increments"
            )
        return self


class NotificationPreferencesIn(BaseModel):
    task_enabled: bool = True
    task_minutes_before: int = Field(default=15, ge=0, le=240)
    task_at_start: bool = True

    meeting_enabled: bool = True
    meeting_minutes_before: int = Field(default=15, ge=0, le=240)
    meeting_at_start: bool = True

    deadline_enabled: bool = True
    deadline_days_before: int = Field(default=1, ge=0, le=30)
    deadline_time_min: int = Field(default=9 * 60, ge=0, lt=24 * 60)

    end_of_day_enabled: bool = True
    end_of_day_time_min: int = Field(default=20 * 60 + 30, ge=0, lt=24 * 60)



class IntentPatchIn(BaseModel):
    """Safe metadata-only intent edit.

    Used by Planner and Smart Meetings for fields that do not change the
    scheduling shape. Applying the patch to the stored domain object preserves
    meeting-only state such as attendee blocked slots and Zoom metadata.
    """

    title: str | None = Field(default=None, min_length=1, max_length=200)
    priority: Priority | None = None
    category: WorkCategory | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class BusyIn(BaseModel):
    label: str = ""
    start: LocalDateTime
    end: LocalDateTime
    source: str = "manual"


class TodoInboxIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    minutes: int = Field(default=30, gt=0, le=480)
    category: WorkCategory | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def _validate_deadline(self) -> "TodoInboxIn":
        if self.deadline_date is not None:
            _daily_date(self.deadline_date)
        self.minutes = max(SLOT_MINUTES, minutes_to_slots(self.minutes) * SLOT_MINUTES)
        return self


class TodoInboxPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    minutes: int | None = Field(default=None, gt=0, le=480)
    category: WorkCategory | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def _validate_values(self) -> "TodoInboxPatch":
        if self.deadline_date is not None:
            _daily_date(self.deadline_date)
        if self.minutes is not None:
            self.minutes = max(SLOT_MINUTES, minutes_to_slots(self.minutes) * SLOT_MINUTES)
        return self


class TodoAssignIn(BaseModel):
    date: str = Field(min_length=10, max_length=10)
    quadrant: int = Field(ge=1, le=4)


class DailyPlanIn(BaseModel):
    win_condition: str = Field(default="", max_length=1000)
    first_step: str = Field(default="", max_length=1000)


class DailyCaptureIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    quadrant: int = Field(ge=1, le=4)
    default_minutes: int = Field(default=30, gt=0, le=480)
    category: WorkCategory | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class DailyMeetingConfirmIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    date: str = Field(min_length=10, max_length=10)
    start_min: int = Field(ge=0, lt=24 * 60)
    minutes: int = Field(default=30, gt=0, le=480)
    priority: Priority = Priority.P2
    category: WorkCategory | None = None


class DailyItemIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    quadrant: int = Field(ge=1, le=4)
    minutes: int = Field(default=30, gt=0, le=480)
    priority: Priority = Priority.P3
    category: WorkCategory | None = None
    deadline_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    schedule_enabled: bool = True
    intent_id: str | None = None


class DailyDeferIn(BaseModel):
    until: str = Field(min_length=10, max_length=10)


class DailyDecisionIn(BaseModel):
    date: str = Field(min_length=10, max_length=10)


class DailyMoveIn(BaseModel):
    quadrant: int = Field(ge=1, le=4)
    date: str = Field(min_length=10, max_length=10)


class DailyReviewIn(BaseModel):
    did_well: str = Field(default="", max_length=4000)
    grateful_for: str = Field(default="", max_length=4000)
    would_change: str = Field(default="", max_length=4000)
    learned: str = Field(default="", max_length=4000)
    improve_tomorrow: str = Field(default="", max_length=4000)
    first_step_morning: str = Field(default="", max_length=4000)


class BlockOut(BaseModel):
    intent_id: str
    title: str
    kind: IntentKind
    priority: Priority
    category: WorkCategory | None = None
    occurrence: int
    chunk: int
    start: datetime
    end: datetime
    moved_from: datetime | None = None
    completed: bool = False
    recurring: bool = False


class UnmetOut(BaseModel):
    intent_id: str
    title: str
    priority: Priority
    shortfall_minutes: int


class PlanOut(BaseModel):
    blocks: list[BlockOut]
    unmet: list[UnmetOut]
    busy: list[BusyIn]
    solve_ms: float
    complete: bool
    generated_at: datetime
    origin: datetime
    horizon_days: int


# --------------------------------------------------------------------------
# Change stream
# --------------------------------------------------------------------------


class Broadcast:
    """Fan-out to connected SSE clients.

    ponytail: in-process only. Multiple API workers each hold their own
    subscriber set, so a change on worker A never reaches a client attached to
    worker B. Move to Postgres LISTEN/NOTIFY when running more than one process.
    """

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[str]]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=16)
        self._subscribers.add(queue)
        try:
            yield queue
        finally:
            self._subscribers.discard(queue)

    def publish(self, event: str) -> None:
        for queue in list(self._subscribers):
            # A client too slow to keep up is dropped from this message rather
            # than allowed to block the request that produced it.
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)


bus = Broadcast()


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await init_db()
    sync_task = asyncio.create_task(_sync_loop())
    try:
        yield
    finally:
        sync_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sync_task


app = FastAPI(title="Horolog", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings().cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Turn opaque FastAPI 500s into traceable incidents.

    The full traceback stays in container logs; the browser only gets a short
    correlation id so runtime errors can be matched without exposing internals.
    """
    error_id = uuid.uuid4().hex[:8]
    logger.exception(
        "Unhandled API error [%s] %s %s",
        error_id,
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": (
                f"Wewnętrzny błąd Horologa (ID: {error_id}). "
                "Szczegóły zapisano w logach API."
            )
        },
    )


@app.get("/api/health")
async def health(db: AsyncSession = Depends(session)) -> dict[str, str]:
    # A process that answers HTTP but can't reach its database is not
    # healthy — Docker's healthcheck (and anything restarting on it) needs
    # to see that, not a static 200 that's identical whether Postgres is up.
    try:
        await db.execute(select(1))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"database unreachable: {exc}") from exc
    return {"status": "ok"}


def _daily_date(value: str) -> datetime:
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="date must be YYYY-MM-DD") from exc
    return parsed.replace(tzinfo=settings().zone)


def _deadline_end(value: str) -> datetime:
    """Exclusive local end boundary for a user-facing deadline date."""
    return _daily_date(value) + timedelta(days=1)


def _daily_item_dict(
    row: DailyPlanItemRow,
    requested_date: str,
    intent_payload: dict[str, Any] | None,
    decision: DailyItemDecisionRow | None = None,
    meta: DailyItemMetaRow | None = None,
) -> dict[str, Any]:
    completed_at = row.completed_at
    if completed_at is None and intent_payload and intent_payload.get("completed_at"):
        completed_at = datetime.fromisoformat(intent_payload["completed_at"])
    return {
        "id": row.id,
        "plan_date": row.plan_date,
        "title": row.title,
        "quadrant": row.quadrant,
        "minutes": row.minutes,
        "priority": row.priority,
        "category": (
            intent_payload.get("category")
            if intent_payload and intent_payload.get("category") is not None
            else (
                row.category
                if row.category in {category.value for category in WorkCategory}
                else None
            )
        ),
        "intent_id": row.intent_id,
        "deadline_date": (
            meta.deadline_date
            if meta is not None
            else (
                intent_payload.get("deadline_date")
                if intent_payload
                else None
            )
        ),
        "schedule_enabled": row.schedule_enabled,
        "completed_at": completed_at.isoformat() if completed_at else None,
        "cancelled_at": row.cancelled_at.isoformat() if row.cancelled_at else None,
        "carried": row.plan_date < requested_date and completed_at is None and row.cancelled_at is None,
        "carry_days": max(
            0,
            (_daily_date(requested_date).date() - _daily_date(row.plan_date).date()).days,
        ),
        "defer_until": decision.defer_until if decision else None,
        "needs_decision": (
            completed_at is None
            and row.cancelled_at is None
            and row.plan_date < requested_date
            and (_daily_date(requested_date).date() - _daily_date(row.plan_date).date()).days >= 2
            and (decision is None or decision.acknowledged_date != requested_date)
        ),
    }


async def _roll_daily_intent(
    row: DailyPlanItemRow,
    target_date: str,
    db: AsyncSession,
) -> None:
    """Move one unfinished Daily task into target_date without duplicating it."""
    if not row.schedule_enabled or not row.intent_id:
        return
    intent_row = await db.get(IntentRow, row.intent_id)
    if intent_row is None:
        return
    intent = Intent.model_validate(intent_row.payload)
    if intent.completed_at is not None or intent.period_days is not None:
        return

    day = _daily_date(target_date)
    earliest = day
    due = _deadline_end(intent.deadline_date) if intent.deadline_date else day + timedelta(days=1)
    if due <= earliest:
        raise HTTPException(
            status_code=422,
            detail="Nie można przenieść zadania po jego maksymalnym deadline.",
        )
    wire = IntentIn(
        title=intent.title,
        kind=intent.kind,
        priority=intent.priority,
        category=intent.category,
        minutes_per_period=intent.minutes_per_period,
        period_days=None,
        min_chunk_minutes=intent.min_chunk_minutes,
        max_chunk_minutes=intent.max_chunk_minutes,
        max_per_day=intent.max_per_day,
        allowed_weekdays=[],
        earliest=earliest,
        due=due,
        deadline_date=intent.deadline_date,
        preferred_start_min=intent.preferred_start_min,
    )
    moved = wire.to_domain(intent.id, origin(), await _preferred_workday(db)).model_copy(
        update={
            "completed_at": intent.completed_at,
            "completed_blocks": intent.completed_blocks,
        }
    )
    intent_row.payload = moved.model_dump(mode="json")


def _todo_dict(row: TodoInboxRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "title": row.title,
        "minutes": row.minutes,
        "category": row.category,
        "deadline_date": row.deadline_date,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


@app.get("/api/todos")
async def list_todos(db: AsyncSession = Depends(session)) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(TodoInboxRow).where(TodoInboxRow.assigned_at.is_(None))
        )
    ).scalars().all()
    rows = sorted(
        rows,
        key=lambda row: (
            row.deadline_date is None,
            row.deadline_date or "9999-12-31",
            row.created_at,
        ),
    )
    return [_todo_dict(row) for row in rows]


@app.post("/api/todos", status_code=201)
async def create_todo(
    body: TodoInboxIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = TodoInboxRow(
        id=uuid.uuid4().hex[:16],
        title=body.title.strip(),
        minutes=body.minutes,
        category=body.category.value if body.category is not None else None,
        deadline_date=body.deadline_date,
    )
    db.add(row)
    await db.commit()
    return _todo_dict(row)


@app.post("/api/todos/{todo_id}/suggest")
async def suggest_todo(
    todo_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = await db.get(TodoInboxRow, todo_id)
    if row is None or row.assigned_at is not None:
        raise HTTPException(status_code=404, detail="todo item not found")

    category = (
        WorkCategory(row.category)
        if row.category in {item.value for item in WorkCategory}
        else None
    )
    try:
        suggestion = await suggest_todo_item(
            title=row.title,
            current_minutes=row.minutes,
            current_category=category,
            current_deadline_date=row.deadline_date,
        )
    except ExtractionFailed as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ProviderError, httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"language model unreachable: {exc}",
        ) from exc

    return suggestion.model_dump(mode="json")


@app.patch("/api/todos/{todo_id}")
async def patch_todo(
    todo_id: str,
    body: TodoInboxPatch,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = await db.get(TodoInboxRow, todo_id)
    if row is None or row.assigned_at is not None:
        raise HTTPException(status_code=404, detail="todo item not found")

    if body.title is not None:
        row.title = body.title.strip()
    if body.minutes is not None:
        row.minutes = body.minutes
    if "category" in body.model_fields_set:
        row.category = body.category.value if body.category is not None else None
    if "deadline_date" in body.model_fields_set:
        row.deadline_date = body.deadline_date
    row.updated_at = datetime.now(UTC)

    await db.commit()
    return _todo_dict(row)


@app.delete("/api/todos/{todo_id}", status_code=204)
async def delete_todo(todo_id: str, db: AsyncSession = Depends(session)) -> Response:
    row = await db.get(TodoInboxRow, todo_id)
    if row is None or row.assigned_at is not None:
        raise HTTPException(status_code=404, detail="todo item not found")
    await db.delete(row)
    await db.commit()
    return Response(status_code=204)


@app.post("/api/todos/{todo_id}/assign", status_code=201)
async def assign_todo_to_daily(
    todo_id: str,
    body: TodoAssignIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = await db.get(TodoInboxRow, todo_id)
    if row is None or row.assigned_at is not None:
        raise HTTPException(status_code=404, detail="todo item not found")

    target = _daily_date(body.date)
    if (
        body.quadrant <= 2
        and row.deadline_date is not None
        and _deadline_end(row.deadline_date) <= target
    ):
        raise HTTPException(
            status_code=422,
            detail="Maksymalny deadline tego zadania już minął. Zmień deadline przed dodaniem do planu.",
        )

    item = await create_daily_item(
        body.date,
        DailyItemIn(
            title=row.title,
            quadrant=body.quadrant,
            minutes=row.minutes,
            category=WorkCategory(row.category) if row.category else None,
            deadline_date=row.deadline_date,
            schedule_enabled=body.quadrant <= 2,
        ),
        db,
    )
    row.assigned_at = datetime.now(UTC)
    row.updated_at = datetime.now(UTC)
    await db.commit()
    return item


NOTIFICATION_SETTINGS_ID = 1


def _notification_settings_dict(
    row: NotificationSettingsRow | None,
) -> dict[str, int | bool]:
    return {
        "task_enabled": row.task_enabled if row is not None else True,
        "task_minutes_before": row.task_minutes_before if row is not None else 15,
        "task_at_start": row.task_at_start if row is not None else True,
        "meeting_enabled": row.meeting_enabled if row is not None else True,
        "meeting_minutes_before": row.meeting_minutes_before if row is not None else 15,
        "meeting_at_start": row.meeting_at_start if row is not None else True,
        "deadline_enabled": row.deadline_enabled if row is not None else True,
        "deadline_days_before": row.deadline_days_before if row is not None else 1,
        "deadline_time_min": row.deadline_time_min if row is not None else 9 * 60,
        "end_of_day_enabled": row.end_of_day_enabled if row is not None else True,
        "end_of_day_time_min": (
            row.end_of_day_time_min if row is not None else 20 * 60 + 30
        ),
    }


@app.get("/api/settings/notifications")
async def get_notification_preferences(
    db: AsyncSession = Depends(session),
) -> dict[str, int | bool]:
    row = await db.get(NotificationSettingsRow, NOTIFICATION_SETTINGS_ID)
    return _notification_settings_dict(row)


@app.put("/api/settings/notifications")
async def put_notification_preferences(
    body: NotificationPreferencesIn,
    db: AsyncSession = Depends(session),
) -> dict[str, int | bool]:
    row = await db.get(NotificationSettingsRow, NOTIFICATION_SETTINGS_ID)
    if row is None:
        row = NotificationSettingsRow(id=NOTIFICATION_SETTINGS_ID)
        db.add(row)

    for field, value in body.model_dump().items():
        setattr(row, field, value)
    row.updated_at = datetime.now(UTC)

    await db.commit()
    return _notification_settings_dict(row)


@app.get("/api/settings")
async def get_user_preferences(
    db: AsyncSession = Depends(session),
) -> dict[str, int]:
    start, end = await _preferred_workday(db)
    return {
        "preferred_workday_start_min": start,
        "preferred_workday_end_min": end,
    }


@app.put("/api/settings")
async def put_user_preferences(
    body: UserPreferencesIn,
    db: AsyncSession = Depends(session),
) -> dict[str, int]:
    old_start, old_end = await _preferred_workday(db)

    row = await db.get(UserSettingsRow, USER_SETTINGS_ID)
    if row is None:
        row = UserSettingsRow(id=USER_SETTINGS_ID)
        db.add(row)

    row.preferred_workday_start_min = body.preferred_workday_start_min
    row.preferred_workday_end_min = body.preferred_workday_end_min
    row.updated_at = datetime.now(UTC)

    # Existing flexible intents that still use the previous default window
    # follow the new preference immediately. Exact/manual placements have a
    # hard latest_slot and are deliberately left untouched.
    intent_rows = (await db.execute(select(IntentRow))).scalars().all()
    for intent_row in intent_rows:
        intent = Intent.model_validate(intent_row.payload)
        if (
            intent.kind not in (IntentKind.TASK, IntentKind.HABIT, IntentKind.FOCUS)
            or intent.latest_slot is not None
            or len(intent.daily_windows) != 1
        ):
            continue
        window = intent.daily_windows[0]
        if window.start_min != old_start or window.end_min != old_end:
            continue
        if (
            body.preferred_workday_end_min - body.preferred_workday_start_min
            < intent.min_chunk_minutes
        ):
            continue
        updated = intent.model_copy(
            update={
                "daily_windows": [
                    DailyWindow(
                        start_min=body.preferred_workday_start_min,
                        end_min=body.preferred_workday_end_min,
                    )
                ]
            }
        )
        intent_row.payload = updated.model_dump(mode="json")

    await db.commit()
    await _replan(db)
    return {
        "preferred_workday_start_min": body.preferred_workday_start_min,
        "preferred_workday_end_min": body.preferred_workday_end_min,
    }


@app.get("/api/daily-history")
async def daily_history(db: AsyncSession = Depends(session)) -> list[dict[str, Any]]:
    plans = (await db.execute(select(DailyPlanRow))).scalars().all()
    reviews = (await db.execute(select(DailyReviewRow))).scalars().all()
    items = (await db.execute(select(DailyPlanItemRow))).scalars().all()

    plan_map = {row.date: row for row in plans}
    review_map = {row.date: row for row in reviews}
    dates = sorted(set(plan_map) | set(review_map) | {row.plan_date for row in items}, reverse=True)

    result: list[dict[str, Any]] = []
    for date in dates[:90]:
        review = review_map.get(date)
        created = [row for row in items if row.plan_date == date and row.cancelled_at is None]
        completed = [
            row for row in created
            if row.completed_at is not None
        ]
        review_values = (
            [
                review.did_well,
                review.grateful_for,
                review.would_change,
                review.learned,
                review.improve_tomorrow,
                review.first_step_morning,
            ]
            if review
            else []
        )
        plan = plan_map.get(date)
        result.append(
            {
                "date": date,
                "win_condition": plan.win_condition if plan else "",
                "first_step": plan.first_step if plan else "",
                "items": len(created),
                "completed_items": len(completed),
                "review_answers": sum(1 for value in review_values if value.strip()),
                "has_review": bool(review and any(value.strip() for value in review_values)),
            }
        )
    return result


@app.get("/api/daily-weekly/{date}")
async def daily_weekly(date: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    selected = _daily_date(date).date()
    monday = selected - timedelta(days=selected.weekday())
    sunday = monday + timedelta(days=6)
    start = monday.isoformat()
    end = sunday.isoformat()

    plans = (
        await db.execute(
            select(DailyPlanRow).where(DailyPlanRow.date >= start, DailyPlanRow.date <= end)
        )
    ).scalars().all()
    reviews = (
        await db.execute(
            select(DailyReviewRow).where(DailyReviewRow.date >= start, DailyReviewRow.date <= end)
        )
    ).scalars().all()
    items = (
        await db.execute(
            select(DailyPlanItemRow).where(
                DailyPlanItemRow.plan_date >= start,
                DailyPlanItemRow.plan_date <= end,
                DailyPlanItemRow.cancelled_at.is_(None),
            )
        )
    ).scalars().all()

    completed = [
        row for row in items
        if row.completed_at is not None
        and monday <= row.completed_at.astimezone(settings().zone).date() <= sunday
    ]
    carried = [
        row for row in items
        if row.completed_at is None
        and (origin().date() - _daily_date(row.plan_date).date()).days >= 1
    ]

    reflection_highlights: list[dict[str, str]] = []
    for review in sorted(reviews, key=lambda row: row.date, reverse=True):
        if review.learned.strip():
            reflection_highlights.append(
                {"date": review.date, "kind": "learned", "text": review.learned.strip()}
            )
        if review.improve_tomorrow.strip():
            reflection_highlights.append(
                {
                    "date": review.date,
                    "kind": "improve",
                    "text": review.improve_tomorrow.strip(),
                }
            )

    days: list[dict[str, Any]] = []
    review_map = {row.date: row for row in reviews}
    plan_map = {row.date: row for row in plans}
    for offset in range(7):
        day = monday + timedelta(days=offset)
        key = day.isoformat()
        review = review_map.get(key)
        review_count = (
            sum(
                1
                for value in [
                    review.did_well,
                    review.grateful_for,
                    review.would_change,
                    review.learned,
                    review.improve_tomorrow,
                    review.first_step_morning,
                ]
                if value.strip()
            )
            if review
            else 0
        )
        days.append(
            {
                "date": key,
                "planned": key in plan_map,
                "review_answers": review_count,
                "items": sum(1 for row in items if row.plan_date == key),
                "completed_items": sum(
                    1
                    for row in items
                    if row.plan_date == key and row.completed_at is not None
                ),
            }
        )

    return {
        "start": start,
        "end": end,
        "planned_days": len(plans),
        "reviewed_days": sum(1 for day in days if day["review_answers"] > 0),
        "items_created": len(items),
        "items_completed": len(completed),
        "carry_over": len(carried),
        "stale_items": sum(
            1
            for row in carried
            if (origin().date() - _daily_date(row.plan_date).date()).days >= 2
        ),
        "days": days,
        "reflection_highlights": reflection_highlights[:8],
    }


@app.get("/api/daily/{date}")
async def get_daily(date: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    requested = _daily_date(date)
    today = origin().date()
    plan_row = await db.get(DailyPlanRow, date)
    review_row = await db.get(DailyReviewRow, date)
    previous_date = (requested - timedelta(days=1)).strftime("%Y-%m-%d")
    previous_review = await db.get(DailyReviewRow, previous_date)

    rows = (
        await db.execute(
            select(DailyPlanItemRow).where(
                DailyPlanItemRow.plan_date <= date,
                DailyPlanItemRow.cancelled_at.is_(None),
            )
        )
    ).scalars().all()
    item_ids = [row.id for row in rows]
    decisions = (
        (
            await db.execute(
                select(DailyItemDecisionRow).where(DailyItemDecisionRow.item_id.in_(item_ids))
            )
        ).scalars().all()
        if item_ids
        else []
    )
    decision_map = {row.item_id: row for row in decisions}
    rows = [
        row
        for row in rows
        if not (
            (decision := decision_map.get(row.id))
            and decision.defer_until
            and decision.defer_until > date
        )
    ]

    # Reading Daily must never mutate Planner dates. Unfinished items are
    # rendered as carry-over until the user explicitly chooses to defer/move
    # them. In particular, opening tomorrow while planning ahead must not
    # silently move today's unfinished Planner tasks to tomorrow.

    meta_rows = (
        (
            await db.execute(
                select(DailyItemMetaRow).where(DailyItemMetaRow.item_id.in_(item_ids))
            )
        ).scalars().all()
        if item_ids
        else []
    )
    meta_map = {row.item_id: row for row in meta_rows}

    intent_ids = [row.intent_id for row in rows if row.intent_id]
    intent_map: dict[str, dict[str, Any]] = {}
    if intent_ids:
        intent_rows = (
            await db.execute(select(IntentRow).where(IntentRow.id.in_(intent_ids)))
        ).scalars().all()
        intent_map = {row.id: row.payload for row in intent_rows}

    items = [
        _daily_item_dict(
            row,
            date,
            intent_map.get(row.intent_id or ""),
            decision_map.get(row.id),
            meta_map.get(row.id),
        )
        for row in rows
        if row.completed_at is None or row.plan_date == date
    ]

    rendered = await get_plan(db)
    linked_ids = {row.intent_id for row in rows if row.intent_id}
    suggestions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in rendered.blocks:
        if block.start.astimezone(settings().zone).date() != requested.date():
            continue
        if block.kind != IntentKind.TASK or block.intent_id in linked_ids or block.intent_id in seen:
            continue
        seen.add(block.intent_id)
        suggestions.append(
            {
                "intent_id": block.intent_id,
                "title": block.title,
                "priority": int(block.priority),
                "minutes": sum(
                    int((other.end - other.start).total_seconds() // 60)
                    for other in rendered.blocks
                    if other.intent_id == block.intent_id
                    and other.start.astimezone(settings().zone).date() == requested.date()
                ),
            }
        )

    completed_today = sum(1 for block in rendered.blocks if block.completed and block.start.astimezone(settings().zone).date() == requested.date())
    total_today = sum(1 for block in rendered.blocks if block.start.astimezone(settings().zone).date() == requested.date())

    return {
        "date": date,
        "plan": {
            "win_condition": plan_row.win_condition if plan_row else "",
            "first_step": plan_row.first_step if plan_row else "",
            "closed_at": plan_row.closed_at.isoformat() if plan_row and plan_row.closed_at else None,
        },
        "items": items,
        "suggestions": suggestions,
        "yesterday": {
            "improve": previous_review.improve_tomorrow if previous_review else "",
            "first_step": previous_review.first_step_morning if previous_review else "",
        },
        "review": {
            "did_well": review_row.did_well if review_row else "",
            "grateful_for": review_row.grateful_for if review_row else "",
            "would_change": review_row.would_change if review_row else "",
            "learned": review_row.learned if review_row else "",
            "improve_tomorrow": review_row.improve_tomorrow if review_row else "",
            "first_step_morning": review_row.first_step_morning if review_row else "",
        },
        "summary": {
            "completed_blocks": completed_today,
            "total_blocks": total_today,
            "carry_over": sum(1 for item in items if item["carried"]),
        },
    }


@app.put("/api/daily/{date}")
async def put_daily(date: str, body: DailyPlanIn, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    _daily_date(date)
    row = await db.get(DailyPlanRow, date)
    if row is None:
        row = DailyPlanRow(date=date)
        db.add(row)
    row.win_condition = body.win_condition
    row.first_step = body.first_step
    row.updated_at = datetime.now(UTC)
    await db.commit()
    return {"date": date, "win_condition": row.win_condition, "first_step": row.first_step}


@app.post("/api/daily/{date}/capture", status_code=201)
async def capture_daily(
    date: str,
    body: DailyCaptureIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Create explicit tasks and return meeting mentions for confirmation.

    The LLM may notice a meeting even when it is only context ("prepare for my
    meeting tomorrow"). That meeting is NEVER written automatically; the UI
    asks the user first and lets them supply/adjust date, time and duration.
    """
    selected = _daily_date(date)

    try:
        batch = await capture_daily_actions(body.text, date)
    except ExtractionFailed as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ProviderError, httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=f"language model unreachable: {exc}") from exc

    created: list[dict[str, Any]] = []
    for action in batch.actions:
        action_day = selected + timedelta(days=action.day_offset)
        action_date = action_day.strftime("%Y-%m-%d")
        minutes = action.minutes or body.default_minutes
        minutes = max(SLOT_MINUTES, minutes_to_slots(minutes) * SLOT_MINUTES)

        item = await create_daily_item(
            action_date,
            DailyItemIn(
                title=action.title,
                quadrant=body.quadrant,
                minutes=minutes,
                category=action.category or body.category,
                deadline_date=body.deadline_date,
                schedule_enabled=body.quadrant <= 2,
            ),
            db,
        )
        created.append({"kind": "task", "date": action_date, "item": item})

    meeting_suggestions = []
    for suggestion in batch.meeting_suggestions:
        meeting_day = selected + timedelta(days=suggestion.day_offset)
        meeting_suggestions.append(
            {
                "title": suggestion.title,
                "date": meeting_day.strftime("%Y-%m-%d"),
                "start_min": suggestion.preferred_start_min,
                "minutes": suggestion.minutes or body.default_minutes,
                "category": suggestion.category.value if suggestion.category is not None else None,
            }
        )

    return {
        "source": body.text,
        "count": len(created),
        "created": created,
        "meeting_suggestions": meeting_suggestions,
    }


@app.post("/api/daily/confirm-meeting", status_code=201)
async def confirm_daily_meeting(
    body: DailyMeetingConfirmIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Create a meeting only after explicit user confirmation.

    The selected date/time is a hard placement window, so a meeting for
    tomorrow can never silently fall back to today.
    """
    day = _daily_date(body.date)
    minutes = max(SLOT_MINUTES, minutes_to_slots(body.minutes) * SLOT_MINUTES)
    start_min = (body.start_min // SLOT_MINUTES) * SLOT_MINUTES
    start = day.replace(
        hour=start_min // 60,
        minute=start_min % 60,
        second=0,
        microsecond=0,
    )
    end = start + timedelta(minutes=minutes)
    if end.date() != start.date():
        raise HTTPException(status_code=422, detail="meeting must end on the selected day")

    ident = uuid.uuid4().hex[:12]
    wire = IntentIn(
        title=body.title,
        kind=IntentKind.MEETING,
        priority=body.priority,
        category=body.category,
        minutes_per_period=minutes,
        period_days=None,
        min_chunk_minutes=minutes,
        max_chunk_minutes=minutes,
        max_per_day=1,
        earliest=start,
        latest=end,
        due=end,
        preferred_start_min=start_min,
        window_start_min=start_min,
        window_end_min=start_min + minutes,
    )
    intent = wire.to_domain(ident, origin(), await _preferred_workday(db))
    db.add(IntentRow(id=ident, payload=intent.model_dump(mode="json")))
    await db.commit()
    plan = await _replan(db)

    blocks = [block for block in plan.blocks if block.intent_id == ident]
    if not blocks:
        await db.delete(await db.get(IntentRow, ident))
        await db.commit()
        await _replan(db)
        raise HTTPException(
            status_code=409,
            detail="Ten termin jest zajęty lub niedostępny. Wybierz inną godzinę.",
        )

    return {
        "intent_id": ident,
        "title": body.title,
        "date": body.date,
        "start": start.isoformat(),
        "end": end.isoformat(),
    }


@app.post("/api/daily/{date}/items", status_code=201)
async def create_daily_item(date: str, body: DailyItemIn, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    day = _daily_date(date)
    item_id = uuid.uuid4().hex[:16]
    intent_id = body.intent_id
    linked_existing = intent_id is not None
    matrix_priority = Priority(body.quadrant)

    deadline_end = _deadline_end(body.deadline_date) if body.deadline_date else None
    if body.schedule_enabled and deadline_end is not None and deadline_end <= day:
        raise HTTPException(
            status_code=422,
            detail="Maksymalny deadline zadania musi przypadać w tym dniu lub później.",
        )

    if intent_id is not None:
        if await db.get(IntentRow, intent_id) is None:
            raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")
    elif body.schedule_enabled:
        intent_id = uuid.uuid4().hex[:12]
        wire = IntentIn(
            title=body.title,
            kind=IntentKind.TASK,
            priority=matrix_priority,
            category=body.category,
            minutes_per_period=body.minutes,
            min_chunk_minutes=min(30, body.minutes),
            max_chunk_minutes=body.minutes,
            max_per_day=1,
            earliest=day,
            due=deadline_end or (day + timedelta(days=1)),
            deadline_date=body.deadline_date,
        )
        intent = wire.to_domain(intent_id, origin(), await _preferred_workday(db))
        db.add(IntentRow(id=intent_id, payload=intent.model_dump(mode="json")))

    row = DailyPlanItemRow(
        id=item_id,
        plan_date=date,
        title=body.title,
        quadrant=body.quadrant,
        minutes=body.minutes,
        priority=int(matrix_priority),
        category=body.category.value if body.category is not None else None,
        intent_id=intent_id,
        schedule_enabled=body.schedule_enabled,
    )
    db.add(row)
    meta = None
    if body.deadline_date is not None:
        meta = DailyItemMetaRow(item_id=item_id, deadline_date=body.deadline_date)
        db.add(meta)
    await db.commit()

    # Linking a task that is already visible in Planner is classification only.
    # Do not solve again here: even a stable solver is allowed to move work when
    # the constraint set changes elsewhere, and merely adding a matrix label
    # must never send an already-planned task to another day.
    if intent_id and body.schedule_enabled and not linked_existing:
        await _replan(db)

    intent_payload = None
    if intent_id:
        intent_row = await db.get(IntentRow, intent_id)
        intent_payload = intent_row.payload if intent_row else None
    return _daily_item_dict(row, date, intent_payload, meta=meta)


@app.post("/api/daily/items/{item_id}/complete")
async def complete_daily_item(item_id: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    row = await db.get(DailyPlanItemRow, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="daily item not found")
    if row.completed_at is None:
        row.completed_at = datetime.now(UTC)
        await db.commit()
    if row.intent_id:
        intent_row = await db.get(IntentRow, row.intent_id)
        if intent_row:
            intent = Intent.model_validate(intent_row.payload)
            if intent.period_days is None and intent.completed_at is None:
                await complete_intent(row.intent_id, db, record_history=False)
    return _daily_item_dict(row, row.plan_date, None)


@app.post("/api/daily/items/{item_id}/cancel")
async def cancel_daily_item(item_id: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    """Remove an item from the matrix, never from the underlying task system.

    A Daily row is a planning lens over a task, not the task itself. Detaching
    it must therefore make a linked intent available to planning again rather
    than deleting it from Planner/Inbox.
    """
    row = await db.get(DailyPlanItemRow, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail="daily item not found")
    row.cancelled_at = datetime.now(UTC)
    await db.commit()
    return _daily_item_dict(row, row.plan_date, None)


@app.post("/api/daily/items/{item_id}/move")
async def move_daily_item(
    item_id: str,
    body: DailyMoveIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Move an item between Eisenhower quadrants and keep priority in sync."""
    target_day = _daily_date(body.date)
    row = await db.get(DailyPlanItemRow, item_id)
    if row is None or row.cancelled_at is not None:
        raise HTTPException(status_code=404, detail="daily item not found")

    row.quadrant = body.quadrant
    row.priority = body.quadrant

    meta = await db.get(DailyItemMetaRow, item_id)
    deadline_date = meta.deadline_date if meta is not None else None
    deadline_end = _deadline_end(deadline_date) if deadline_date else None
    if body.quadrant <= 2 and deadline_end is not None and deadline_end <= target_day:
        raise HTTPException(
            status_code=422,
            detail="Nie można zaplanować zadania po jego maksymalnym deadline.",
        )

    # If this was a note-only Q3/Q4 item and it becomes actionable (Q1/Q2),
    # promote it to a real Planner task. Existing linked tasks keep their
    # identity in every quadrant; moving the card never creates duplicates.
    if row.intent_id is None and body.quadrant <= 2:
        intent_id = uuid.uuid4().hex[:12]
        wire = IntentIn(
            title=row.title,
            kind=IntentKind.TASK,
            priority=Priority(body.quadrant),
            category=(
                WorkCategory(row.category)
                if row.category in {category.value for category in WorkCategory}
                else None
            ),
            minutes_per_period=row.minutes,
            min_chunk_minutes=min(30, row.minutes),
            max_chunk_minutes=row.minutes,
            max_per_day=1,
            earliest=target_day,
            due=deadline_end or (target_day + timedelta(days=1)),
            deadline_date=deadline_date,
        )
        intent = wire.to_domain(intent_id, origin(), await _preferred_workday(db))
        db.add(IntentRow(id=intent_id, payload=intent.model_dump(mode="json")))
        row.intent_id = intent_id
        row.schedule_enabled = True
    elif row.intent_id:
        intent_row = await db.get(IntentRow, row.intent_id)
        if intent_row is not None:
            intent = Intent.model_validate(intent_row.payload)
            intent = intent.model_copy(update={"priority": Priority(body.quadrant)})
            intent_row.payload = intent.model_dump(mode="json")
            if row.schedule_enabled:
                await _roll_daily_intent(row, body.date, db)

    await db.commit()
    if row.intent_id:
        await _replan(db)

    intent_payload = None
    if row.intent_id:
        intent_row = await db.get(IntentRow, row.intent_id)
        intent_payload = intent_row.payload if intent_row else None
    return _daily_item_dict(row, body.date, intent_payload, meta=meta)


@app.post("/api/daily/items/{item_id}/keep")
async def keep_daily_item(
    item_id: str,
    body: DailyDecisionIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    _daily_date(body.date)
    item = await db.get(DailyPlanItemRow, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="daily item not found")
    decision = await db.get(DailyItemDecisionRow, item_id)
    if decision is None:
        decision = DailyItemDecisionRow(item_id=item_id)
        db.add(decision)
    decision.acknowledged_date = body.date
    decision.defer_until = None
    decision.updated_at = datetime.now(UTC)
    await db.commit()
    return {"item_id": item_id, "date": body.date, "status": "kept"}


@app.post("/api/daily/items/{item_id}/defer")
async def defer_daily_item(
    item_id: str,
    body: DailyDeferIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    target = _daily_date(body.until)
    item = await db.get(DailyPlanItemRow, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="daily item not found")
    if target.date() <= origin().date():
        raise HTTPException(status_code=422, detail="defer date must be in the future")
    decision = await db.get(DailyItemDecisionRow, item_id)
    if decision is None:
        decision = DailyItemDecisionRow(item_id=item_id)
        db.add(decision)
    decision.defer_until = body.until
    decision.acknowledged_date = None
    decision.updated_at = datetime.now(UTC)
    await _roll_daily_intent(item, body.until, db)
    await db.commit()
    await _replan(db)
    return {"item_id": item_id, "until": body.until, "status": "deferred"}


@app.post("/api/daily/items/{item_id}/to-todo")
async def daily_item_to_todo(
    item_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    item = await db.get(DailyPlanItemRow, item_id)
    if item is None or item.cancelled_at is not None:
        raise HTTPException(status_code=404, detail="daily item not found")
    if item.completed_at is not None:
        raise HTTPException(
            status_code=422,
            detail="Wykonanego zadania nie przenosi się do Do zrobienia.",
        )

    meta = await db.get(DailyItemMetaRow, item_id)
    deadline_date = meta.deadline_date if meta is not None else None
    if deadline_date is None and item.intent_id:
        intent_row = await db.get(IntentRow, item.intent_id)
        if intent_row is not None:
            deadline_date = Intent.model_validate(intent_row.payload).deadline_date

    todo = TodoInboxRow(
        id=uuid.uuid4().hex[:16],
        title=item.title,
        minutes=item.minutes,
        category=item.category,
        deadline_date=deadline_date,
    )
    db.add(todo)
    cancelled_at = datetime.now(UTC)
    item.cancelled_at = cancelled_at

    if item.intent_id:
        linked_rows = (
            await db.execute(
                select(DailyPlanItemRow).where(
                    DailyPlanItemRow.intent_id == item.intent_id,
                    DailyPlanItemRow.completed_at.is_(None),
                    DailyPlanItemRow.cancelled_at.is_(None),
                )
            )
        ).scalars().all()
        for linked in linked_rows:
            linked.cancelled_at = cancelled_at

        intent_row = await db.get(IntentRow, item.intent_id)
        if intent_row is not None:
            intent = Intent.model_validate(intent_row.payload)
            if intent.period_days is None and intent.kind == IntentKind.TASK:
                await db.delete(intent_row)

    await db.commit()
    await _replan(db)
    return {
        "item_id": item_id,
        "todo_id": todo.id,
        "status": "moved_to_todo",
    }


@app.post("/api/daily/{date}/close")
async def close_daily(
    date: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    _daily_date(date)
    before = await _planning_snapshot(db)
    row = await db.get(DailyPlanRow, date)
    if row is None:
        row = DailyPlanRow(date=date)
        db.add(row)
    if row.closed_at is not None:
        return {"date": date, "closed_at": row.closed_at.isoformat(), "already_closed": True}

    row.closed_at = datetime.now(UTC)
    row.updated_at = datetime.now(UTC)
    await db.commit()
    after = await _planning_snapshot(db)

    active_items = (
        await db.execute(
            select(DailyPlanItemRow).where(
                DailyPlanItemRow.plan_date == date,
                DailyPlanItemRow.cancelled_at.is_(None),
            )
        )
    ).scalars().all()
    completed = sum(1 for item in active_items if item.completed_at is not None)
    change = await _save_change_set(
        db,
        source="daily",
        title=f"Zamknięcie dnia · {date}",
        summary=[{
            "action": "close_daily",
            "date": date,
            "items": len(active_items),
            "completed": completed,
        }],
        before=before,
        after=after,
    )
    return {
        "date": date,
        "closed_at": row.closed_at.isoformat(),
        "change_set_id": change.id,
        "already_closed": False,
    }


@app.put("/api/daily/{date}/review")
async def put_daily_review(date: str, body: DailyReviewIn, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    _daily_date(date)
    row = await db.get(DailyReviewRow, date)
    if row is None:
        row = DailyReviewRow(date=date)
        db.add(row)
    for field, value in body.model_dump().items():
        setattr(row, field, value)
    row.updated_at = datetime.now(UTC)

    # The last reflection becomes useful only if it changes tomorrow. Seed the
    # next day's "start here" field, but never overwrite a deliberate plan the
    # user has already written there.
    if body.first_step_morning.strip():
        tomorrow = (_daily_date(date) + timedelta(days=1)).strftime("%Y-%m-%d")
        next_plan = await db.get(DailyPlanRow, tomorrow)
        if next_plan is None:
            next_plan = DailyPlanRow(date=tomorrow, first_step=body.first_step_morning.strip())
            db.add(next_plan)
        elif not next_plan.first_step.strip():
            next_plan.first_step = body.first_step_morning.strip()
            next_plan.updated_at = datetime.now(UTC)

    await db.commit()
    return {"date": date, **body.model_dump()}


@app.get("/api/intents")
async def list_intents(db: AsyncSession = Depends(session)) -> list[dict[str, Any]]:
    rows = (await db.execute(select(IntentRow))).scalars().all()
    return [row.payload for row in rows]


@app.post("/api/intents", status_code=201)
async def create_intent(body: IntentIn, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    ident = uuid.uuid4().hex[:12]
    try:
        intent = body.to_domain(ident, origin(), await _preferred_workday(db))
    except ValueError as exc:
        # Domain validation is the real gate; surface its message rather than a
        # generic 500, because it explains exactly why the intent is impossible.
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if intent.kind == IntentKind.MEETING:
        cfg = settings()
        if cfg.zoom_account_id and cfg.zoom_client_id and cfg.zoom_client_secret:
            # Best-effort: a Zoom outage or bad credential must never stop a
            # meeting from being scheduled, only leave it without a link.
            try:
                meeting = await create_meeting(cfg, intent.title)
                intent = intent.model_copy(
                    update={"zoom_meeting_id": meeting.id, "zoom_join_url": meeting.join_url}
                )
            except ZoomError as exc:
                logger.warning("Zoom meeting creation failed for %r: %s", intent.title, exc)

    db.add(IntentRow(id=ident, payload=intent.model_dump(mode="json")))
    await db.commit()
    await _replan(db)
    return intent.model_dump(mode="json")


def _iso_or_none(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _dt_or_none(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


async def _planning_snapshot(db: AsyncSession) -> dict[str, Any]:
    """Capture mutable user planning state for reversible change sets."""

    intents = (await db.execute(select(IntentRow))).scalars().all()
    daily_plans = (await db.execute(select(DailyPlanRow))).scalars().all()
    daily_items = (await db.execute(select(DailyPlanItemRow))).scalars().all()
    daily_meta = (await db.execute(select(DailyItemMetaRow))).scalars().all()
    daily_decisions = (await db.execute(select(DailyItemDecisionRow))).scalars().all()
    daily_reviews = (await db.execute(select(DailyReviewRow))).scalars().all()
    todos = (await db.execute(select(TodoInboxRow))).scalars().all()

    return {
        "intents": [
            {
                "id": row.id,
                "payload": row.payload,
                "created_at": row.created_at.isoformat(),
            }
            for row in intents
        ],
        "daily_plans": [
            {
                "date": row.date,
                "win_condition": row.win_condition,
                "first_step": row.first_step,
                "closed_at": _iso_or_none(row.closed_at),
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
            }
            for row in daily_plans
        ],
        "daily_items": [
            {
                "id": row.id,
                "plan_date": row.plan_date,
                "title": row.title,
                "quadrant": row.quadrant,
                "minutes": row.minutes,
                "priority": row.priority,
                "category": row.category,
                "intent_id": row.intent_id,
                "schedule_enabled": row.schedule_enabled,
                "completed_at": _iso_or_none(row.completed_at),
                "cancelled_at": _iso_or_none(row.cancelled_at),
                "created_at": row.created_at.isoformat(),
            }
            for row in daily_items
        ],
        "daily_meta": [
            {
                "item_id": row.item_id,
                "deadline_date": row.deadline_date,
            }
            for row in daily_meta
        ],
        "daily_decisions": [
            {
                "item_id": row.item_id,
                "defer_until": row.defer_until,
                "acknowledged_date": row.acknowledged_date,
                "updated_at": row.updated_at.isoformat(),
            }
            for row in daily_decisions
        ],
        "daily_reviews": [
            {
                "date": row.date,
                "did_well": row.did_well,
                "grateful_for": row.grateful_for,
                "would_change": row.would_change,
                "learned": row.learned,
                "improve_tomorrow": row.improve_tomorrow,
                "first_step_morning": row.first_step_morning,
                "updated_at": row.updated_at.isoformat(),
            }
            for row in daily_reviews
        ],
        "todos": [
            {
                "id": row.id,
                "title": row.title,
                "minutes": row.minutes,
                "category": row.category,
                "deadline_date": row.deadline_date,
                "assigned_at": _iso_or_none(row.assigned_at),
                "created_at": row.created_at.isoformat(),
                "updated_at": row.updated_at.isoformat(),
            }
            for row in todos
        ],
    }


async def _restore_planning_snapshot(
    db: AsyncSession,
    snapshot: dict[str, Any],
) -> None:
    """Restore planning state captured by _planning_snapshot."""

    # Dependent rows first; intents last.
    await db.execute(delete(DailyItemMetaRow))
    await db.execute(delete(DailyItemDecisionRow))
    await db.execute(delete(DailyPlanItemRow))
    await db.execute(delete(DailyReviewRow))
    await db.execute(delete(DailyPlanRow))
    await db.execute(delete(TodoInboxRow))
    await db.execute(delete(IntentRow))

    for item in snapshot.get("intents", []):
        db.add(
            IntentRow(
                id=item["id"],
                payload=item["payload"],
                created_at=datetime.fromisoformat(item["created_at"]),
            )
        )
    for item in snapshot.get("daily_plans", []):
        db.add(
            DailyPlanRow(
                date=item["date"],
                win_condition=item.get("win_condition", ""),
                first_step=item.get("first_step", ""),
                closed_at=_dt_or_none(item.get("closed_at")),
                created_at=datetime.fromisoformat(item["created_at"]),
                updated_at=datetime.fromisoformat(item["updated_at"]),
            )
        )
    for item in snapshot.get("daily_items", []):
        db.add(
            DailyPlanItemRow(
                id=item["id"],
                plan_date=item["plan_date"],
                title=item["title"],
                quadrant=item["quadrant"],
                minutes=item["minutes"],
                priority=item["priority"],
                category=item.get("category"),
                intent_id=item.get("intent_id"),
                schedule_enabled=item["schedule_enabled"],
                completed_at=_dt_or_none(item.get("completed_at")),
                cancelled_at=_dt_or_none(item.get("cancelled_at")),
                created_at=datetime.fromisoformat(item["created_at"]),
            )
        )
    for item in snapshot.get("daily_meta", []):
        db.add(
            DailyItemMetaRow(
                item_id=item["item_id"],
                deadline_date=item.get("deadline_date"),
            )
        )
    for item in snapshot.get("daily_decisions", []):
        db.add(
            DailyItemDecisionRow(
                item_id=item["item_id"],
                defer_until=item.get("defer_until"),
                acknowledged_date=item.get("acknowledged_date"),
                updated_at=datetime.fromisoformat(item["updated_at"]),
            )
        )
    for item in snapshot.get("daily_reviews", []):
        db.add(
            DailyReviewRow(
                date=item["date"],
                did_well=item.get("did_well", ""),
                grateful_for=item.get("grateful_for", ""),
                would_change=item.get("would_change", ""),
                learned=item.get("learned", ""),
                improve_tomorrow=item.get("improve_tomorrow", ""),
                first_step_morning=item.get("first_step_morning", ""),
                updated_at=datetime.fromisoformat(item["updated_at"]),
            )
        )
    for item in snapshot.get("todos", []):
        db.add(
            TodoInboxRow(
                id=item["id"],
                title=item["title"],
                minutes=item["minutes"],
                category=item.get("category"),
                deadline_date=item.get("deadline_date"),
                assigned_at=_dt_or_none(item.get("assigned_at")),
                created_at=datetime.fromisoformat(item["created_at"]),
                updated_at=datetime.fromisoformat(item["updated_at"]),
            )
        )

    await db.commit()
    await _replan(db)


async def _save_change_set(
    db: AsyncSession,
    *,
    source: str,
    title: str,
    summary: list[dict[str, Any]],
    before: dict[str, Any],
    after: dict[str, Any],
) -> ChangeSetRow:
    row = ChangeSetRow(
        id=uuid.uuid4().hex[:16],
        source=source,
        title=title,
        summary=summary,
        before_state=before,
        after_state=after,
    )
    db.add(row)
    await db.commit()
    return row


class AssistantChatIn(BaseModel):
    messages: list[AssistantMessage] = Field(min_length=1, max_length=20)
    pending_actions: list[AssistantAction] = Field(default_factory=list, max_length=8)
    context_page: str | None = Field(default=None, max_length=100)


async def _assistant_context(
    db: AsyncSession,
    context_page: str | None,
    messages: list[AssistantMessage] | None = None,
) -> dict[str, Any]:
    rendered = await get_plan(db)
    rows = (await db.execute(select(IntentRow))).scalars().all()
    base = origin()

    scheduled: dict[str, list[dict[str, Any]]] = {}
    for block in rendered.blocks:
        scheduled.setdefault(block.intent_id, []).append({
            "start": block.start.isoformat(),
            "end": block.end.isoformat(),
            "completed": block.completed,
        })

    active: list[dict[str, Any]] = []
    for row in rows:
        intent = Intent.model_validate(row.payload)
        if intent.completed_at is not None:
            continue
        active.append({
            "id": intent.id,
            "title": intent.title,
            "kind": intent.kind.value,
            "priority": int(intent.priority),
            "category": intent.category.value if intent.category is not None else None,
            "minutes": intent.minutes_per_period,
            "scheduled": scheduled.get(intent.id, []),
        })

    active_by_id = {item["id"]: item for item in active}
    explicit_references: list[dict[str, Any]] = []
    for message in messages or []:
        for reference in message.references:
            if reference.kind == "intent":
                item = active_by_id.get(reference.intent_id or "")
                explicit_references.append(
                    {
                        "token": reference.token,
                        "kind": "intent",
                        "intent_id": reference.intent_id,
                        "resolved": item is not None,
                        "item": item,
                    }
                )
            else:
                explicit_references.append(
                    {
                        "token": reference.token,
                        "kind": "category",
                        "category": (
                            reference.category.value
                            if reference.category is not None
                            else None
                        ),
                        "resolved": reference.category is not None,
                    }
                )

    workday_start_min, workday_end_min = await _preferred_workday(db)
    return {
        "page": context_page,
        "today": base.date().isoformat(),
        "workday_start_min": workday_start_min,
        "workday_end_min": workday_end_min,
        "active_items": active[:80],
        "explicit_references": explicit_references[-24:],
        "unmet": [
            {
                "intent_id": item.intent_id,
                "title": item.title,
                "shortfall_minutes": item.shortfall_minutes,
            }
            for item in rendered.unmet
        ],
    }


def _round_up_slot_minute(value: int) -> int:
    return ((value + SLOT_MINUTES - 1) // SLOT_MINUTES) * SLOT_MINUTES


async def _find_available_slots(
    db: AsyncSession,
    action: AssistantAction,
) -> list[dict[str, Any]]:
    if not action.date or not action.minutes:
        return []

    rendered = await get_plan(db)
    preferred_start, preferred_end = await _preferred_workday(db)
    duration = max(SLOT_MINUTES, minutes_to_slots(action.minutes) * SLOT_MINUTES)
    search_days = action.search_days or 1
    wanted = action.count or 3
    base_day = _daily_date(action.date)
    now = datetime.now(settings().zone)
    occupied: list[tuple[datetime, datetime]] = []
    for block in rendered.blocks:
        if not block.completed:
            occupied.append((block.start, block.end))
    for busy in rendered.busy:
        occupied.append((busy.start, busy.end))
    found: list[dict[str, Any]] = []
    for offset in range(search_days):
        day = base_day + timedelta(days=offset)
        start_min = (
            action.window_start_min
            if action.window_start_min is not None
            else preferred_start
        )
        end_min = (
            action.window_end_min
            if action.window_end_min is not None
            else preferred_end
        )
        day_start = day.replace(
            hour=start_min // 60,
            minute=start_min % 60,
            second=0,
            microsecond=0,
        )
        if end_min >= 24 * 60:
            day_end = (
                day.replace(hour=0, minute=0, second=0, microsecond=0)
                + timedelta(days=1)
            )
        else:
            day_end = day.replace(
                hour=end_min // 60,
                minute=end_min % 60,
                second=0,
                microsecond=0,
            )
        if day.date() == now.date() and day_start < now:
            rounded = _round_up_slot_minute(now.hour * 60 + now.minute)
            if rounded >= 24 * 60:
                continue
            day_start = day.replace(
                hour=rounded // 60,
                minute=rounded % 60,
                second=0,
                microsecond=0,
            )
        if day_end <= day_start:
            continue
        intervals = sorted(
            (max(start, day_start), min(end, day_end))
            for start, end in occupied
            if end > day_start and start < day_end
        )
        merged: list[tuple[datetime, datetime]] = []
        for start, end in intervals:
            if not merged or start > merged[-1][1]:
                merged.append((start, end))
            else:
                old_start, old_end = merged[-1]
                merged[-1] = (old_start, max(old_end, end))
        cursor = day_start
        gaps: list[tuple[datetime, datetime]] = []
        for start, end in merged:
            if start > cursor:
                gaps.append((cursor, start))
            cursor = max(cursor, end)
        if cursor < day_end:
            gaps.append((cursor, day_end))
        for gap_start, gap_end in gaps:
            rounded_min = _round_up_slot_minute(gap_start.hour * 60 + gap_start.minute)
            candidate = gap_start.replace(
                hour=rounded_min // 60,
                minute=rounded_min % 60,
                second=0,
                microsecond=0,
            )
            while candidate + timedelta(minutes=duration) <= gap_end:
                found.append({
                    "date": candidate.date().isoformat(),
                    "start": candidate.isoformat(),
                    "end": (candidate + timedelta(minutes=duration)).isoformat(),
                    "minutes": duration,
                })
                if len(found) >= wanted:
                    return found
                candidate += timedelta(minutes=max(duration, SLOT_MINUTES))
    return found


def _format_available_slots(action: AssistantAction, slots: list[dict[str, Any]]) -> str:
    label = action.title or f"{action.minutes} min"
    if not slots:
        return f"Nie znalazłem wolnego miejsca na „{label}” w podanym zakresie."
    lines = [f"Wolne miejsca na „{label}”:"]
    for index, slot in enumerate(slots, start=1):
        start = datetime.fromisoformat(slot["start"])
        end = datetime.fromisoformat(slot["end"])
        lines.append(
            f"{index}. {start.strftime('%Y-%m-%d')} "
            f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')} "
            "— bez przesuwania obecnego planu"
        )
    return "\n".join(lines)


@app.post("/api/assistant/chat")
async def assistant_chat(
    body: AssistantChatIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    try:
        decision = await converse(
            body.messages,
            await _assistant_context(db, body.context_page, body.messages),
            pending_actions=body.pending_actions,
        )
    except ExtractionFailed as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ProviderError, httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=f"language model unreachable: {exc}") from exc
    find_actions = [action for action in decision.actions if action.action == "find_time"]
    if find_actions:
        sections: list[str] = []
        for action in find_actions:
            sections.append(
                _format_available_slots(action, await _find_available_slots(db, action))
            )
        decision = decision.model_copy(
            update={
                "reply": decision.reply.rstrip() + "\n\n" + "\n\n".join(sections),
                "actions": [
                    action for action in decision.actions if action.action != "find_time"
                ],
            }
        )

    return decision.model_dump(mode="json")




class AssistantExecuteIn(BaseModel):
    actions: list[AssistantAction] = Field(min_length=1, max_length=8)


async def _execute_assistant_action(
    action: AssistantAction,
    db: AsyncSession,
) -> dict[str, Any]:
    if action.action == "create_task":
        if not action.title or not action.date or not action.minutes or not action.quadrant:
            raise HTTPException(status_code=422, detail="create_task proposal is incomplete")

        # A strict clock request must be honored exactly or rejected. Do not
        # create a flexible Daily task and let the solver silently move it.
        if action.start_min is not None and action.start_mode == "fixed":
            day = _daily_date(action.date)
            minutes = max(SLOT_MINUTES, minutes_to_slots(action.minutes) * SLOT_MINUTES)
            start_min = (action.start_min // SLOT_MINUTES) * SLOT_MINUTES
            start = day.replace(
                hour=start_min // 60,
                minute=start_min % 60,
                second=0,
                microsecond=0,
            )
            end = start + timedelta(minutes=minutes)
            if end.date() != start.date():
                raise HTTPException(
                    status_code=422,
                    detail="To zadanie nie mieści się w wybranym dniu.",
                )

            ident = uuid.uuid4().hex[:12]
            wire = IntentIn(
                title=action.title,
                kind=IntentKind.TASK,
                priority=Priority(action.quadrant),
                category=action.category,
                minutes_per_period=minutes,
                min_chunk_minutes=minutes,
                max_chunk_minutes=minutes,
                max_per_day=1,
                earliest=start,
                latest=end,
                due=end,
                preferred_start_min=start_min,
                window_start_min=start_min,
                window_end_min=start_min + minutes,
            )
            intent = wire.to_domain(ident, origin(), await _preferred_workday(db))
            db.add(IntentRow(id=ident, payload=intent.model_dump(mode="json")))
            await db.commit()
            plan = await _replan(db)

            blocks = [block for block in plan.blocks if block.intent_id == ident]
            expected_start_slot = to_slot(start, origin())
            expected_end_slot = to_slot(end, origin())
            exact = bool(blocks) and all(
                block.start_slot == expected_start_slot
                and block.end_slot == expected_end_slot
                for block in blocks
            )
            if not exact:
                row = await db.get(IntentRow, ident)
                if row is not None:
                    await db.delete(row)
                    await db.commit()
                    await _replan(db)
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Nie mogę zaplanować „{action.title}” dokładnie "
                        f"{action.date} o {start.strftime('%H:%M')} na {minutes} min."
                    ),
                )

            daily_row = DailyPlanItemRow(
                id=uuid.uuid4().hex[:16],
                plan_date=action.date,
                title=action.title,
                quadrant=action.quadrant,
                minutes=minutes,
                priority=action.quadrant,
                intent_id=ident,
                schedule_enabled=True,
            )
            db.add(daily_row)
            await db.commit()
            return {
                "action": action.action,
                "status": "done",
                "title": action.title,
                "date": action.date,
                "item_id": daily_row.id,
                "intent_id": ident,
            }

        item = await create_daily_item(
            action.date,
            DailyItemIn(
                title=action.title,
                quadrant=action.quadrant,
                minutes=action.minutes,
                category=action.category,
                schedule_enabled=action.quadrant <= 2,
            ),
            db,
        )

        # A preferred time is a hint, not a promise. Category is descriptive
        # metadata only. Preserve either on the linked intent without changing
        # scheduling priority.
        if item.get("intent_id") and (
            (action.start_min is not None and action.start_mode == "preferred")
            or action.category is not None
        ):
            intent_row = await db.get(IntentRow, item["intent_id"])
            if intent_row is not None:
                intent = Intent.model_validate(intent_row.payload)
                updates: dict[str, Any] = {}
                if action.start_min is not None and action.start_mode == "preferred":
                    updates["preferred_start_min"] = action.start_min
                if action.category is not None:
                    updates["category"] = action.category
                intent_row.payload = intent.model_copy(update=updates).model_dump(mode="json")
                await db.commit()
                await _replan(db)

        return {
            "action": action.action,
            "status": "done",
            "title": action.title,
            "date": action.date,
            "item_id": item["id"],
            "intent_id": item.get("intent_id"),
        }

    if action.action == "create_break":
        if not action.date or action.start_min is None or not action.minutes:
            raise HTTPException(status_code=422, detail="create_break proposal is incomplete")
        day = _daily_date(action.date)
        minutes = max(SLOT_MINUTES, minutes_to_slots(action.minutes) * SLOT_MINUTES)
        start_min = (action.start_min // SLOT_MINUTES) * SLOT_MINUTES
        start = day.replace(
            hour=start_min // 60,
            minute=start_min % 60,
            second=0,
            microsecond=0,
        )
        end = start + timedelta(minutes=minutes)
        if end.date() != start.date():
            raise HTTPException(status_code=422, detail="Przerwa nie mieści się w wybranym dniu.")

        ident = uuid.uuid4().hex[:12]
        title = action.title or "Przerwa"
        wire = IntentIn(
            title=title,
            kind=IntentKind.BUFFER,
            priority=Priority.P1,
            category=action.category,
            minutes_per_period=minutes,
            min_chunk_minutes=minutes,
            max_chunk_minutes=minutes,
            max_per_day=1,
            earliest=start,
            latest=end,
            due=end,
            preferred_start_min=start_min,
            window_start_min=start_min,
            window_end_min=start_min + minutes,
        )
        intent = wire.to_domain(ident, origin(), await _preferred_workday(db))
        db.add(IntentRow(id=ident, payload=intent.model_dump(mode="json")))
        await db.commit()
        plan = await _replan(db)
        blocks = [b for b in plan.blocks if b.intent_id == ident]
        expected_start_slot = to_slot(start, origin())
        expected_end_slot = to_slot(end, origin())
        exact = bool(blocks) and all(
            b.start_slot == expected_start_slot
            and b.end_slot == expected_end_slot
            for b in blocks
        )
        if not exact:
            row = await db.get(IntentRow, ident)
            if row is not None:
                await db.delete(row)
                await db.commit()
                await _replan(db)
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Nie mogę dodać przerwy dokładnie {action.date} "
                    f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')}."
                ),
            )
        return {
            "action": action.action,
            "status": "done",
            "title": title,
            "date": action.date,
            "intent_id": ident,
        }

    if action.action == "create_meeting":
        if not action.title or not action.date or action.start_min is None or not action.minutes:
            raise HTTPException(status_code=422, detail="create_meeting proposal is incomplete")
        meeting = await confirm_daily_meeting(
            DailyMeetingConfirmIn(
                title=action.title,
                date=action.date,
                start_min=action.start_min,
                minutes=action.minutes,
                priority=Priority.P2,
                category=action.category,
            ),
            db,
        )
        return {"action": action.action, "status": "done", **meeting}

    if action.action == "complete_task":
        if not action.intent_id:
            raise HTTPException(status_code=422, detail="complete_task needs intent_id")
        row = await db.get(IntentRow, action.intent_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no intent {action.intent_id!r}")
        current_intent = Intent.model_validate(row.payload)
        if current_intent.kind != IntentKind.TASK or current_intent.period_days is not None:
            raise HTTPException(status_code=422, detail="only one-shot tasks can be completed here")
        completed = await complete_intent(action.intent_id, db, record_history=False)
        return {
            "action": action.action,
            "status": "done",
            "intent_id": action.intent_id,
            "title": completed["title"],
        }

    if action.action == "swap_tasks":
        if not action.intent_id or not action.second_intent_id:
            raise HTTPException(status_code=422, detail="swap_tasks needs two intent ids")
        if action.intent_id == action.second_intent_id:
            raise HTTPException(status_code=422, detail="swap_tasks needs two different tasks")

        first_row = await db.get(IntentRow, action.intent_id)
        second_row = await db.get(IntentRow, action.second_intent_id)
        if first_row is None or second_row is None:
            raise HTTPException(status_code=404, detail="one of the tasks no longer exists")

        first = Intent.model_validate(first_row.payload)
        second = Intent.model_validate(second_row.payload)
        for candidate in (first, second):
            if (
                candidate.kind != IntentKind.TASK
                or candidate.period_days is not None
                or candidate.completed_at is not None
            ):
                raise HTTPException(
                    status_code=422,
                    detail="Only active one-shot tasks can be swapped.",
                )

        current_plan = await load_previous_plan(db) or await _replan(db)
        first_blocks = [
            block for block in current_plan.blocks if block.intent_id == first.id
        ]
        second_blocks = [
            block for block in current_plan.blocks if block.intent_id == second.id
        ]
        if len(first_blocks) != 1 or len(second_blocks) != 1:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Mogę zamienić miejscami tylko dwa zadania, z których każde "
                    "ma jeden aktualnie zaplanowany blok."
                ),
            )

        base = origin()
        zone = settings().zone
        first_current_start = from_slot(first_blocks[0].start_slot, base).astimezone(zone)
        second_current_start = from_slot(second_blocks[0].start_slot, base).astimezone(zone)

        first_target_start = second_current_start
        second_target_start = first_current_start
        first_target_end = first_target_start + timedelta(minutes=first.minutes_per_period)
        second_target_end = second_target_start + timedelta(minutes=second.minutes_per_period)

        if (
            first_target_end.date() != first_target_start.date()
            or second_target_end.date() != second_target_start.date()
        ):
            raise HTTPException(
                status_code=409,
                detail="Po zamianie jedno z zadań wychodziłoby poza wybrany dzień.",
            )

        first_original = dict(first_row.payload)
        second_original = dict(second_row.payload)

        def pinned_task(intent: Intent, start: datetime, end: datetime) -> Intent:
            start_min = start.hour * 60 + start.minute
            return intent.model_copy(
                update={
                    "earliest_slot": to_slot(start, base),
                    "latest_slot": to_slot(end, base),
                    "due_slot": to_slot(end, base),
                    "preferred_start_min": start_min,
                    "daily_windows": [
                        DailyWindow(
                            start_min=start_min,
                            end_min=start_min + intent.minutes_per_period,
                        )
                    ],
                    "allowed_weekdays": [],
                }
            )

        first_row.payload = pinned_task(
            first, first_target_start, first_target_end
        ).model_dump(mode="json")
        second_row.payload = pinned_task(
            second, second_target_start, second_target_end
        ).model_dump(mode="json")
        await db.commit()

        try:
            swapped_plan = await _replan(db)
        except Exception:
            first_row.payload = first_original
            second_row.payload = second_original
            await db.commit()
            await _replan(db)
            raise

        first_after = [
            block for block in swapped_plan.blocks if block.intent_id == first.id
        ]
        second_after = [
            block for block in swapped_plan.blocks if block.intent_id == second.id
        ]

        first_expected = (
            to_slot(first_target_start, base),
            to_slot(first_target_end, base),
        )
        second_expected = (
            to_slot(second_target_start, base),
            to_slot(second_target_end, base),
        )
        exact = (
            len(first_after) == 1
            and len(second_after) == 1
            and (first_after[0].start_slot, first_after[0].end_slot) == first_expected
            and (second_after[0].start_slot, second_after[0].end_slot) == second_expected
        )
        if not exact:
            first_row.payload = first_original
            second_row.payload = second_original
            await db.commit()
            await _replan(db)
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Nie mogę bezpiecznie zamienić miejscami „{first.title}” "
                    f"oraz „{second.title}” bez naruszenia pozostałego planu."
                ),
            )

        target_dates = {
            first.id: first_target_start.date().isoformat(),
            second.id: second_target_start.date().isoformat(),
        }
        linked_daily = (
            await db.execute(
                select(DailyPlanItemRow).where(
                    DailyPlanItemRow.intent_id.in_([first.id, second.id]),
                    DailyPlanItemRow.completed_at.is_(None),
                    DailyPlanItemRow.cancelled_at.is_(None),
                )
            )
        ).scalars().all()
        for daily_row in linked_daily:
            if daily_row.intent_id in target_dates:
                daily_row.plan_date = target_dates[daily_row.intent_id]
        if linked_daily:
            await db.commit()

        return {
            "action": action.action,
            "status": "done",
            "title": first.title,
            "other_title": second.title,
            "intent_id": first.id,
            "second_intent_id": second.id,
            "scheduled": [
                {
                    "title": first.title,
                    "start": from_slot(first_after[0].start_slot, base).isoformat(),
                    "end": from_slot(first_after[0].end_slot, base).isoformat(),
                },
                {
                    "title": second.title,
                    "start": from_slot(second_after[0].start_slot, base).isoformat(),
                    "end": from_slot(second_after[0].end_slot, base).isoformat(),
                },
            ],
        }

    if action.action in ("reschedule_task", "reschedule_break", "reschedule_meeting"):
        if not action.intent_id:
            raise HTTPException(status_code=422, detail=f"{action.action} needs intent_id")

        row = await db.get(IntentRow, action.intent_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no intent {action.intent_id!r}")

        intent = Intent.model_validate(row.payload)
        expected_kind = {
            "reschedule_task": IntentKind.TASK,
            "reschedule_break": IntentKind.BUFFER,
            "reschedule_meeting": IntentKind.MEETING,
        }[action.action]
        if (
            intent.period_days is not None
            or intent.kind != expected_kind
            or intent.completed_at is not None
        ):
            label = {
                IntentKind.BUFFER: "break",
                IntentKind.MEETING: "meeting",
            }.get(expected_kind, "task")
            raise HTTPException(
                status_code=422,
                detail=f"only an active one-shot {label} can be rescheduled here",
            )

        current_plan = await load_previous_plan(db) or await _replan(db)
        current_blocks = [
            block for block in current_plan.blocks if block.intent_id == intent.id
        ]
        if len(current_blocks) != 1:
            label = {
                IntentKind.BUFFER: "przerwę",
                IntentKind.MEETING: "spotkanie",
            }.get(expected_kind, "zadanie")
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Mogę edytować godzinę lub długość tylko elementu „{label}”, "
                    "który ma jeden aktualnie zaplanowany blok."
                ),
            )

        base = origin()
        zone = settings().zone
        current_start = from_slot(current_blocks[0].start_slot, base).astimezone(zone)

        target_day = (
            _daily_date(action.date)
            if action.date is not None
            else current_start.replace(hour=0, minute=0, second=0, microsecond=0)
        )
        start_min = (
            action.start_min
            if action.start_min is not None
            else current_start.hour * 60 + current_start.minute
        )
        duration_minutes = (
            max(SLOT_MINUTES, minutes_to_slots(action.minutes) * SLOT_MINUTES)
            if action.minutes is not None
            else intent.minutes_per_period
        )

        start = target_day.replace(
            hour=start_min // 60,
            minute=start_min % 60,
            second=0,
            microsecond=0,
        )
        end = start + timedelta(minutes=duration_minutes)

        # Breaks are protected appointments, so even a date-only break move is
        # exact. Tasks retain the older flexible date-only semantics.
        exact = (
            action.action in ("reschedule_break", "reschedule_meeting")
            or action.start_min is not None
            or action.minutes is not None
        )

        moved = await move_intent(
            action.intent_id,
            MoveIntentIn(
                start=start,
                end=end,
                exact=exact,
            ),
            db,
            record_history=False,
        )
        return {
            "action": action.action,
            "status": "done",
            "title": intent.title,
            **moved,
        }

    if action.action == "update_daily_plan":
        if not action.date or (action.win_condition is None and action.first_step is None):
            raise HTTPException(status_code=422, detail="update_daily_plan proposal is incomplete")
        current = await db.get(DailyPlanRow, action.date)
        saved = await put_daily(
            action.date,
            DailyPlanIn(
                win_condition=(
                    action.win_condition
                    if action.win_condition is not None
                    else (current.win_condition if current else "")
                ),
                first_step=(
                    action.first_step
                    if action.first_step is not None
                    else (current.first_step if current else "")
                ),
            ),
            db,
        )
        return {"action": action.action, "status": "done", **saved}

    raise HTTPException(status_code=422, detail=f"unsupported assistant action {action.action!r}")


async def _order_atomic_assistant_actions(
    actions: list[AssistantAction],
    db: AsyncSession,
) -> list[AssistantAction]:
    """Order dependent moves before creates to avoid transient collisions."""

    completes = [action for action in actions if action.action == "complete_task"]
    swaps = [action for action in actions if action.action == "swap_tasks"]
    moves = [
        action
        for action in actions
        if action.action in ("reschedule_task", "reschedule_break", "reschedule_meeting")
    ]
    creates = [
        action
        for action in actions
        if action.action in ("create_task", "create_break", "create_meeting")
    ]
    daily = [action for action in actions if action.action == "update_daily_plan"]
    known = {id(action) for action in [*completes, *swaps, *moves, *creates, *daily]}
    other = [action for action in actions if id(action) not in known]

    if len(moves) <= 1:
        return [*completes, *swaps, *moves, *creates, *daily, *other]

    plan = await get_plan(db)
    current: dict[str, tuple[datetime, datetime]] = {}
    for block in sorted(plan.blocks, key=lambda item: item.start):
        current.setdefault(block.intent_id, (block.start, block.end))

    targets: dict[int, tuple[datetime, datetime] | None] = {}
    for index, action in enumerate(moves):
        if not action.intent_id or action.intent_id not in current:
            targets[index] = None
            continue
        old_start, old_end = current[action.intent_id]
        target_date = (
            _daily_date(action.date)
            if action.date
            else old_start.astimezone(settings().zone).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
        )
        start_min = (
            action.start_min
            if action.start_min is not None
            else old_start.astimezone(settings().zone).hour * 60
            + old_start.astimezone(settings().zone).minute
        )
        duration = (
            action.minutes
            if action.minutes is not None
            else max(SLOT_MINUTES, int((old_end - old_start).total_seconds() // 60))
        )
        target_start = target_date.replace(
            hour=start_min // 60,
            minute=start_min % 60,
            second=0,
            microsecond=0,
        )
        targets[index] = (target_start, target_start + timedelta(minutes=duration))

    dependencies: dict[int, set[int]] = {index: set() for index in range(len(moves))}
    for index, action in enumerate(moves):
        target = targets[index]
        if target is None:
            continue
        target_start, target_end = target
        for other_index, other_action in enumerate(moves):
            if index == other_index or not other_action.intent_id:
                continue
            occupied = current.get(other_action.intent_id)
            if occupied is None:
                continue
            occupied_start, occupied_end = occupied
            if target_start < occupied_end and target_end > occupied_start:
                dependencies[index].add(other_index)

    ordered_indices: list[int] = []
    remaining = set(range(len(moves)))
    while remaining:
        ready = [
            index
            for index in remaining
            if not (dependencies[index] & remaining)
        ]
        if not ready:
            # A true cycle is a swap/rotation and should be expressed with
            # swap_tasks. Preserve model order so validation can reject it
            # without silently inventing a different operation.
            ordered_indices.extend(sorted(remaining))
            break
        def _target_sort_key(index: int) -> datetime:
            target = targets.get(index)
            return target[0] if target is not None else origin()

        ready.sort(key=_target_sort_key, reverse=True)
        for index in ready:
            ordered_indices.append(index)
            remaining.remove(index)

    ordered_moves = [moves[index] for index in ordered_indices]
    return [*completes, *swaps, *ordered_moves, *creates, *daily, *other]

@app.post("/api/assistant/execute")
async def assistant_execute(
    body: AssistantExecuteIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Execute one assistant proposal as a reversible all-or-nothing batch."""

    before = await _planning_snapshot(db)
    results: list[dict[str, Any]] = []

    try:
        ordered_actions = await _order_atomic_assistant_actions(body.actions, db)
        for action in ordered_actions:
            result = await _execute_assistant_action(action, db)
            if result.get("status") == "failed":
                raise HTTPException(
                    status_code=409,
                    detail=result.get("detail") or "Nie udało się wykonać jednej ze zmian.",
                )
            results.append(result)
    except Exception as exc:
        await _restore_planning_snapshot(db, before)
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        status = exc.status_code if isinstance(exc, HTTPException) else 409
        raise HTTPException(
            status_code=status,
            detail=(
                "Nie wykonano żadnej zmiany z tego pakietu. "
                f"Horolog przywrócił poprzedni plan. Powód: {detail}"
            ),
        ) from exc

    # Report what actually landed in the authoritative plan, not merely what
    # the proposal requested. This makes the assistant's confirmation factual.
    rendered = await get_plan(db)
    for result in results:
        if result.get("scheduled"):
            continue
        intent_id = result.get("intent_id")
        if not intent_id:
            continue
        blocks = [
            {
                "start": block.start.isoformat(),
                "end": block.end.isoformat(),
            }
            for block in rendered.blocks
            if block.intent_id == intent_id
        ]
        if blocks:
            result["scheduled"] = blocks

    after = await _planning_snapshot(db)
    change = await _save_change_set(
        db,
        source="assistant",
        title=(
            f"Pakiet asystenta · {len(results)} "
            + ("zmiana" if len(results) == 1 else "zmian")
        ),
        summary=results,
        before=before,
        after=after,
    )

    return {
        "count": len(results),
        "success_count": len(results),
        "atomic": True,
        "change_set_id": change.id,
        "results": results,
    }




def _utc_aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _time_entry_elapsed(row: TimeEntryRow, now: datetime | None = None) -> int:
    elapsed = row.accumulated_seconds
    if row.status == "running" and row.last_resumed_at is not None:
        current = _utc_aware(now or datetime.now(UTC))
        resumed = _utc_aware(row.last_resumed_at)
        elapsed += max(0, int((current - resumed).total_seconds()))
    return elapsed


async def _time_entry_dict(
    db: AsyncSession,
    row: TimeEntryRow,
) -> dict[str, Any]:
    intent_row = await db.get(IntentRow, row.intent_id)
    title = (
        Intent.model_validate(intent_row.payload).title
        if intent_row is not None
        else "Usunięte zadanie"
    )
    return {
        "id": row.id,
        "intent_id": row.intent_id,
        "title": title,
        "status": row.status,
        "started_at": row.started_at.isoformat(),
        "last_resumed_at": _iso_or_none(row.last_resumed_at),
        "accumulated_seconds": row.accumulated_seconds,
        "elapsed_seconds": _time_entry_elapsed(row),
        "ended_at": _iso_or_none(row.ended_at),
    }


async def _save_history_event(
    db: AsyncSession,
    *,
    source: str,
    title: str,
    summary: list[dict[str, Any]],
) -> ChangeSetRow:
    row = ChangeSetRow(
        id=uuid.uuid4().hex[:16],
        source=source,
        title=title,
        summary=summary,
        before_state={},
        after_state={},
    )
    db.add(row)
    await db.commit()
    return row


@app.get("/api/time-tracking/active")
async def active_time_tracking(
    db: AsyncSession = Depends(session),
) -> dict[str, Any] | None:
    row = (
        await db.execute(
            select(TimeEntryRow)
            .where(TimeEntryRow.status.in_(["running", "paused"]))
            .order_by(TimeEntryRow.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return await _time_entry_dict(db, row)


@app.get("/api/time-tracking/{intent_id}/stats")
async def time_tracking_stats(
    intent_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    intent_row = await db.get(IntentRow, intent_id)
    if intent_row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")

    rows = (
        await db.execute(
            select(TimeEntryRow)
            .where(
                TimeEntryRow.intent_id == intent_id,
                TimeEntryRow.status == "stopped",
            )
            .order_by(TimeEntryRow.started_at.asc())
        )
    ).scalars().all()
    total = sum(row.accumulated_seconds for row in rows)
    intent = Intent.model_validate(intent_row.payload)

    all_intent_rows = (await db.execute(select(IntentRow))).scalars().all()
    similar_ids: list[str] = []
    normalized_title = intent.title.strip().casefold()
    for candidate_row in all_intent_rows:
        candidate = Intent.model_validate(candidate_row.payload)
        if candidate.title.strip().casefold() != normalized_title:
            continue
        if candidate.category != intent.category:
            continue
        similar_ids.append(candidate.id)

    similar_rows = (
        (
            await db.execute(
                select(TimeEntryRow).where(
                    TimeEntryRow.intent_id.in_(similar_ids),
                    TimeEntryRow.status == "stopped",
                )
            )
        ).scalars().all()
        if similar_ids
        else []
    )
    similar_total = sum(row.accumulated_seconds for row in similar_rows)
    similar_average = (
        round(similar_total / len(similar_rows))
        if similar_rows
        else 0
    )
    suggested_minutes = (
        max(
            SLOT_MINUTES,
            ((round(similar_average / 60) + SLOT_MINUTES - 1) // SLOT_MINUTES)
            * SLOT_MINUTES,
        )
        if similar_average
        else intent.minutes_per_period
    )

    return {
        "intent_id": intent_id,
        "title": intent.title,
        "planned_minutes": intent.minutes_per_period,
        "sessions": len(rows),
        "total_seconds": total,
        "average_seconds": round(total / len(rows)) if rows else 0,
        "similar_sessions": len(similar_rows),
        "similar_average_seconds": similar_average,
        "suggested_minutes": suggested_minutes,
    }


@app.post("/api/time-tracking/{intent_id}/start", status_code=201)
async def start_time_tracking(
    intent_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    intent_row = await db.get(IntentRow, intent_id)
    if intent_row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")
    intent = Intent.model_validate(intent_row.payload)
    if intent.completed_at is not None:
        raise HTTPException(
            status_code=422,
            detail="Nie można uruchomić timera dla zakończonego zadania.",
        )

    active = (
        await db.execute(
            select(TimeEntryRow)
            .where(TimeEntryRow.status.in_(["running", "paused"]))
            .limit(1)
        )
    ).scalar_one_or_none()
    if active is not None:
        active_intent = await db.get(IntentRow, active.intent_id)
        active_title = (
            Intent.model_validate(active_intent.payload).title
            if active_intent is not None
            else "inne zadanie"
        )
        raise HTTPException(
            status_code=409,
            detail=f"Timer działa już dla „{active_title}”. Najpierw go zakończ lub wstrzymaj.",
        )

    now = datetime.now(UTC)
    row = TimeEntryRow(
        id=uuid.uuid4().hex[:16],
        intent_id=intent_id,
        status="running",
        started_at=now,
        last_resumed_at=now,
        accumulated_seconds=0,
    )
    db.add(row)
    await db.commit()
    await _save_history_event(
        db,
        source="timer",
        title=f"Start · {intent.title}",
        summary=[{"action": "timer_start", "intent_id": intent_id, "title": intent.title}],
    )
    return await _time_entry_dict(db, row)


@app.post("/api/time-tracking/{intent_id}/pause")
async def pause_time_tracking(
    intent_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = (
        await db.execute(
            select(TimeEntryRow)
            .where(
                TimeEntryRow.intent_id == intent_id,
                TimeEntryRow.status == "running",
            )
            .order_by(TimeEntryRow.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Brak uruchomionego timera dla tego zadania.")

    now = datetime.now(UTC)
    if row.last_resumed_at is not None:
        row.accumulated_seconds += max(
            0,
            int(
                (
                    _utc_aware(now)
                    - _utc_aware(row.last_resumed_at)
                ).total_seconds()
            ),
        )
    row.last_resumed_at = None
    row.status = "paused"
    await db.commit()
    await _save_history_event(
        db,
        source="timer",
        title=f"Pauza · {(await _time_entry_dict(db, row))['title']}",
        summary=[{"action": "timer_pause", "intent_id": intent_id}],
    )
    return await _time_entry_dict(db, row)


@app.post("/api/time-tracking/{intent_id}/resume")
async def resume_time_tracking(
    intent_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = (
        await db.execute(
            select(TimeEntryRow)
            .where(
                TimeEntryRow.intent_id == intent_id,
                TimeEntryRow.status == "paused",
            )
            .order_by(TimeEntryRow.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Brak wstrzymanego timera dla tego zadania.")

    row.status = "running"
    row.last_resumed_at = datetime.now(UTC)
    await db.commit()
    await _save_history_event(
        db,
        source="timer",
        title=f"Wznowiono · {(await _time_entry_dict(db, row))['title']}",
        summary=[{"action": "timer_resume", "intent_id": intent_id}],
    )
    return await _time_entry_dict(db, row)


@app.post("/api/time-tracking/{intent_id}/stop")
async def stop_time_tracking(
    intent_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = (
        await db.execute(
            select(TimeEntryRow)
            .where(
                TimeEntryRow.intent_id == intent_id,
                TimeEntryRow.status.in_(["running", "paused"]),
            )
            .order_by(TimeEntryRow.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Brak aktywnego timera dla tego zadania.")

    now = datetime.now(UTC)
    if row.status == "running" and row.last_resumed_at is not None:
        row.accumulated_seconds += max(
            0,
            int(
                (
                    _utc_aware(now)
                    - _utc_aware(row.last_resumed_at)
                ).total_seconds()
            ),
        )
    row.last_resumed_at = None
    row.status = "stopped"
    row.ended_at = now
    await db.commit()
    payload = await _time_entry_dict(db, row)
    await _save_history_event(
        db,
        source="timer",
        title=f"Zakończono pomiar · {payload['title']}",
        summary=[
            {
                "action": "timer_stop",
                "intent_id": intent_id,
                "title": payload["title"],
                "elapsed_seconds": row.accumulated_seconds,
            }
        ],
    )
    return payload


@app.get("/api/history")
async def change_history(
    limit: int = 50,
    db: AsyncSession = Depends(session),
) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 200))
    rows = (
        await db.execute(
            select(ChangeSetRow)
            .order_by(ChangeSetRow.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    latest_reversible = next(
        (
            row
            for row in rows
            if row.undone_at is None and row.source != "timer"
        ),
        None,
    )
    current_snapshot = (
        await _planning_snapshot(db)
        if latest_reversible is not None
        else None
    )
    return [
        {
            "id": row.id,
            "source": row.source,
            "title": row.title,
            "summary": row.summary,
            "created_at": row.created_at.isoformat(),
            "undone_at": _iso_or_none(row.undone_at),
            "can_undo": (
                row.undone_at is None
                and latest_reversible is not None
                and row.id == latest_reversible.id
                and current_snapshot == row.after_state
            ),
        }
        for row in rows
    ]


@app.post("/api/history/{change_id}/undo")
async def undo_change_set(
    change_id: str,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    row = await db.get(ChangeSetRow, change_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Nie znaleziono tej zmiany.")
    if row.undone_at is not None:
        raise HTTPException(status_code=409, detail="Ta zmiana została już cofnięta.")

    latest = (
        await db.execute(
            select(ChangeSetRow)
            .where(
                ChangeSetRow.undone_at.is_(None),
                ChangeSetRow.source != "timer",
            )
            .order_by(ChangeSetRow.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is None or latest.id != row.id:
        raise HTTPException(
            status_code=409,
            detail=(
                "Można cofnąć tylko najnowszy niecofnięty pakiet. "
                "Chroni to późniejsze zmiany przed przypadkowym nadpisaniem."
            ),
        )

    current = await _planning_snapshot(db)
    if current != row.after_state:
        raise HTTPException(
            status_code=409,
            detail=(
                "Plan zmienił się już po tej operacji. Horolog nie cofnie starego "
                "snapshotu, żeby nie nadpisać nowszych decyzji."
            ),
        )

    await _restore_planning_snapshot(db, row.before_state)
    row.undone_at = datetime.now(UTC)
    await db.commit()
    return {
        "id": row.id,
        "status": "undone",
        "undone_at": row.undone_at.isoformat(),
    }


class CaptureIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    model: str | None = None
    provider: str | None = None
    api_key: str | None = None


@app.post("/api/capture", status_code=201)
async def capture_intent(body: CaptureIn, db: AsyncSession = Depends(session)) -> dict[str, Any]:
    """Natural language in, a scheduled intent out.

    The model's output is a proposal: it is schema-constrained at decode time,
    Pydantic-validated here, and then re-validated by the domain model through
    the ordinary create path. It never reaches a calendar except by way of the
    placer, so the worst a bad extraction can do is create a wrong-looking
    intent the user can delete.
    """
    try:
        custom_provider: Provider | None = None
        if body.provider and body.provider != "default" and body.model:
            timeout = settings().llm_timeout_s
            if body.provider == "anthropic":
                # Raises a friendly RuntimeError if the optional `anthropic`
                # extra isn't installed — has to happen inside this try, or
                # that message never reaches the response.
                custom_provider = AnthropicProvider(body.model, body.api_key or "", timeout)
            else:
                base_url = (
                    "https://api.openai.com/v1"
                    if body.provider == "openai"
                    else settings().llm_base_url
                )
                custom_provider = OpenAICompatible(
                    base_url, body.model, body.api_key or "", timeout
                )

        draft = await capture(body.text, provider=custom_provider)
    except ExtractionFailed as exc:
        # Explicitly not a 500: the request was fine, the model could not read
        # it. The UI falls back to the manual form on this status.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ProviderError, httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=f"language model unreachable: {exc}") from exc

    payload = to_payload(draft, origin())
    created = await create_intent(IntentIn.model_validate(payload), db)
    return {"intent": created, "understood": draft.model_dump(mode="json")}


@app.delete("/api/intents/{intent_id}")
async def delete_intent(intent_id: str, db: AsyncSession = Depends(session)) -> Response:
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")
    zoom_meeting_id = row.payload.get("zoom_meeting_id")
    await db.delete(row)
    await db.commit()

    if zoom_meeting_id:
        cfg = settings()
        if cfg.zoom_account_id and cfg.zoom_client_id and cfg.zoom_client_secret:
            # Best-effort cleanup — an unreachable Zoom must never stop the
            # intent itself from being deleted; it just leaves an orphaned
            # meeting behind in the Zoom account.
            try:
                await delete_meeting(cfg, zoom_meeting_id)
            except ZoomError as exc:
                logger.warning("Could not remove Zoom meeting %s: %s", zoom_meeting_id, exc)

    await _replan(db)
    return Response(status_code=204)


@app.post("/api/intents/{intent_id}/complete-block")
async def complete_intent_block(
    intent_id: str,
    body: CompletedBlockIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Mark one concrete occurrence of a recurring intent as completed."""
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")

    intent = Intent.model_validate(row.payload)
    if intent.period_days is None:
        raise HTTPException(
            status_code=422,
            detail="one-shot tasks use the intent completion endpoint",
        )
    if body.end <= body.start:
        raise HTTPException(status_code=422, detail="block end must be after start")

    already_completed = any(
        block.start == body.start and block.end == body.end for block in intent.completed_blocks
    )
    if not already_completed:
        completed = CompletedBlock(
            start=body.start,
            end=body.end,
            completed_at=datetime.now(UTC),
        )
        intent = intent.model_copy(
            update={"completed_blocks": [*intent.completed_blocks, completed]}
        )
        row.payload = intent.model_dump(mode="json")
        await db.commit()

    await _replan(db)
    return intent.model_dump(mode="json")


@app.delete("/api/intents/{intent_id}/complete-block")
async def uncomplete_intent_block(
    intent_id: str,
    body: CompletedBlockIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Undo completion of one concrete recurring occurrence."""
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")

    intent = Intent.model_validate(row.payload)
    remaining = [
        block
        for block in intent.completed_blocks
        if not (block.start == body.start and block.end == body.end)
    ]

    intent = intent.model_copy(update={"completed_blocks": remaining})
    row.payload = intent.model_dump(mode="json")
    await db.commit()
    await _replan(db)
    return intent.model_dump(mode="json")


@app.post("/api/intents/{intent_id}/complete")
async def complete_intent(
    intent_id: str,
    db: AsyncSession = Depends(session),
    record_history: bool = True,
) -> dict[str, Any]:
    """Mark a one-shot task done.

    The row is kept rather than deleted — so the inbox and analytics can
    still show it was finished — but `solver/expand.py` skips a completed
    intent entirely, so whatever capacity it still held is freed on the very
    next solve, same as a delete would free it.
    """
    before = await _planning_snapshot(db) if record_history else None
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")
    intent = Intent.model_validate(row.payload)
    if intent.period_days is not None:
        raise HTTPException(
            status_code=422,
            detail="only a one-shot task can be marked complete — a recurring "
            "habit needs per-occurrence completion, not built yet",
        )
    completed_at = datetime.now(UTC)

    # Preserve the task's current calendar placement before the next solve
    # removes its demand. This lets the planner keep showing the finished
    # task in its original slot as a completed/struck-through block.
    previous_plan = await load_previous_plan(db)
    base = origin()
    archived_blocks = (
        [
            CompletedBlock(
                start=from_slot(block.start_slot, base),
                end=from_slot(block.end_slot, base),
                completed_at=completed_at,
            )
            for block in previous_plan.blocks
            if block.intent_id == intent_id
        ]
        if previous_plan is not None
        else []
    )

    intent = intent.model_copy(
        update={
            "completed_at": completed_at,
            "completed_blocks": archived_blocks or intent.completed_blocks,
        }
    )
    row.payload = intent.model_dump(mode="json")
    daily_rows = (
        await db.execute(
            select(DailyPlanItemRow).where(
                DailyPlanItemRow.intent_id == intent_id,
                DailyPlanItemRow.completed_at.is_(None),
            )
        )
    ).scalars().all()
    for daily_row in daily_rows:
        daily_row.completed_at = completed_at
    await db.commit()
    await _replan(db)
    if before is not None:
        after = await _planning_snapshot(db)
        await _save_change_set(
            db,
            source="manual",
            title=f"Wykonane · {intent.title}",
            summary=[{"action": "complete_task", "intent_id": intent_id, "title": intent.title}],
            before=before,
            after=after,
        )
    return intent.model_dump(mode="json")


@app.delete("/api/intents/{intent_id}/complete")
async def uncomplete_intent(
    intent_id: str,
    db: AsyncSession = Depends(session),
    record_history: bool = True,
) -> dict[str, Any]:
    """Undo a completion — a misclick shouldn't require a delete-and-retype."""
    before = await _planning_snapshot(db) if record_history else None
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")
    intent = Intent.model_validate(row.payload).model_copy(
        update={
            "completed_at": None,
            "completed_blocks": [],
        }
    )
    row.payload = intent.model_dump(mode="json")
    daily_rows = (
        await db.execute(select(DailyPlanItemRow).where(DailyPlanItemRow.intent_id == intent_id))
    ).scalars().all()
    for daily_row in daily_rows:
        daily_row.completed_at = None
    await db.commit()
    await _replan(db)
    if before is not None:
        after = await _planning_snapshot(db)
        await _save_change_set(
            db,
            source="manual",
            title=f"Cofnięto wykonanie · {intent.title}",
            summary=[{"action": "uncomplete_task", "intent_id": intent_id, "title": intent.title}],
            before=before,
            after=after,
        )
    return intent.model_dump(mode="json")


@app.post("/api/intents/{intent_id}/move")
async def move_intent(
    intent_id: str,
    body: MoveIntentIn,
    db: AsyncSession = Depends(session),
    record_history: bool = True,
) -> dict[str, Any]:
    """Move a one-shot task, protected break, or meeting in Planner.

    Manual moves are explicit user decisions:
    - tasks and breaks use the selected span,
    - meetings stay at the exact selected start time,
    - recurring routines remain unsupported,
    - dates before today remain outside the active planning horizon.
    """
    before = await _planning_snapshot(db) if record_history else None
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")

    intent = Intent.model_validate(row.payload)
    if intent.period_days is not None:
        raise HTTPException(
            status_code=422,
            detail="Recurring routines are not draggable as whole tasks yet.",
        )
    if intent.kind not in (IntentKind.TASK, IntentKind.BUFFER, IntentKind.MEETING):
        raise HTTPException(
            status_code=422,
            detail="Only one-shot tasks, breaks and meetings can be moved in Planner.",
        )
    if intent.completed_at is not None:
        raise HTTPException(status_code=422, detail="Completed items cannot be moved.")
    if body.end <= body.start:
        raise HTTPException(status_code=422, detail="Move end must be after start.")

    start = body.start.astimezone(settings().zone)
    end = body.end.astimezone(settings().zone)
    if start.date() < origin().date():
        raise HTTPException(
            status_code=422,
            detail="An item cannot be moved to a day before today.",
        )

    original_payload = dict(row.payload)
    base = origin()
    target_day_start = start.replace(hour=0, minute=0, second=0, microsecond=0)
    target_day_end = target_day_start + timedelta(days=1)
    start_min = start.hour * 60 + start.minute

    if intent.kind == IntentKind.MEETING:
        requested_seconds = int((end - start).total_seconds())
        if requested_seconds % (SLOT_MINUTES * 60) != 0:
            raise HTTPException(
                status_code=422,
                detail=f"Duration must use {SLOT_MINUTES}-minute increments.",
            )
        if start.minute % SLOT_MINUTES != 0 or start.second != 0 or start.microsecond != 0:
            raise HTTPException(
                status_code=422,
                detail=f"Start time must use {SLOT_MINUTES}-minute increments.",
            )

        meeting_minutes = requested_seconds // 60
        meeting_end = start + timedelta(minutes=meeting_minutes)
        if meeting_end.date() != start.date():
            raise HTTPException(
                status_code=409,
                detail="The meeting would extend beyond the selected day.",
            )

        moved = intent.model_copy(
            update={
                # Meeting edits are authoritative, just like Planner task/break
                # edits. Preserve meeting-only metadata (blocked slots, Zoom)
                # while updating the concrete requested span and duration.
                "minutes_per_period": meeting_minutes,
                "min_chunk_minutes": meeting_minutes,
                "max_chunk_minutes": meeting_minutes,
                "max_per_day": 1,
                "earliest_slot": to_slot(start, base),
                "latest_slot": to_slot(meeting_end, base),
                "due_slot": to_slot(meeting_end, base),
                "preferred_start_min": start_min,
                "daily_windows": [
                    DailyWindow(
                        start_min=start_min,
                        end_min=start_min + meeting_minutes,
                    )
                ],
                "allowed_weekdays": [],
            }
        )
    else:
        requested_seconds = int((end - start).total_seconds())
        if requested_seconds % (SLOT_MINUTES * 60) != 0:
            raise HTTPException(
                status_code=422,
                detail=f"Duration must use {SLOT_MINUTES}-minute increments.",
            )
        if start.minute % SLOT_MINUTES != 0 or start.second != 0 or start.microsecond != 0:
            raise HTTPException(
                status_code=422,
                detail=f"Start time must use {SLOT_MINUTES}-minute increments.",
            )

        dragged_minutes = requested_seconds // 60

        if body.exact:
            task_minutes = dragged_minutes
            task_end = start + timedelta(minutes=task_minutes)
            if task_end.date() != start.date():
                raise HTTPException(
                    status_code=409,
                    detail="The item would extend beyond the selected day.",
                )

            moved = intent.model_copy(
                update={
                    # A Planner edit is authoritative: resize the task itself,
                    # then pin the resulting single block to exactly this span.
                    "minutes_per_period": task_minutes,
                    "min_chunk_minutes": task_minutes,
                    "max_chunk_minutes": task_minutes,
                    "max_per_day": 1,
                    "earliest_slot": to_slot(start, base),
                    "latest_slot": to_slot(task_end, base),
                    "due_slot": to_slot(task_end, base),
                    "preferred_start_min": start_min,
                    "daily_windows": [
                        DailyWindow(
                            start_min=start_min,
                            end_min=start_min + task_minutes,
                        )
                    ],
                    "allowed_weekdays": [],
                }
            )
        else:
            # Date-only assistant reschedules keep the task's duration and may
            # let the solver choose a later free slot on the selected day.
            required_window = max(
                dragged_minutes,
                intent.minutes_per_period,
                intent.max_chunk_minutes,
            )
            window_end = min(24 * 60, start_min + required_window)
            if window_end - start_min < intent.min_chunk_minutes:
                raise HTTPException(
                    status_code=409,
                    detail="There is not enough time left on that day for this task.",
                )

            moved = intent.model_copy(
                update={
                    "earliest_slot": to_slot(start, base),
                    "latest_slot": to_slot(target_day_end, base),
                    "due_slot": to_slot(target_day_end, base) - 1,
                    "preferred_start_min": start_min,
                    "daily_windows": [
                        DailyWindow(start_min=start_min, end_min=window_end)
                    ],
                    "allowed_weekdays": [],
                }
            )

    row.payload = moved.model_dump(mode="json")
    await db.commit()

    new_plan = await _replan(db)
    target_blocks = [block for block in new_plan.blocks if block.intent_id == intent_id]
    target_date = start.date()

    if intent.kind == IntentKind.MEETING:
        expected_start_slot = to_slot(start, base)
        expected_end_slot = to_slot(end, base)
        correctly_placed = (
            len(target_blocks) == 1
            and target_blocks[0].start_slot == expected_start_slot
            and target_blocks[0].end_slot == expected_end_slot
        )
        if not correctly_placed:
            row.payload = original_payload
            await db.commit()
            await _replan(db)
            raise HTTPException(
                status_code=409,
                detail=(
                    "This meeting cannot be placed at the selected time. "
                    "Choose another time or free that slot."
                ),
            )
    else:
        if body.exact:
            expected_start_slot = to_slot(start, base)
            expected_end_slot = to_slot(end, base)
            correctly_placed = (
                len(target_blocks) == 1
                and target_blocks[0].start_slot == expected_start_slot
                and target_blocks[0].end_slot == expected_end_slot
            )
            if not correctly_placed:
                row.payload = original_payload
                await db.commit()
                await _replan(db)
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This item cannot be placed at the selected time. "
                        "Choose another time or free that slot."
                    ),
                )
        else:
            all_on_target_day = bool(target_blocks) and all(
                from_slot(block.start_slot, base).astimezone(settings().zone).date()
                == target_date
                for block in target_blocks
            )
            placed_slots = sum(
                block.end_slot - block.start_slot for block in target_blocks
            )
            required_slots = minutes_to_slots(intent.minutes_per_period)

            if not all_on_target_day or placed_slots < required_slots:
                row.payload = original_payload
                await db.commit()
                await _replan(db)
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This task does not fully fit on the selected day. "
                        "Choose another day or free more time."
                    ),
                )

    linked_daily = (
        await db.execute(
            select(DailyPlanItemRow).where(
                DailyPlanItemRow.intent_id == intent_id,
                DailyPlanItemRow.completed_at.is_(None),
                DailyPlanItemRow.cancelled_at.is_(None),
            )
        )
    ).scalars().all()
    target_key = target_date.isoformat()
    for daily_row in linked_daily:
        daily_row.plan_date = target_key
        if intent.kind == IntentKind.TASK and body.exact:
            daily_row.minutes = dragged_minutes
    if linked_daily:
        await db.commit()

    result = {
        "intent_id": intent_id,
        "date": target_key,
        "start": from_slot(target_blocks[0].start_slot, base).isoformat(),
        "blocks": len(target_blocks),
    }
    if before is not None:
        after = await _planning_snapshot(db)
        await _save_change_set(
            db,
            source="manual",
            title=f"Zmiana w Plannerze · {intent.title}",
            summary=[
                {
                    "action": "move_intent",
                    "intent_id": intent_id,
                    "title": intent.title,
                    "date": target_key,
                    "start": result["start"],
                    "minutes": moved.minutes_per_period,
                }
            ],
            before=before,
            after=after,
        )
    return result


@app.patch("/api/intents/{intent_id}")
async def patch_intent(
    intent_id: str,
    body: IntentPatchIn,
    db: AsyncSession = Depends(session),
) -> dict[str, Any]:
    """Update intent metadata without rebuilding its scheduling constraints."""
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")

    intent = Intent.model_validate(row.payload)
    updates: dict[str, Any] = {}

    if body.title is not None:
        updates["title"] = body.title.strip()
    if body.priority is not None:
        updates["priority"] = body.priority
    if "category" in body.model_fields_set:
        updates["category"] = body.category
    if "deadline_date" in body.model_fields_set:
        if body.deadline_date is None:
            # Remove the solver bound only when it came from the previous
            # explicit deadline. Other due constraints must survive.
            old_deadline_slot = (
                to_slot(_deadline_end(intent.deadline_date), origin())
                if intent.deadline_date
                else None
            )
            updates["deadline_date"] = None
            if old_deadline_slot is not None and intent.due_slot == old_deadline_slot:
                updates["due_slot"] = None
        else:
            deadline_end = _deadline_end(body.deadline_date)
            deadline_slot = to_slot(deadline_end, origin())
            if intent.earliest_slot is not None and deadline_slot <= intent.earliest_slot:
                raise HTTPException(
                    status_code=422,
                    detail="Maksymalny deadline musi być późniejszy niż początek dostępności zadania.",
                )
            updates["deadline_date"] = body.deadline_date
            updates["due_slot"] = deadline_slot

    if not updates:
        return intent.model_dump(mode="json")

    updated = intent.model_copy(update=updates)
    row.payload = updated.model_dump(mode="json")
    await db.commit()

    # Title/category are metadata only and must never reshuffle the calendar.
    # Priority and deadline can change legal placement and require a re-solve.
    if body.priority is not None or "deadline_date" in body.model_fields_set:
        await _replan(db)

    return updated.model_dump(mode="json")


@app.put("/api/intents/{intent_id}")
async def update_intent(
    intent_id: str, body: IntentIn, db: AsyncSession = Depends(session)
) -> dict[str, Any]:
    """Replace an intent in place, keeping its id.

    Full replace rather than a per-field merge: fifteen interdependent fields
    behind one cross-field validator make merge logic more code and more edge
    cases than just re-validating the whole object, and the frontend already
    has the whole thing in hand when it opens an edit form.

    Keeping the id is the actual point — the previous plan is keyed by it, so
    an edit keeps placement stability for every chunk still legal under the
    new shape, where delete-and-recreate would throw all of it away and
    reshuffle blocks that never needed to move.
    """
    row = await db.get(IntentRow, intent_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no intent {intent_id!r}")
    try:
        intent = body.to_domain(intent_id, origin(), await _preferred_workday(db))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Neither field is settable from the wire — a Zoom link is server-issued
    # on create, and completion has its own dedicated routes — so an edit
    # must not silently wipe either as a side effect of `to_domain` defaulting
    # them to None.
    previous = Intent.model_validate(row.payload)
    intent = intent.model_copy(
        update={
            "zoom_meeting_id": previous.zoom_meeting_id,
            "zoom_join_url": previous.zoom_join_url,
            "completed_blocks": previous.completed_blocks,
            "completed_at": previous.completed_at,
        }
    )
    row.payload = intent.model_dump(mode="json")
    await db.commit()
    await _replan(db)
    return intent.model_dump(mode="json")


@app.put("/api/busy", status_code=200)
async def replace_busy(body: list[BusyIn], db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Replace the hand-entered calendar.

    Stands in for the provider sync layer: whatever is posted becomes the set of
    immovable events. Replacing rather than merging keeps the mirror an exact
    reflection, so a deleted meeting actually frees its slot.

    Scoped to the sources being written. A blanket delete here would silently
    wipe a synced ICS feed and every accepted booking the moment anyone saved a
    manual event — sources are independent mirrors, and each owns only its own
    rows (`_mirror` scopes its delete the same way).
    """
    base = origin()
    touched = {event.source for event in body} | {"manual"}
    await db.execute(delete(BusyRow).where(BusyRow.source.in_(touched)))
    stored = 0
    for event in body:
        if event.end <= event.start:
            raise HTTPException(status_code=422, detail=f"{event.label!r} ends before it starts")
        span = _clip(to_slot(event.start, base), to_slot(event.end, base))
        if span is None:
            continue
        stored += 1
        db.add(
            BusyRow(
                id=uuid.uuid4().hex[:16],
                source=event.source,
                label=event.label,
                start_slot=span[0],
                end_slot=span[1],
            )
        )
    await db.commit()
    plan = await _replan(db)
    return {"events": stored, "blocks": len(plan.blocks)}


@app.get("/api/plan")
async def get_plan(db: AsyncSession = Depends(session)) -> PlanOut:
    plan = await load_previous_plan(db)
    if plan is None:
        plan = await _replan(db)
    return await _render(db, plan)


@app.post("/api/plan/solve")
async def resolve(db: AsyncSession = Depends(session)) -> PlanOut:
    return await _render(db, await _replan(db))


@app.get("/api/analytics")
async def analytics(db: AsyncSession = Depends(session)) -> Analytics:
    """How the plan actually spends the week."""
    cfg = settings()
    workday_start_min, workday_end_min = await _preferred_workday(db)
    plan = await load_previous_plan(db) or await _replan(db)
    return analyse(
        plan,
        await load_intents(db),
        # Merged, because a double-booked calendar would otherwise count the
        # same hour twice and report a meeting load above 100%.
        merge_busy(await _busy(db)),
        horizon_days=cfg.horizon_days,
        workday_start_min=workday_start_min,
        workday_end_min=workday_end_min,
    )


class IcsSyncIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)


@app.post("/api/sync/ics")
async def sync_ics(body: IcsSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror a published .ics feed.

    The zero-config path onto Google and Outlook: both publish a private iCal
    address, so this needs no OAuth app and no publicly reachable callback.
    """
    cfg = settings()
    provider = ICSProvider(body.url, cfg.zone)
    return await _mirror(db, provider, "ics")


class CalDavSyncIn(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    username: str = ""
    password: str = ""


@app.post("/api/sync/caldav")
async def sync_caldav(body: CalDavSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    cfg = settings()
    provider = CalDAVProvider(body.url, body.username, body.password, cfg.zone)
    return await _mirror(db, provider, "caldav")


LINEAR_PREFIX = "linear:"
TODOIST_PREFIX = "todoist:"
GITHUB_PREFIX = "github:"
NOTION_PREFIX = "notion:"
CLICKUP_PREFIX = "clickup:"
JIRA_PREFIX = "jira:"


class LinearSyncIn(BaseModel):
    api_key: str = Field(default="", max_length=200)
    """A personal API key, pasted directly. Empty uses the stored OAuth
    connection instead — either path is a legitimate way to authenticate."""
    priority: Priority = Priority.P2
    max_chunk_minutes: int = Field(default=120, gt=0)


async def _resolve_credential(db: AsyncSession, provider: str, pasted: str) -> str:
    """A pasted key wins; otherwise fall back to a stored OAuth connection.

    Stripped, not just checked for emptiness: a key copied from a terminal
    or a text field routinely carries a trailing newline or space, and that
    one invisible character turns into `Authorization: Bearer <key> ` — a
    header value httpx's own validation rejects outright, well before the
    request ever reaches the provider. A whitespace-only paste is treated as
    no paste at all, falling through to a stored OAuth connection same as
    an empty one would.
    """
    pasted = pasted.strip()
    if pasted:
        return pasted
    token = await oauth.valid_access_token(db, settings(), provider)
    if not token:
        raise HTTPException(
            status_code=409,
            detail=f"{provider} is not connected — paste a key or connect it in Calendars & Sync",
        )
    return token


@app.post("/api/sync/linear")
async def sync_linear(body: LinearSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror Linear's started issues as schedulable tasks.

    Replace rather than merge, on a stable `linear:<issue-id>` key: an issue
    moved out of progress has to stop consuming time, and reusing the key keeps
    a re-sync from shuffling everything that did not change.
    """
    api_key = await _resolve_credential(db, "linear", body.api_key)
    try:
        issues = await fetch_linear_issues(api_key)
    except LinearError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await db.execute(delete(IntentRow).where(IntentRow.id.startswith(LINEAR_PREFIX)))
    base = origin()
    for issue in issues:
        label = f"{issue.identifier} {issue.title}".strip()
        wire = IntentIn(
            title=label[:200],
            kind=IntentKind.TASK,
            priority=body.priority,
            minutes_per_period=issue.minutes,
            # An issue smaller than the default 30-minute floor would be
            # rejected by the domain model for demanding less than one chunk.
            min_chunk_minutes=min(30, issue.minutes),
            max_chunk_minutes=max(min(body.max_chunk_minutes, issue.minutes), issue.minutes),
        )
        intent = wire.to_domain(f"{LINEAR_PREFIX}{issue.id}", base, await _preferred_workday(db))
        db.add(IntentRow(id=intent.id, payload=intent.model_dump(mode="json")))
    await db.commit()
    plan = await _replan(db)
    return {"issues": len(issues), "blocks": len(plan.blocks)}


class TokenSyncIn(BaseModel):
    token: str = Field(default="", max_length=500)


async def _sync_tasks(
    db: AsyncSession, prefix: str, kind_label: str, tasks: list[tuple[str, str, Priority, int]]
) -> int:
    """Store a provider's tasks as intents under a stable id prefix.

    Shared by Todoist and GitHub: both reduce to (id, title, priority,
    minutes) tuples, so the storage half — replace-by-prefix, `to_domain`,
    commit — does not need writing twice.
    """
    await db.execute(delete(IntentRow).where(IntentRow.id.startswith(prefix)))
    base = origin()
    for task_id, title, priority, minutes in tasks:
        wire = IntentIn(
            title=f"{kind_label}: {title}"[:200],
            kind=IntentKind.TASK,
            priority=priority,
            minutes_per_period=minutes,
            min_chunk_minutes=min(30, minutes),
            max_chunk_minutes=minutes,
        )
        intent = wire.to_domain(f"{prefix}{task_id}", base, await _preferred_workday(db))
        db.add(IntentRow(id=intent.id, payload=intent.model_dump(mode="json")))
    await db.commit()
    return len(tasks)


@app.post("/api/sync/todoist")
async def sync_todoist(body: TokenSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror uncompleted Todoist tasks as schedulable intents."""
    token = await _resolve_credential(db, "todoist", body.token)
    try:
        tasks = await fetch_todoist_tasks(token)
    except TodoistError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    count = await _sync_tasks(
        db,
        TODOIST_PREFIX,
        "Todoist",
        [(t.id, t.content, t.priority, t.minutes) for t in tasks],
    )
    plan = await _replan(db)
    return {"tasks": count, "blocks": len(plan.blocks)}


@app.post("/api/sync/github")
async def sync_github(body: TokenSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror assigned open GitHub issues as schedulable intents."""
    token = await _resolve_credential(db, "github", body.token)
    try:
        issues = await fetch_github_issues(token)
    except GithubError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    count = await _sync_tasks(
        db,
        GITHUB_PREFIX,
        "GitHub",
        [(i.id, f"#{i.number} {i.title}", Priority.P2, i.minutes) for i in issues],
    )
    plan = await _replan(db)
    return {"issues": count, "blocks": len(plan.blocks)}


async def _require_pasted_credential(body: TokenSyncIn, provider: str) -> str:
    """These three trackers have no OAuth app to fall back to (see
    integrations/{notion,clickup,jira}.py's docstrings for why) — a pasted
    credential is the only path, so its absence is the caller's mistake to
    fix, not a 409 "go connect it" that implies a button that doesn't exist.

    Stripped for the same reason `_resolve_credential` strips its own pasted
    key — a trailing newline from a copy-paste turns into an HTTP header
    httpx refuses to send, well before the request reaches the provider.
    """
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=422, detail=f"paste a {provider} credential first")
    return token


@app.post("/api/sync/notion")
async def sync_notion(body: TokenSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror every page in a Notion database as schedulable intents."""
    credential = await _require_pasted_credential(body, "Notion database_id:integration_token")
    try:
        tasks = await fetch_notion_tasks(credential)
    except NotionError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    count = await _sync_tasks(
        db, NOTION_PREFIX, "Notion", [(t.id, t.title, Priority.P3, t.minutes) for t in tasks]
    )
    plan = await _replan(db)
    return {"tasks": count, "blocks": len(plan.blocks)}


@app.post("/api/sync/clickup")
async def sync_clickup(body: TokenSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror open ClickUp tasks assigned to the token owner as schedulable intents."""
    credential = await _require_pasted_credential(body, "ClickUp team_id:api_token")
    try:
        tasks = await fetch_clickup_tasks(credential)
    except ClickUpError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    count = await _sync_tasks(
        db,
        CLICKUP_PREFIX,
        "ClickUp",
        [(t.id, t.name, t.priority, t.minutes) for t in tasks],
    )
    plan = await _replan(db)
    return {"tasks": count, "blocks": len(plan.blocks)}


@app.post("/api/sync/jira")
async def sync_jira(body: TokenSyncIn, db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror unresolved Jira issues assigned to the token owner as schedulable intents."""
    credential = await _require_pasted_credential(body, "Jira site:email:api_token")
    try:
        issues = await fetch_jira_issues(credential)
    except JiraError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    count = await _sync_tasks(
        db,
        JIRA_PREFIX,
        "Jira",
        [(i.id, f"{i.key} {i.summary}".strip(), i.priority, i.minutes) for i in issues],
    )
    plan = await _replan(db)
    return {"issues": count, "blocks": len(plan.blocks)}


@app.post("/api/sync/google")
async def sync_google(db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror real Google Calendar events for the connected account.

    No body: the access token lives server-side (`/api/auth/google` put it
    there), never in a request from the browser.
    """
    token = await _resolve_credential(db, "google", "")
    provider = GoogleCalendarProvider(token, settings().zone)
    return await _mirror(db, provider, "google")


@app.post("/api/sync/outlook")
async def sync_outlook(db: AsyncSession = Depends(session)) -> dict[str, int]:
    """Mirror real Outlook / Microsoft 365 events for the connected account."""
    token = await _resolve_credential(db, "outlook", "")
    provider = OutlookCalendarProvider(token, settings().zone)
    return await _mirror(db, provider, "outlook")


class CalendarPushIn(BaseModel):
    provider: str


@app.post("/api/calendar/push")
async def push_calendar(
    body: CalendarPushIn, db: AsyncSession = Depends(session)
) -> dict[str, int]:
    """Push the current plan onto the connected provider's "Horolog" calendar
    right now, rather than waiting for the next background tick — the
    explicit "sync now" a user reaches for after enabling write-back."""
    if body.provider not in oauth.CALENDAR_PROVIDERS:
        raise HTTPException(status_code=404, detail=f"unknown provider {body.provider!r}")
    if not settings().calendar_writeback_enabled:
        raise HTTPException(
            status_code=409,
            detail="calendar write-back is disabled — set HOROLOG_CALENDAR_WRITEBACK_ENABLED=true",
        )
    return await _push_calendar(db, body.provider)


# --------------------------------------------------------------------------
# OAuth connections
# --------------------------------------------------------------------------


@app.get("/api/connections")
async def list_connections(db: AsyncSession = Depends(session)) -> dict[str, bool]:
    """Which providers have a stored, usable token — what the Connect page
    renders as "Connected" instead of guessing from browser state."""
    connected = await oauth.connected_providers(db)
    return {provider: provider in connected for provider in oauth.PROVIDERS}


@app.delete("/api/connections/{provider}")
async def disconnect(provider: str, db: AsyncSession = Depends(session)) -> Response:
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail=f"unknown provider {provider!r}")
    await oauth.forget_token(db, provider)
    return Response(status_code=204)


def _connect_redirect(web: str, **params: str) -> RedirectResponse:
    """A redirect to the Connect page's status banner.

    `error` in particular carries text from outside the process — the OAuth
    provider's own callback query string, which anyone can hit directly with
    any value they like, not only a real provider. Building the URL with an
    f-string let that value break out of the query string; `urlencode` is what
    keeps it confined to the `error` parameter's value.
    """
    return RedirectResponse(url=f"{web}/settings?{urlencode(params)}")


@app.get("/api/auth/{provider}")
async def auth_redirect(provider: str) -> RedirectResponse:
    cfg = settings()
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail=f"unknown provider {provider!r}")

    client_id, client_secret = oauth.client_credentials(cfg, provider)
    if not client_id or not client_secret:
        return _connect_redirect(
            cfg.public_web_url, status="credentials_missing", provider=provider
        )
    state = oauth.new_state()
    return RedirectResponse(url=oauth.authorize_url(cfg, provider, state))


@app.get("/api/auth/callback/{provider}")
async def auth_callback(
    provider: str,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: AsyncSession = Depends(session),
) -> RedirectResponse:
    cfg = settings()
    web = cfg.public_web_url
    if provider not in oauth.PROVIDERS:
        raise HTTPException(status_code=404, detail=f"unknown provider {provider!r}")
    if error:
        return _connect_redirect(web, status="error", error=error)
    if not code or not state or not oauth.consume_state(state):
        # A missing or already-used state is what a replayed or forged
        # callback looks like — reject it rather than trust a bare code.
        return _connect_redirect(
            web, status="error", error="Invalid or expired authorization request"
        )

    try:
        token = await oauth.exchange_code(cfg, provider, code)
    except oauth.OAuthError as exc:
        return _connect_redirect(web, status="error", error=str(exc))

    await oauth.save_token(db, provider, token)
    # The token stays server-side — never appended here, never handed to the
    # browser. The frontend learns the connection succeeded and asks the
    # relevant /api/sync/* endpoint to use it.
    return _connect_redirect(web, status="success", provider=provider)


# --------------------------------------------------------------------------
# Booking links
# --------------------------------------------------------------------------

MIN_BOOKING_MINUTES = 15
MAX_BOOKING_MINUTES = 8 * 60


class FreeSlot(BaseModel):
    start: datetime
    end: datetime


@app.get("/api/availability")
async def availability(
    minutes: int = 30, days: int = 7, db: AsyncSession = Depends(session)
) -> list[FreeSlot]:
    """Openings a guest may book, inside the configured working window.

    "True free time": only real commitments close a slot. Horolog's own blocks
    are movable by construction, so offering an hour that currently holds focus
    time is not a double-booking — accepting it pushes that focus time
    elsewhere. Hiding those hours would hand a booking link a calendar that
    looks full while the day is actually open, which is the exact failure the
    scheduler exists to prevent.
    """
    if not MIN_BOOKING_MINUTES <= minutes <= MAX_BOOKING_MINUTES:
        raise HTTPException(
            status_code=422,
            detail=f"minutes must be between {MIN_BOOKING_MINUTES} and {MAX_BOOKING_MINUTES}",
        )
    cfg = settings()
    if not 1 <= days <= cfg.horizon_days:
        raise HTTPException(
            status_code=422, detail=f"days must be between 1 and {cfg.horizon_days}"
        )

    base = origin()
    need = minutes_to_slots(minutes)
    taken = bytearray(days * SLOTS_PER_DAY)
    for event in merge_busy(await _busy(db)):
        for slot in range(max(event.start_slot, 0), min(event.end_slot, len(taken))):
            taken[slot] = 1

    # Nothing in the past: `origin` is midnight, so most of today is behind us.
    # `to_slot` floors to the slot containing the current instant. That slot's
    # start is already in the past (except for an impossible zero-microsecond
    # race), so availability must begin at the following boundary.
    now_slot = to_slot(datetime.now(cfg.zone), base) + 1
    workday_start_min, workday_end_min = await _preferred_workday(db)
    window = (
        workday_start_min // SLOT_MINUTES,
        workday_end_min // SLOT_MINUTES,
    )
    out: list[FreeSlot] = []
    for day in range(days):
        day_lo = day * SLOTS_PER_DAY
        # Step by the meeting length so the offered slots tile the day rather
        # than overlap — two adjacent offers that cannot both be taken are a
        # booking page that contradicts itself.
        for start in range(day_lo + window[0], day_lo + window[1] - need + 1, need):
            if start < now_slot or any(taken[start : start + need]):
                continue
            out.append(FreeSlot(start=from_slot(start, base), end=from_slot(start + need, base)))
    return out


class BookIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(default="", max_length=200)
    start: LocalDateTime
    minutes: int = 30


class _RateLimiter:
    """A fixed window per key. Everything else here has no auth by design —
    a self-hosted single-user tool has no accounts to protect — but a booking
    link is deliberately the one URL meant to be handed to strangers, and
    unlike the rest of the API it writes to the calendar on every call. That
    combination is worth a floor.

    ponytail: in-process, unbounded by IP count. Fine for what a booking page
    actually receives; move to a real store if this ever runs multi-worker.
    """

    def __init__(self, limit: int, window_s: float) -> None:
        self._limit = limit
        self._window_s = window_s
        self._hits: dict[str, list[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self._window_s
        recent = [t for t in self._hits.get(key, []) if t > cutoff]
        if len(recent) >= self._limit:
            self._hits[key] = recent
            return False
        recent.append(now)
        self._hits[key] = recent
        return True


_booking_limiter = _RateLimiter(limit=5, window_s=600)
"""5 bookings per IP per 10 minutes — enough for a real guest picking a slot,
retrying after a race, and correcting a typo; not enough to fill a calendar."""


@app.post("/api/book", status_code=201)
async def book(
    body: BookIn, request: Request, db: AsyncSession = Depends(session)
) -> dict[str, Any]:
    """Accept a booking from a shared link.

    The booking lands in the busy mirror, not the intent list, because a guest's
    commitment is exactly as immovable as any other real meeting — that is what
    makes the surrounding flexible work reschedule around it instead of the
    other way round.
    """
    client_ip = request.client.host if request.client else "unknown"
    if not _booking_limiter.allow(client_ip):
        raise HTTPException(status_code=429, detail="too many booking attempts, try again shortly")
    if not MIN_BOOKING_MINUTES <= body.minutes <= MAX_BOOKING_MINUTES:
        raise HTTPException(status_code=422, detail="unsupported meeting length")

    base = origin()
    start = to_slot(body.start, base)
    end = start + minutes_to_slots(body.minutes)
    if start < to_slot(datetime.now(settings().zone), base):
        raise HTTPException(status_code=409, detail="that time has already passed")
    if end > horizon_slots():
        raise HTTPException(
            status_code=422,
            detail=f"bookings only go {settings().horizon_days} days out",
        )
    for event in merge_busy(await _busy(db)):
        if start < event.end_slot and event.start_slot < end:
            raise HTTPException(
                status_code=409, detail="that slot was taken while you were choosing"
            )

    who = f"{body.name} <{body.email}>" if body.email else body.name
    db.add(
        BusyRow(
            id=f"booking:{uuid.uuid4().hex[:12]}",
            source="booking",
            label=f"Booked: {who}"[:200],
            start_slot=start,
            end_slot=end,
        )
    )
    await db.commit()
    plan = await _replan(db)
    return {
        "start": from_slot(start, base).isoformat(),
        "end": from_slot(end, base).isoformat(),
        "rescheduled_blocks": sum(1 for b in plan.blocks if b.moved_from is not None),
    }


@app.get("/api/plan.ics")
async def export_ics(db: AsyncSession = Depends(session)) -> Response:
    """Subscribe to the plan from any calendar app, read-only.

    The safest possible write path: a subscribing client can render the plan but
    can never corrupt the calendar it was derived from.
    """
    base = origin()
    plan = await load_previous_plan(db) or await _replan(db)
    titles = {i.id: i.title for i in await load_intents(db)}
    body = to_ics(
        [
            (
                titles.get(b.intent_id, b.intent_id),
                from_slot(b.start_slot, base),
                from_slot(b.end_slot, base),
            )
            for b in plan.blocks
        ]
    )
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"content-disposition": 'attachment; filename="horolog.ics"'},
    )


@app.get("/api/stream")
async def stream() -> EventSourceResponse:
    async def events() -> AsyncIterator[dict[str, str]]:
        async with bus.subscribe() as queue:
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=20)
                except TimeoutError:
                    # Proxies drop idle connections; a comment frame keeps the
                    # stream alive without inventing a fake domain event.
                    yield {"event": "ping", "data": "{}"}
                    continue
                yield {"event": "plan", "data": payload}

    return EventSourceResponse(events())


# --------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------


async def _sync_connected_calendars(db: AsyncSession) -> None:
    """Re-mirror every connected Google/Outlook account.

    Same `_mirror()` path a manual Sync click uses, so this behaves identically
    from the frontend's perspective (SSE broadcast included) — the only
    difference is what triggers it. One provider failing must never stop the
    other or the next tick, so failures are caught here rather than raised.

    Deliberately broad: `_mirror` only ever *means* to raise `HTTPException`
    (it wraps every `SyncError` from the provider), but an upstream API
    returning a malformed body raises `json.JSONDecodeError` before it ever
    becomes a `SyncError` — narrower than `Exception` and this loop silently
    dies on the first bad response and never recovers, with no request/response
    cycle left afterwards for anyone to notice from. A scheduled tick must
    survive whatever a single provider does to it.
    """
    connected = await oauth.connected_providers(db)
    for provider_name in oauth.CALENDAR_PROVIDERS:
        if provider_name not in connected:
            continue
        token = await oauth.valid_access_token(db, settings(), provider_name)
        if not token:
            continue
        provider: CalendarProvider = (
            GoogleCalendarProvider(token, settings().zone)
            if provider_name == "google"
            else OutlookCalendarProvider(token, settings().zone)
        )
        try:
            await _mirror(db, provider, provider_name)
        except Exception as exc:  # see docstring: a scheduled tick must never kill the loop
            print(f"background sync: {provider_name} failed: {exc}", file=sys.stderr)


async def _push_connected_calendars(db: AsyncSession) -> None:
    """Push the plan onto every connected calendar, when write-back is on.

    Same resilience shape as `_sync_connected_calendars`: one provider's
    failure (an expired token, an unreachable API) must not stop the other or
    the next tick.
    """
    if not settings().calendar_writeback_enabled:
        return
    connected = await oauth.connected_providers(db)
    for provider_name in oauth.CALENDAR_PROVIDERS:
        if provider_name not in connected:
            continue
        try:
            await _push_calendar(db, provider_name)
        except Exception as exc:  # a scheduled tick must never kill the loop
            print(f"background push: {provider_name} failed: {exc}", file=sys.stderr)


async def _sync_loop() -> None:
    """Background heartbeat started from `lifespan()`.

    A fresh session per tick, not a request-scoped one — nothing here runs
    inside a request. `asynccontextmanager` turns the same `session()`
    generator the HTTP layer uses via `Depends` into a plain context manager,
    so this needs no new session-creation code in `db.py`.
    """
    interval_s = settings().sync_interval_minutes * 60
    while True:
        await asyncio.sleep(interval_s)
        async with asynccontextmanager(session)() as db:
            await _sync_connected_calendars(db)
            await _push_connected_calendars(db)


async def _mirror(db: AsyncSession, provider: CalendarProvider, source: str) -> dict[str, int]:
    """Replace the mirror for one source, then re-plan.

    Replace rather than merge: the mirror is meant to be an exact reflection of
    the upstream calendar, so a meeting deleted there has to free its slot here.
    Scoped to `source` so syncing an ICS feed does not wipe CalDAV events.
    """
    try:
        events = await provider.fetch(origin(), settings().horizon_days)
    except SyncError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await db.execute(delete(BusyRow).where(BusyRow.source == source))
    for event in events:
        db.add(
            BusyRow(
                id=f"{source}:{uuid.uuid4().hex[:12]}",
                source=source,
                label=event.label,
                start_slot=event.start_slot,
                end_slot=event.end_slot,
            )
        )
    await db.commit()
    plan = await _replan(db)
    return {"events": len(events), "blocks": len(plan.blocks)}


async def _push_calendar(db: AsyncSession, provider_name: str) -> dict[str, int]:
    """Diff the current plan against `synced_blocks` for one provider and
    apply only what changed on that provider's dedicated "Horolog" calendar —
    create, move, or remove one event per block that actually differs.

    This is the write-side payoff of two-pass placement: the same property
    that limits a re-solve to moving only the blocks actually hit limits a
    push to one API call per block actually hit, not a wipe-and-recreate of
    the whole calendar.
    """
    token = await oauth.valid_access_token(db, settings(), provider_name)
    if not token:
        raise HTTPException(status_code=409, detail=f"{provider_name} is not connected")

    writer: GoogleCalendarWriter | OutlookCalendarWriter = (
        GoogleCalendarWriter(token) if provider_name == "google" else OutlookCalendarWriter(token)
    )

    plan = await load_previous_plan(db) or await _replan(db)
    base = origin()
    titles = {i.id: i for i in await load_intents(db)}
    current: dict[tuple[str, int, int], tuple[int, int, str]] = {
        b.key: (
            b.start_slot,
            b.end_slot,
            titles[b.intent_id].title if b.intent_id in titles else b.intent_id,
        )
        for b in plan.blocks
    }

    rows = list(
        (await db.execute(select(SyncedBlockRow).where(SyncedBlockRow.provider == provider_name)))
        .scalars()
        .all()
    )

    created = moved = removed = 0
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            calendar_id = await writer.ensure_calendar(client)
        except SyncError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        # Every stored row points at the calendar that existed on the last
        # push. If that no longer matches, the user deleted the Horolog
        # calendar in the meantime and `ensure_calendar` just made a fresh
        # one — every `event_id` below is dead. Forget them rather than
        # silently treating an unmoved slot as "already written".
        if rows and rows[0].calendar_id != calendar_id:
            for row in rows:
                await db.delete(row)
            rows = []

        synced = {(r.intent_id, r.occurrence, r.chunk): r for r in rows}
        creates = [key for key in current if key not in synced]
        updates = [
            key
            for key in current
            if key in synced and (synced[key].start_slot, synced[key].end_slot) != current[key][:2]
        ]
        deletes = [key for key in synced if key not in current]

        ops = creates + updates + deletes
        if len(ops) > MAX_PUSH_OPS:
            keep = set(ops[:MAX_PUSH_OPS])
            creates = [k for k in creates if k in keep]
            updates = [k for k in updates if k in keep]
            deletes = [k for k in deletes if k in keep]

        for key in creates:
            intent_id, occurrence, chunk = key
            start_slot, end_slot, title = current[key]
            try:
                event_id = await writer.create_event(
                    client,
                    calendar_id,
                    title,
                    from_slot(start_slot, base),
                    from_slot(end_slot, base),
                )
            except SyncError as exc:
                logger.warning(
                    "push %s: could not create event for %r: %s", provider_name, title, exc
                )
                continue
            db.add(
                SyncedBlockRow(
                    provider=provider_name,
                    intent_id=intent_id,
                    occurrence=occurrence,
                    chunk=chunk,
                    calendar_id=calendar_id,
                    event_id=event_id,
                    start_slot=start_slot,
                    end_slot=end_slot,
                )
            )
            created += 1

        for key in updates:
            row = synced[key]
            start_slot, end_slot, _ = current[key]
            try:
                await writer.patch_event(
                    client,
                    calendar_id,
                    row.event_id,
                    from_slot(start_slot, base),
                    from_slot(end_slot, base),
                )
            except SyncError as exc:
                logger.warning(
                    "push %s: could not move event %s: %s", provider_name, row.event_id, exc
                )
                continue
            row.start_slot, row.end_slot = start_slot, end_slot
            moved += 1

        for key in deletes:
            row = synced[key]
            try:
                await writer.delete_event(client, calendar_id, row.event_id)
            except SyncError as exc:
                logger.warning(
                    "push %s: could not remove event %s: %s", provider_name, row.event_id, exc
                )
                continue
            await db.delete(row)
            removed += 1

    await db.commit()
    return {"created": created, "moved": moved, "removed": removed}


async def _busy(db: AsyncSession) -> list[BusyInterval]:
    """Every interval the calendar is already spoken for.

    The single place the mirror is read, so the solver, the analytics page, the
    booking page and the planner grid can never disagree about what is occupied.
    Decompression buffers are derived here rather than stored: they are a
    function of the meetings, and persisting them would leave orphans behind
    every time a meeting moved.
    """
    rows = (await db.execute(select(BusyRow))).scalars().all()
    busy = [
        BusyInterval(
            source_id=row.id, start_slot=row.start_slot, end_slot=row.end_slot, label=row.label
        )
        for row in rows
    ]
    cfg = settings()
    if cfg.auto_buffer_enabled:
        busy += decompression_buffers(busy, cfg.auto_buffer_minutes)
    return busy


async def _replan(db: AsyncSession) -> Plan:
    intents = await load_intents(db)
    plan = solve(
        intents,
        await _busy(db),
        horizon_slots(),
        previous=await load_previous_plan(db),
        origin_weekday=origin().weekday(),
        origin_at=origin(),
    )
    await save_plan(db, plan)
    bus.publish(json.dumps({"blocks": len(plan.blocks), "solve_ms": round(plan.solve_ms, 2)}))
    return plan


async def _render(db: AsyncSession, plan: Plan) -> PlanOut:
    base = origin()
    titles = {i.id: i for i in await load_intents(db)}
    rows = (await db.execute(select(BusyRow))).scalars().all()
    sources = {row.id: row.source for row in rows}
    rendered_blocks = [
        BlockOut(
            intent_id=b.intent_id,
            title=titles[b.intent_id].title if b.intent_id in titles else b.intent_id,
            kind=titles[b.intent_id].kind if b.intent_id in titles else IntentKind.TASK,
            priority=b.priority,
            category=titles[b.intent_id].category if b.intent_id in titles else None,
            occurrence=b.occurrence,
            chunk=b.chunk,
            start=from_slot(b.start_slot, base),
            end=from_slot(b.end_slot, base),
            moved_from=from_slot(b.moved_from, base) if b.moved_from is not None else None,
            completed=False,
            recurring=(
                titles[b.intent_id].period_days is not None if b.intent_id in titles else False
            ),
        )
        for b in plan.blocks
    ]

    # Completed blocks no longer consume solver capacity, but remain visible
    # in the calendar as historical, completed occurrences.
    for intent in titles.values():
        for index, completed in enumerate(intent.completed_blocks):
            rendered_blocks.append(
                BlockOut(
                    intent_id=intent.id,
                    title=intent.title,
                    kind=intent.kind,
                    priority=intent.priority,
                    category=intent.category,
                    occurrence=-(index + 1),
                    chunk=0,
                    start=completed.start,
                    end=completed.end,
                    moved_from=None,
                    completed=True,
                    recurring=intent.period_days is not None,
                )
            )

    return PlanOut(
        blocks=rendered_blocks,
        unmet=[
            UnmetOut(
                intent_id=u.intent_id,
                title=titles[u.intent_id].title if u.intent_id in titles else u.intent_id,
                priority=u.priority,
                shortfall_minutes=u.shortfall_slots * 15,
            )
            for u in plan.unmet
        ],
        busy=[
            BusyIn(
                label=event.label,
                # Derived buffers have no row of their own; the grid still has
                # to show them, or time disappears with no visible reason.
                source=sources.get(event.source_id, BUFFER_SOURCE),
                start=from_slot(event.start_slot, base),
                end=from_slot(event.end_slot, base),
            )
            for event in await _busy(db)
        ],
        solve_ms=plan.solve_ms,
        complete=plan.complete,
        generated_at=datetime.now(UTC),
        origin=base,
        horizon_days=settings().horizon_days,
    )


__all__ = ["app", "minutes_to_slots", "timedelta"]
