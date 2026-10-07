"""Persistence.

Three tables. Plans are not one of them in the usual sense: a plan is derived,
and deriving it costs single-digit milliseconds, so it is recomputed rather than
stored as rows. The previous plan *is* kept — as one JSON blob — because the
placement engine needs it to stay stable across re-solves.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
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


class UserSettingsRow(Base):
    """Persistent single-user preferences editable from the Settings page."""

    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    preferred_workday_start_min: Mapped[int | None] = mapped_column(Integer, default=None)
    preferred_workday_end_min: Mapped[int | None] = mapped_column(Integer, default=None)
    updated_at: Mapped[datetime] = mapped_column(
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


async def session() -> AsyncIterator[AsyncSession]:
    async with _session_factory()() as db:
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
