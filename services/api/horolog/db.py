"""Persistence.

Three tables. Plans are not one of them in the usual sense: a plan is derived,
and deriving it costs single-digit milliseconds, so it is recomputed rather than
stored as rows. The previous plan *is* kept — as one JSON blob — because the
placement engine needs it to stay stable across re-solves.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, Text, select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from horolog.domain.intent import Intent
from horolog.domain.plan import Plan
from horolog.domain.time import SLOTS_PER_DAY
from horolog.settings import settings


class Base(DeclarativeBase):
    pass


class IntentRow(Base):
    __tablename__ = "intents"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    """The full validated Intent. Stored whole rather than shredded into columns:
    the Pydantic model is the schema of record, and a second copy of it in DDL
    would be a second thing to keep in sync."""
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )

    def to_domain(self) -> Intent:
        return Intent.model_validate(self.payload)


class BusyRow(Base):
    __tablename__ = "busy_events"

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    source: Mapped[str] = mapped_column(String(32), default="manual")
    """Which provider supplied it: `manual`, `caldav`, `google`."""
    label: Mapped[str] = mapped_column(String(256), default="")
    start_slot: Mapped[int] = mapped_column(Integer, index=True)
    end_slot: Mapped[int] = mapped_column(Integer)


class PlanRow(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload: Mapped[str] = mapped_column(Text)
    saved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class SlotOriginRow(Base):
    """Calendar date used as slot zero for all persisted relative slot values.

    Horolog stores compact integer slots. Because the local scheduling origin
    advances at midnight, persisted slots must be rebased exactly once when
    the local date changes or a block stored for tomorrow jumps another day.
    """

    __tablename__ = "slot_origin"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    origin_date: Mapped[str] = mapped_column(String(10))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class UserSettingsRow(Base):
    """Persistent single-user preferences editable from the Settings page."""

    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    preferred_workday_start_min: Mapped[int | None] = mapped_column(Integer, default=None)
    preferred_workday_end_min: Mapped[int | None] = mapped_column(Integer, default=None)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class NotificationSettingsRow(Base):
    """Persistent notification preferences consumed by mobile clients."""

    __tablename__ = "notification_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    task_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    task_minutes_before: Mapped[int] = mapped_column(Integer, default=15)
    task_at_start: Mapped[bool] = mapped_column(Boolean, default=True)

    meeting_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    meeting_minutes_before: Mapped[int] = mapped_column(Integer, default=15)
    meeting_at_start: Mapped[bool] = mapped_column(Boolean, default=True)

    deadline_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    deadline_days_before: Mapped[int] = mapped_column(Integer, default=1)
    deadline_time_min: Mapped[int] = mapped_column(Integer, default=9 * 60)

    end_of_day_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    end_of_day_time_min: Mapped[int] = mapped_column(Integer, default=20 * 60 + 30)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class ChangeSetRow(Base):
    """One reversible group of planning changes.

    The single-user app snapshots only planning state, never credentials or
    settings. Assistant batches are stored as one row so Undo restores the
    whole user-visible operation rather than individual low-level writes.
    """

    __tablename__ = "change_sets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source: Mapped[str] = mapped_column(String(32), index=True)
    title: Mapped[str] = mapped_column(String(300))
    summary: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    before_state: Mapped[dict[str, Any]] = mapped_column(JSON)
    after_state: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), index=True
    )
    undone_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )


class TimeEntryRow(Base):
    """One real-work timer session attached to an existing Horolog intent."""

    __tablename__ = "time_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    intent_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    last_resumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    accumulated_seconds: Mapped[int] = mapped_column(Integer, default=0)
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class OAuthTokenRow(Base):
    """A connected account's access token.

    Kept server-side and never handed to the browser: a token riding in a
    redirect URL lands in browser history, `Referer` headers and reverse-proxy
    logs, and a token in `localStorage` is readable by anything that can run a
    script on the page. Neither is necessary when the backend can hold the
    token itself and let the frontend simply ask it to sync.
    """

    __tablename__ = "oauth_tokens"

    provider: Mapped[str] = mapped_column(String(16), primary_key=True)
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str | None] = mapped_column(Text, default=None)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class SyncedBlockRow(Base):
    """One scheduled block already mirrored onto an external calendar as a
    real event — state for the write-back diff, not a cache.

    `api.py`'s `_push_calendar` compares the current plan against these rows
    on every push: a key present in both with the same slots needs no call at
    all, a changed key needs one PATCH, a vanished key needs one DELETE. That
    is the entire reason two-pass placement bounding churn to "only the
    blocks actually hit" matters on the write side too — without this table
    every push would be a full delete-and-recreate of every event.
    """

    __tablename__ = "synced_blocks"

    provider: Mapped[str] = mapped_column(String(16), primary_key=True)
    intent_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    occurrence: Mapped[int] = mapped_column(Integer, primary_key=True)
    chunk: Mapped[int] = mapped_column(Integer, primary_key=True)
    calendar_id: Mapped[str] = mapped_column(String(256))
    """Which calendar `event_id` lives on. Compared against the freshly
    resolved calendar on every push (`api.py`'s `_push_calendar`) — if they
    differ, the user deleted the Horolog calendar since the last push, every
    `event_id` here is dead, and the rows are discarded rather than trusted."""
    event_id: Mapped[str] = mapped_column(String(256))
    start_slot: Mapped[int] = mapped_column(Integer)
    end_slot: Mapped[int] = mapped_column(Integer)


class TodoInboxRow(Base):
    """Unclassified task captured before an Eisenhower decision is made."""

    __tablename__ = "todo_inbox"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(300))
    minutes: Mapped[int] = mapped_column(Integer, default=30)
    category: Mapped[str | None] = mapped_column(String(32), default=None)
    deadline_date: Mapped[str | None] = mapped_column(String(10), default=None, index=True)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class DailyItemMetaRow(Base):
    """Optional metadata that should not force a migration of daily_plan_items."""

    __tablename__ = "daily_item_meta"

    item_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    deadline_date: Mapped[str | None] = mapped_column(String(10), default=None)


class DailyPlanRow(Base):
    """One day's deliberate plan: the win condition and the first action."""

    __tablename__ = "daily_plans"

    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    win_condition: Mapped[str] = mapped_column(Text, default="")
    first_step: Mapped[str] = mapped_column(Text, default="")
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class DailyPlanItemRow(Base):
    """A deliberate Eisenhower item.

    The row is never copied forward. An unfinished item remains active and is
    projected into every later Daily view until it is completed or cancelled,
    which gives rollover history without creating duplicate tasks.
    """

    __tablename__ = "daily_plan_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    plan_date: Mapped[str] = mapped_column(String(10), index=True)
    title: Mapped[str] = mapped_column(String(300))
    quadrant: Mapped[int] = mapped_column(Integer)
    minutes: Mapped[int] = mapped_column(Integer, default=30)
    priority: Mapped[int] = mapped_column(Integer, default=3)
    category: Mapped[str | None] = mapped_column("energy", String(16), default=None)
    intent_id: Mapped[str | None] = mapped_column(String(64), default=None, index=True)
    schedule_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class DailyItemDecisionRow(Base):
    """Temporary rollover decisions without mutating an item's original date.

    Keeping the original DailyPlanItemRow.plan_date intact preserves history.
    This row only records that the user consciously deferred an item or already
    confirmed that a stale item still matters on a particular day.
    """

    __tablename__ = "daily_item_decisions"

    item_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    defer_until: Mapped[str | None] = mapped_column(String(10), default=None)
    acknowledged_date: Mapped[str | None] = mapped_column(String(10), default=None)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class DailyReviewRow(Base):
    """The six end-of-day reflection prompts, one editable row per date."""

    __tablename__ = "daily_reviews"

    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    did_well: Mapped[str] = mapped_column(Text, default="")
    grateful_for: Mapped[str] = mapped_column(Text, default="")
    would_change: Mapped[str] = mapped_column(Text, default="")
    learned: Mapped[str] = mapped_column(Text, default="")
    improve_tomorrow: Mapped[str] = mapped_column(Text, default="")
    first_step_morning: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


@lru_cache(maxsize=1)
def _engine() -> AsyncEngine:
    return create_async_engine(settings().database_url, future=True)


@lru_cache(maxsize=1)
def _session_factory() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(_engine(), expire_on_commit=False)


LATEST_PLAN_ID = 1
_slot_origin_lock = asyncio.Lock()
"""Single-user deployment: one current plan. Becomes a user foreign key when
multi-tenancy arrives; nothing else in the schema has to change."""


async def init_db() -> None:
    """Create any missing tables.

    Lazily building the engine here (rather than at import time) means a bad
    `HOROLOG_DATABASE_URL` — wrong scheme, unreachable host, wrong credentials
    — surfaces as one readable message instead of a bare SQLAlchemy/asyncpg
    traceback the first time anything touches the database.
    """
    try:
        async with _engine().begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as exc:
        raise RuntimeError(
            "Horolog could not set up the database at startup.\n\n"
            f"  {type(exc).__name__}: {exc}\n\n"
            "  Likely causes:\n"
            "    - HOROLOG_DATABASE_URL in .env is malformed or uses the wrong scheme\n"
            "    - Postgres isn't up yet - `docker compose -f infra/docker-compose.yml up db`\n"
            "    - wrong username, password, or database name\n"
            "    - using Postgres without the driver installed - "
            "`uv pip install -e '.[dev,postgres]'`\n\n"
            "  See .env.example for the expected HOROLOG_DATABASE_URL format."
        ) from exc


def _shift_intent_payload_slots(
    payload: dict[str, Any],
    offset: int,
) -> dict[str, Any]:
    shifted = dict(payload)
    for field in ("earliest_slot", "latest_slot", "due_slot"):
        value = shifted.get(field)
        if isinstance(value, int):
            shifted[field] = value - offset

    blocked = shifted.get("blocked_slots")
    if isinstance(blocked, list):
        shifted["blocked_slots"] = [
            [int(span[0]) - offset, int(span[1]) - offset]
            for span in blocked
            if isinstance(span, (list, tuple)) and len(span) == 2
        ]
    return shifted


def _shift_snapshot_slots(
    snapshot: dict[str, Any],
    offset: int,
    intent_offsets: dict[str, int] | None = None,
) -> dict[str, Any]:
    shifted = json.loads(json.dumps(snapshot))
    intents = shifted.get("intents")
    if isinstance(intents, list):
        for item in intents:
            if not isinstance(item, dict):
                continue
            payload = item.get("payload")
            intent_id = item.get("id")
            item_offset = (intent_offsets or {}).get(intent_id, offset)
            if isinstance(payload, dict):
                item["payload"] = _shift_intent_payload_slots(payload, item_offset)
    return shifted


async def rebase_slot_origin(
    db: AsyncSession,
    target_date: str,
) -> int:
    """Move all persisted relative slots when the local day advances."""

    target = datetime.strptime(target_date, "%Y-%m-%d").date()
    meta = await db.get(SlotOriginRow, LATEST_PLAN_ID)
    per_intent_days: dict[str, int] = {}

    if meta is None:
        plan_row = await db.get(PlanRow, LATEST_PLAN_ID)
        if plan_row is not None:
            saved_at = plan_row.saved_at
            if saved_at.tzinfo is None:
                saved_at = saved_at.replace(tzinfo=UTC)
            saved_candidate = saved_at.astimezone(settings().zone).date()
            inferred = saved_candidate

            # Legacy databases did not persist the slot origin. Recover it
            # from deliberate Daily dates when possible: the candidate origin
            # that makes the most linked plan blocks land on their intended
            # Daily date is stronger evidence than the plan save timestamp.
            try:
                plan_payload = json.loads(plan_row.payload)
                daily_rows = (
                    await db.execute(select(DailyPlanItemRow))
                ).scalars().all()
                decision_rows = (
                    await db.execute(select(DailyItemDecisionRow))
                ).scalars().all()
                decisions = {row.item_id: row for row in decision_rows}
                expected: dict[str, set[str]] = {}
                for row in daily_rows:
                    if not row.intent_id or row.cancelled_at is not None:
                        continue
                    decision = decisions.get(row.id)
                    expected_date = (
                        decision.defer_until
                        if decision is not None and decision.defer_until
                        else row.plan_date
                    )
                    expected.setdefault(row.intent_id, set()).add(expected_date)

                candidates = []
                for candidate in (
                    saved_candidate,
                    target,
                    target - timedelta(days=1),
                    target - timedelta(days=2),
                ):
                    if candidate not in candidates:
                        candidates.append(candidate)

                def score(candidate: Any) -> int:
                    matches = 0
                    for block in plan_payload.get("blocks", []):
                        if not isinstance(block, dict):
                            continue
                        intent_id = block.get("intent_id")
                        start_slot = block.get("start_slot")
                        if intent_id not in expected or not isinstance(start_slot, int):
                            continue
                        predicted = (
                            candidate + timedelta(days=start_slot // SLOTS_PER_DAY)
                        ).isoformat()
                        if predicted in expected[intent_id]:
                            matches += 1
                    return matches

                scored = [(score(candidate), candidate) for candidate in candidates]
                best_score, best_candidate = max(
                    scored,
                    key=lambda item: (item[0], item[1] == saved_candidate),
                )
                if best_score > 0:
                    inferred = best_candidate

                # A few items may already have been manually corrected after
                # midnight while untouched items still use yesterday as slot
                # zero. Recover those origins per intent so migration cannot
                # move an already-corrected task backwards.
                candidate_counts: dict[str, dict[Any, int]] = {}
                for block in plan_payload.get("blocks", []):
                    if not isinstance(block, dict):
                        continue
                    intent_id = block.get("intent_id")
                    start_slot = block.get("start_slot")
                    dates = expected.get(intent_id)
                    if not dates or not isinstance(start_slot, int):
                        continue
                    day_index = start_slot // SLOTS_PER_DAY
                    counts = candidate_counts.setdefault(intent_id, {})
                    for expected_date in dates:
                        intended = datetime.strptime(expected_date, "%Y-%m-%d").date()
                        candidate = intended - timedelta(days=day_index)
                        counts[candidate] = counts.get(candidate, 0) + 1

                for intent_id, counts in candidate_counts.items():
                    candidate = max(
                        counts,
                        key=lambda item: (counts[item], item == saved_candidate),
                    )
                    per_intent_days[intent_id] = max(0, (target - candidate).days)
            except (TypeError, ValueError, json.JSONDecodeError):
                inferred = saved_candidate
        else:
            inferred = target

        meta = SlotOriginRow(
            id=LATEST_PLAN_ID,
            origin_date=inferred.isoformat(),
            updated_at=datetime.now(UTC),
        )
        db.add(meta)
        await db.commit()

    stored = datetime.strptime(meta.origin_date, "%Y-%m-%d").date()
    days = max(0, (target - stored).days)
    if days == 0 and not any(value > 0 for value in per_intent_days.values()):
        return 0

    offset = days * SLOTS_PER_DAY
    intent_offsets = {
        intent_id: item_days * SLOTS_PER_DAY
        for intent_id, item_days in per_intent_days.items()
    }

    intent_rows = (await db.execute(select(IntentRow))).scalars().all()
    for row in intent_rows:
        row.payload = _shift_intent_payload_slots(
            row.payload,
            intent_offsets.get(row.id, offset),
        )

    busy_rows = (await db.execute(select(BusyRow))).scalars().all()
    for row in busy_rows:
        start = row.start_slot - offset
        end = row.end_slot - offset
        if end <= 0:
            await db.delete(row)
            continue
        row.start_slot = max(0, start)
        row.end_slot = end

    plan_row = await db.get(PlanRow, LATEST_PLAN_ID)
    if plan_row is not None:
        payload = json.loads(plan_row.payload)
        blocks: list[dict[str, Any]] = []
        for raw in payload.get("blocks", []):
            if not isinstance(raw, dict):
                continue
            block = dict(raw)
            block_offset = intent_offsets.get(block.get("intent_id"), offset)
            end = int(block.get("end_slot", 0)) - block_offset
            if end <= 0:
                continue
            start = int(block.get("start_slot", 0)) - block_offset
            block["start_slot"] = max(0, start)
            block["end_slot"] = end
            moved_from = block.get("moved_from")
            if isinstance(moved_from, int):
                moved = moved_from - block_offset
                block["moved_from"] = moved if moved >= 0 else None
            blocks.append(block)
        payload["blocks"] = blocks
        plan_row.payload = json.dumps(payload)

    synced_rows = (await db.execute(select(SyncedBlockRow))).scalars().all()
    for row in synced_rows:
        row_offset = intent_offsets.get(row.intent_id, offset)
        start = row.start_slot - row_offset
        end = row.end_slot - row_offset
        if end <= 0:
            await db.delete(row)
            continue
        row.start_slot = max(0, start)
        row.end_slot = end

    change_rows = (await db.execute(select(ChangeSetRow))).scalars().all()
    for row in change_rows:
        if row.before_state:
            row.before_state = _shift_snapshot_slots(row.before_state, offset, intent_offsets)
        if row.after_state:
            row.after_state = _shift_snapshot_slots(row.after_state, offset, intent_offsets)

    meta.origin_date = target.isoformat()
    meta.updated_at = datetime.now(UTC)
    await db.commit()
    return max([days, *per_intent_days.values()], default=days)


async def ensure_slot_origin(db: AsyncSession) -> int:
    today = datetime.now(settings().zone).date().isoformat()
    async with _slot_origin_lock:
        return await rebase_slot_origin(db, today)


async def session() -> AsyncIterator[AsyncSession]:
    async with _session_factory()() as db:
        await ensure_slot_origin(db)
        yield db


async def load_intents(db: AsyncSession) -> list[Intent]:
    rows = (await db.execute(select(IntentRow))).scalars().all()
    return [row.to_domain() for row in rows]


async def load_previous_plan(db: AsyncSession) -> Plan | None:
    row = await db.get(PlanRow, LATEST_PLAN_ID)
    return Plan.model_validate(json.loads(row.payload)) if row else None


async def save_plan(db: AsyncSession, plan: Plan) -> None:
    row = await db.get(PlanRow, LATEST_PLAN_ID)
    if row is None:
        db.add(PlanRow(id=LATEST_PLAN_ID, payload=plan.model_dump_json()))
    else:
        row.payload = plan.model_dump_json()
        row.saved_at = datetime.now(UTC)
    await db.commit()
