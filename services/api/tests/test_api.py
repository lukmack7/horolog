"""End-to-end HTTP tests against an in-process app and a temp database."""

from __future__ import annotations

import json
import os
import tempfile
import typing
from collections.abc import AsyncGenerator, AsyncIterator
from datetime import datetime, timedelta
from typing import cast
from zoneinfo import ZoneInfo

import httpx
import pytest
import pytest_asyncio

_tmpdir = tempfile.mkdtemp()
os.environ["HOROLOG_DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmpdir}/test.db"

from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from horolog.api import IntentIn, app, origin
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
    PlanRow,
    SlotOriginRow,
    TimeEntryRow,
    TodoInboxRow,
    UserSettingsRow,
    init_db,
    rebase_slot_origin,
    session,
)


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        for path in ("/api/intents",):
            for item in (await http.get(path)).json():
                await http.delete(f"/api/intents/{item['id']}")
        await http.put("/api/busy", json=[])
        # `PUT /api/busy` with an empty body only clears the "manual"
        # source by design (each sync source is its own independent
        # mirror) — but `db.py`'s `_engine`/`settings` are process-wide
        # `@lru_cache`s, so when the full suite runs in one pytest process,
        # whichever test file's database is touched first is what every
        # other file's tests actually hit. A "booking"-sourced busy row
        # left behind by test_integrations.py's booking tests can land
        # here too, so every source needs clearing, not just "manual".
        gen = cast("AsyncGenerator[AsyncSession, None]", session())
        db = await anext(gen)
        await db.execute(delete(BusyRow))
        await db.execute(delete(ChangeSetRow))
        await db.execute(delete(TimeEntryRow))
        await db.execute(delete(DailyItemDecisionRow))
        await db.execute(delete(DailyItemMetaRow))
        await db.execute(delete(DailyPlanItemRow))
        await db.execute(delete(TodoInboxRow))
        await db.execute(delete(DailyPlanRow))
        await db.execute(delete(DailyReviewRow))
        await db.execute(delete(NotificationSettingsRow))
        await db.execute(delete(UserSettingsRow))
        await db.commit()
        await gen.aclose()
        yield http


@pytest.mark.asyncio
async def test_assistant_execute_is_reversible_change_set(client: AsyncClient) -> None:
    tomorrow = (origin() + timedelta(days=1)).date().isoformat()

    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "create_task",
                    "title": "Atomic test task",
                    "date": tomorrow,
                    "minutes": 30,
                    "quadrant": 2,
                    "category": "cmr",
                }
            ]
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["atomic"] is True
    assert payload["change_set_id"]

    history = (await client.get("/api/history")).json()
    change = next(item for item in history if item["id"] == payload["change_set_id"])
    assert change["source"] == "assistant"
    assert change["can_undo"] is True

    undo = await client.post(f"/api/history/{payload['change_set_id']}/undo")
    assert undo.status_code == 200

    intents = (await client.get("/api/intents")).json()
    assert not any(item["title"] == "Atomic test task" for item in intents)


@pytest.mark.asyncio
async def test_assistant_execute_rolls_back_whole_batch_on_conflict(
    client: AsyncClient,
) -> None:
    tomorrow = (origin() + timedelta(days=1)).date().isoformat()
    actions = [
        {
            "action": "create_task",
            "title": "Atomic first",
            "date": tomorrow,
            "minutes": 30,
            "quadrant": 2,
            "start_min": 9 * 60,
            "start_mode": "fixed",
        },
        {
            "action": "create_task",
            "title": "Atomic conflicting second",
            "date": tomorrow,
            "minutes": 30,
            "quadrant": 2,
            "start_min": 9 * 60,
            "start_mode": "fixed",
        },
    ]

    response = await client.post("/api/assistant/execute", json={"actions": actions})
    assert response.status_code == 409

    intents = (await client.get("/api/intents")).json()
    titles = {item["title"] for item in intents}
    assert "Atomic first" not in titles
    assert "Atomic conflicting second" not in titles


@pytest.mark.asyncio
async def test_time_tracking_start_pause_resume_stop(client: AsyncClient) -> None:
    tomorrow = (origin() + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0)
    created = await client.post(
        "/api/intents",
        json={
            "title": "Measured work",
            "kind": "task",
            "priority": 2,
            "minutes_per_period": 60,
            "min_chunk_minutes": 60,
            "max_chunk_minutes": 60,
            "max_per_day": 1,
            "earliest": tomorrow.isoformat(),
            "due": (tomorrow + timedelta(hours=2)).isoformat(),
        },
    )
    assert created.status_code == 201
    intent_id = created.json()["id"]

    started = await client.post(f"/api/time-tracking/{intent_id}/start")
    assert started.status_code == 201
    assert started.json()["status"] == "running"

    paused = await client.post(f"/api/time-tracking/{intent_id}/pause")
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"

    resumed = await client.post(f"/api/time-tracking/{intent_id}/resume")
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "running"

    stopped = await client.post(f"/api/time-tracking/{intent_id}/stop")
    assert stopped.status_code == 200
    assert stopped.json()["status"] == "stopped"
    assert (await client.get("/api/time-tracking/active")).json() is None

    stats = (await client.get(f"/api/time-tracking/{intent_id}/stats")).json()
    assert stats["sessions"] == 1
    assert stats["suggested_minutes"] >= 15


@pytest.mark.asyncio
async def test_daily_close_is_recorded_and_undoable(client: AsyncClient) -> None:
    today = origin().date().isoformat()
    closed = await client.post(f"/api/daily/{today}/close")
    assert closed.status_code == 200
    payload = closed.json()
    assert payload["closed_at"]
    assert payload["change_set_id"]

    daily = (await client.get(f"/api/daily/{today}")).json()
    assert daily["plan"]["closed_at"] is not None

    undo = await client.post(f"/api/history/{payload['change_set_id']}/undo")
    assert undo.status_code == 200
    daily_after = (await client.get(f"/api/daily/{today}")).json()
    assert daily_after["plan"]["closed_at"] is None


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    assert (await client.get("/api/health")).json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_persisted_slots_rebase_once_when_local_day_advances(
    client: AsyncClient,
) -> None:
    gen = cast("AsyncGenerator[AsyncSession, None]", session())
    db = await anext(gen)
    try:
        await db.execute(delete(SlotOriginRow))
        await db.execute(delete(PlanRow))
        await db.execute(delete(IntentRow).where(IntentRow.id == "slot-origin-test"))
        await db.execute(delete(BusyRow).where(BusyRow.id == "slot-origin-busy"))

        db.add(SlotOriginRow(id=1, origin_date="2026-10-07"))
        db.add(
            IntentRow(
                id="slot-origin-test",
                payload={
                    "id": "slot-origin-test",
                    "kind": "task",
                    "title": "Pinned tomorrow",
                    "priority": 2,
                    "minutes_per_period": 90,
                    "period_days": None,
                    "min_chunk_minutes": 90,
                    "max_chunk_minutes": 90,
                    "max_per_day": 1,
                    "daily_windows": [{"start_min": 540, "end_min": 630}],
                    "allowed_weekdays": [],
                    "earliest_slot": 132,
                    "latest_slot": 138,
                    "due_slot": 138,
                    "preferred_start_min": 540,
                    "blocked_slots": [],
                },
            )
        )
        db.add(
            BusyRow(
                id="slot-origin-busy",
                source="manual",
                label="Busy",
                start_slot=140,
                end_slot=144,
            )
        )
        db.add(
            PlanRow(
                id=1,
                payload=json.dumps(
                    {
                        "blocks": [
                            {
                                "intent_id": "slot-origin-test",
                                "occurrence": 0,
                                "chunk": 0,
                                "start_slot": 132,
                                "end_slot": 138,
                                "priority": 2,
                                "moved_from": None,
                            }
                        ],
                        "unmet": [],
                        "solve_ms": 0.0,
                        "horizon_slots": 21 * 96,
                    }
                ),
            )
        )
        await db.commit()

        assert await rebase_slot_origin(db, "2026-10-08") == 1

        intent = await db.get(IntentRow, "slot-origin-test")
        assert intent is not None
        assert intent.payload["earliest_slot"] == 36
        assert intent.payload["latest_slot"] == 42
        assert intent.payload["due_slot"] == 42

        busy = await db.get(BusyRow, "slot-origin-busy")
        assert busy is not None
        assert busy.start_slot == 44
        assert busy.end_slot == 48

        plan = await db.get(PlanRow, 1)
        assert plan is not None
        plan_payload = json.loads(plan.payload)
        assert plan_payload["blocks"][0]["start_slot"] == 36
        assert plan_payload["blocks"][0]["end_slot"] == 42

        meta = await db.get(SlotOriginRow, 1)
        assert meta is not None
        assert meta.origin_date == "2026-10-08"

        assert await rebase_slot_origin(db, "2026-10-08") == 0
        plan_again = await db.get(PlanRow, 1)
        assert plan_again is not None
        assert json.loads(plan_again.payload)["blocks"][0]["start_slot"] == 36
    finally:
        await db.execute(delete(SlotOriginRow))
        await db.execute(delete(PlanRow))
        await db.execute(delete(IntentRow).where(IntentRow.id == "slot-origin-test"))
        await db.execute(delete(BusyRow).where(BusyRow.id == "slot-origin-busy"))
        await db.commit()
        await gen.aclose()


@pytest.mark.asyncio
async def test_notification_preferences_round_trip(client: AsyncClient) -> None:
    defaults = (await client.get("/api/settings/notifications")).json()
    assert defaults == {
        "task_enabled": True,
        "task_minutes_before": 15,
        "task_at_start": True,
        "meeting_enabled": True,
        "meeting_minutes_before": 15,
        "meeting_at_start": True,
        "deadline_enabled": True,
        "deadline_days_before": 1,
        "deadline_time_min": 9 * 60,
        "end_of_day_enabled": True,
        "end_of_day_time_min": 20 * 60 + 30,
    }

    changed = {
        **defaults,
        "task_minutes_before": 30,
        "meeting_at_start": False,
        "deadline_days_before": 2,
        "deadline_time_min": 10 * 60 + 7,
        "end_of_day_time_min": 20 * 60 + 10,
    }
    saved = await client.put("/api/settings/notifications", json=changed)
    assert saved.status_code == 200
    assert saved.json() == changed
    assert (await client.get("/api/settings/notifications")).json() == changed


@pytest.mark.asyncio
async def test_user_workday_preferences_are_persistent_defaults_not_manual_limits(
    client: AsyncClient,
) -> None:
    defaults = (await client.get("/api/settings")).json()
    assert defaults["preferred_workday_start_min"] == 9 * 60
    assert defaults["preferred_workday_end_min"] == 17 * 60

    saved = await client.put(
        "/api/settings",
        json={
            "preferred_workday_start_min": 8 * 60 + 15,
            "preferred_workday_end_min": 16 * 60 + 45,
        },
    )
    assert saved.status_code == 200

    created = await client.post(
        "/api/intents",
        json={
            "title": "Uses preferred hours",
            "minutes_per_period": 30,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 30,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    intents = (await client.get("/api/intents")).json()
    intent = next(item for item in intents if item["id"] == ident)
    assert intent["daily_windows"] == [{"start_min": 495, "end_min": 1005}]

    # "Suggested" is not a hard ban: an explicit manual placement after the
    # preferred workday remains authoritative.
    tomorrow = origin() + timedelta(days=1)
    start = tomorrow.replace(hour=18, minute=0, second=0, microsecond=0)
    end = start + timedelta(minutes=30)
    moved = await client.post(
        f"/api/intents/{ident}/move",
        json={"start": start.isoformat(), "end": end.isoformat()},
    )
    assert moved.status_code == 200


@pytest.mark.asyncio
async def test_todo_inbox_assigns_to_matrix_and_preserves_deadline(
    client: AsyncClient,
) -> None:
    tomorrow = (origin() + timedelta(days=1)).date()
    deadline = tomorrow + timedelta(days=3)

    created = await client.post(
        "/api/todos",
        json={
            "title": "Prepare customer analysis",
            "minutes": 45,
            "category": "cmr",
            "deadline_date": deadline.isoformat(),
        },
    )
    assert created.status_code == 201
    todo = created.json()
    assert todo["deadline_date"] == deadline.isoformat()

    inbox = (await client.get("/api/todos")).json()
    assert [item["id"] for item in inbox] == [todo["id"]]

    assigned = await client.post(
        f"/api/todos/{todo['id']}/assign",
        json={"date": tomorrow.isoformat(), "quadrant": 2},
    )
    assert assigned.status_code == 201
    item = assigned.json()
    assert item["quadrant"] == 2
    assert item["deadline_date"] == deadline.isoformat()
    assert item["intent_id"]

    assert (await client.get("/api/todos")).json() == []

    daily = (await client.get(f"/api/daily/{tomorrow.isoformat()}")).json()
    matrix_item = next(entry for entry in daily["items"] if entry["id"] == item["id"])
    assert matrix_item["deadline_date"] == deadline.isoformat()

    intents = (await client.get("/api/intents")).json()
    intent = next(entry for entry in intents if entry["id"] == item["intent_id"])
    assert intent["deadline_date"] == deadline.isoformat()
    assert intent["due_slot"] is not None


@pytest.mark.asyncio
async def test_create_intent_schedules_it(client: AsyncClient) -> None:
    created = await client.post(
        "/api/intents",
        json={"title": "Write the design doc", "minutes_per_period": 120, "priority": 2},
    )
    assert created.status_code == 201

    plan = (await client.get("/api/plan")).json()
    mine = [b for b in plan["blocks"] if b["title"] == "Write the design doc"]
    assert mine, "a new intent must appear on the plan immediately"
    assert sum(1 for _ in mine) >= 1
    assert plan["complete"] is True
    assert plan["solve_ms"] < 500


@pytest.mark.asyncio
async def test_existing_scheduled_task_category_patches_without_moving_it(
    client: AsyncClient,
) -> None:
    created = await client.post(
        "/api/intents",
        json={
            "title": "Existing calendar task",
            "minutes_per_period": 60,
            "min_chunk_minutes": 60,
            "max_chunk_minutes": 60,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    before_plan = (await client.get("/api/plan")).json()
    before_blocks = [
        (block["start"], block["end"])
        for block in before_plan["blocks"]
        if block["intent_id"] == ident
    ]
    assert before_blocks

    patched = await client.patch(
        f"/api/intents/{ident}",
        json={"category": "cmr"},
    )
    assert patched.status_code == 200
    assert patched.json()["category"] == "cmr"

    after_plan = (await client.get("/api/plan")).json()
    after_blocks = [
        (block["start"], block["end"])
        for block in after_plan["blocks"]
        if block["intent_id"] == ident
    ]
    assert after_blocks == before_blocks

    cleared = await client.patch(
        f"/api/intents/{ident}",
        json={"category": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["category"] is None


@pytest.mark.asyncio
async def test_focus_intent_round_trips(client: AsyncClient) -> None:
    """The habits page used to mislabel every intent it created as a habit,
    even the ones its own presets called 'focus' - this pins the fix."""
    created = await client.post(
        "/api/intents",
        json={
            "title": "Deep work",
            "kind": "focus",
            "priority": 2,
            "category": "macheta_data",
            "minutes_per_period": 600,
            "period_days": 7,
            "min_chunk_minutes": 120,
            "max_chunk_minutes": 120,
        },
    )
    assert created.status_code == 201

    intents = (await client.get("/api/intents")).json()
    mine = next(i for i in intents if i["title"] == "Deep work")
    assert mine["kind"] == "focus"
    assert mine["category"] == "macheta_data"


@pytest.mark.asyncio
async def test_busy_events_push_work_aside(client: AsyncClient) -> None:
    await client.post(
        "/api/intents",
        json={
            "title": "Deep work",
            "minutes_per_period": 120,
            "min_chunk_minutes": 120,
            "max_chunk_minutes": 120,
        },
    )
    before = (await client.get("/api/plan")).json()
    first = next(b for b in before["blocks"] if b["title"] == "Deep work")

    base = origin()
    blocked = [
        {
            "label": "All-hands",
            "start": (base + timedelta(days=d, hours=9)).isoformat(),
            "end": (base + timedelta(days=d, hours=17)).isoformat(),
        }
        for d in range(3)
    ]
    await client.put("/api/busy", json=blocked)

    after = (await client.get("/api/plan")).json()
    moved = next(b for b in after["blocks"] if b["title"] == "Deep work")
    assert moved["start"] != first["start"], "work must move off a newly blocked day"
    for block in after["blocks"]:
        assert not (block["start"] < blocked[0]["end"] and blocked[0]["start"] < block["end"])


@pytest.mark.asyncio
async def test_replanning_an_unchanged_calendar_changes_nothing(client: AsyncClient) -> None:
    for i in range(4):
        await client.post("/api/intents", json={"title": f"task {i}", "minutes_per_period": 60})

    first = (await client.post("/api/plan/solve")).json()
    again = (await client.post("/api/plan/solve")).json()

    def key(plan: dict[str, typing.Any]) -> dict[str, str]:
        return {
            f"{b['intent_id']}:{b['occurrence']}:{b['chunk']}": b["start"] for b in plan["blocks"]
        }

    assert key(first) == key(again), "a no-op re-solve must not move a single block"


@pytest.mark.asyncio
async def test_impossible_intent_is_rejected_with_a_reason(client: AsyncClient) -> None:
    response = await client.post(
        "/api/intents",
        json={
            "title": "impossible",
            "minutes_per_period": 240,
            "min_chunk_minutes": 240,
            "window_start_min": 600,
            "window_end_min": 630,
        },
    )
    assert response.status_code == 422
    assert "min_chunk" in response.json()["detail"]


@pytest.mark.asyncio
async def test_oversubscribed_calendar_reports_shortfall(client: AsyncClient) -> None:
    for i in range(40):
        await client.post(
            "/api/intents",
            json={"title": f"big {i}", "minutes_per_period": 480, "max_chunk_minutes": 480},
        )
    plan = (await client.get("/api/plan")).json()
    assert plan["complete"] is False
    assert plan["unmet"], "unplaceable demand must be reported, not dropped"
    assert plan["unmet"][0]["shortfall_minutes"] > 0


@pytest.mark.asyncio
async def test_accepts_floating_local_times(client: AsyncClient) -> None:
    """ICS files and browser `toISOString()` both hand over datetimes with no
    offset. Those must be read in the configured zone, not 500."""
    base = origin().replace(tzinfo=None)
    response = await client.put(
        "/api/busy",
        json=[
            {
                "label": "Naive meeting",
                "start": (base + timedelta(days=1, hours=10)).isoformat(),
                "end": (base + timedelta(days=1, hours=11)).isoformat(),
            }
        ],
    )
    assert response.status_code == 200
    plan = (await client.get("/api/plan")).json()
    assert plan["busy"][0]["label"] == "Naive meeting"
    # It comes back offset-aware, whatever the host's zone happens to be — the
    # point is that it was interpreted, not that it was interpreted as UTC.
    assert datetime.fromisoformat(plan["busy"][0]["start"]).tzinfo is not None


@pytest.mark.asyncio
async def test_smart_meeting_lands_in_shared_availability(client: AsyncClient) -> None:
    """A Smart Meeting must dodge the other attendees' calendars — while
    leaving those same hours free for the user's own solo work."""
    base = origin()
    busy_for_them = [
        {
            "start": (base + timedelta(days=d, hours=9)).isoformat(),
            "end": (base + timedelta(days=d, hours=15)).isoformat(),
            "attendee": "sam@example.com",
        }
        for d in range(7)
    ]
    await client.post(
        "/api/intents",
        json={
            "title": "Weekly sync",
            "kind": "meeting",
            "priority": 2,
            "minutes_per_period": 60,
            "min_chunk_minutes": 60,
            "max_chunk_minutes": 60,
            "attendee_busy": busy_for_them,
        },
    )
    await client.post(
        "/api/intents",
        json={
            "title": "Solo focus",
            "kind": "focus",
            "minutes_per_period": 120,
            "min_chunk_minutes": 120,
            "max_chunk_minutes": 120,
        },
    )
    plan = (await client.get("/api/plan")).json()

    meeting = next(b for b in plan["blocks"] if b["title"] == "Weekly sync")
    hour = datetime.fromisoformat(meeting["start"]).hour
    assert hour >= 15, "the meeting must avoid every attendee's blocked hours"

    focus = next(b for b in plan["blocks"] if b["title"] == "Solo focus")
    assert datetime.fromisoformat(focus["start"]).hour < 15, (
        "an attendee's calendar must not block the user's own solo work"
    )


def _mock_llm(
    monkeypatch: pytest.MonkeyPatch, handler: typing.Callable[[httpx.Request], httpx.Response]
) -> None:
    """Route the app's own outbound `httpx.AsyncClient` calls to `handler`,
    so a captured request never actually leaves the process."""
    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: real(**kw, transport=httpx.MockTransport(handler))
    )


@pytest.mark.asyncio
async def test_capture_when_the_model_is_unreachable_returns_503_not_500(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A connection failure to the LLM backend (wrong HOROLOG_LLM_BASE_URL,
    the model server not running yet) is the operator's problem, not a crash —
    the endpoint must say so with a 503, never a bare 500."""

    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _mock_llm(monkeypatch, handler)
    response = await client.post("/api/capture", json={"text": "gym 3x a week"})
    assert response.status_code == 503
    assert "could not reach" in response.json()["detail"]


@pytest.mark.asyncio
async def test_capture_when_the_model_returns_404_surfaces_the_body(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ollama's 404 body says 'model not found, try pulling it first' — that
    text is the one actionable thing here and must survive into the
    response, not get discarded by a generic status-code message."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="model 'qwen3:8b' not found, try pulling it first")

    _mock_llm(monkeypatch, handler)
    response = await client.post("/api/capture", json={"text": "gym 3x a week"})
    assert response.status_code == 503
    assert "not found, try pulling it first" in response.json()["detail"]


@pytest.mark.asyncio
async def test_capture_when_the_model_returns_an_unexpected_shape_returns_503_not_500(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 200 with no `choices` key — e.g. a reverse proxy's own error page,
    or a server that isn't actually OpenAI-chat-compatible — must not crash
    the endpoint with an unhandled KeyError."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": "not the shape you expected"})

    _mock_llm(monkeypatch, handler)
    response = await client.post("/api/capture", json={"text": "gym 3x a week"})
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_capture_with_anthropic_selected_but_sdk_missing_returns_503_not_500(
    client: AsyncClient,
) -> None:
    """`anthropic` is an optional extra, not in the documented dev install
    (`.[dev]`) — only the Docker image has it. Picking "Anthropic" in the UI
    without it installed must surface the friendly install message, not a
    bare 500. No mocking needed: the package genuinely isn't in this venv."""
    response = await client.post(
        "/api/capture",
        json={"text": "gym 3x a week", "provider": "anthropic", "model": "claude-opus-5"},
    )
    assert response.status_code == 503
    assert "horolog[anthropic]" in response.json()["detail"]


@pytest.mark.asyncio
async def test_sync_ics_when_the_feed_is_unreachable_returns_502_not_500(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dead or mistyped .ics URL is the user's mistake to fix, not a server
    crash — must map to 502 with the reason included."""

    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("name or service not known")

    _mock_llm(monkeypatch, handler)
    response = await client.post(
        "/api/sync/ics", json={"url": "https://example.invalid/calendar.ics"}
    )
    assert response.status_code == 502


# --------------------------------------------------------------- task lifecycle


@pytest.mark.asyncio
async def test_completing_a_task_frees_its_capacity_on_the_next_solve(
    client: AsyncClient,
) -> None:
    created = (
        await client.post(
            "/api/intents", json={"title": "Ship the thing", "minutes_per_period": 60}
        )
    ).json()

    plan = (await client.get("/api/plan")).json()
    assert any(b["intent_id"] == created["id"] for b in plan["blocks"])

    done = await client.post(f"/api/intents/{created['id']}/complete")
    assert done.status_code == 200
    assert done.json()["completed_at"] is not None

    plan = (await client.get("/api/plan")).json()
    finished = [b for b in plan["blocks"] if b["intent_id"] == created["id"]]
    assert finished, "the finished task should remain visible in the rendered calendar"
    assert all(b["completed"] is True for b in finished)

    intents = (await client.get("/api/intents")).json()
    mine = next(i for i in intents if i["id"] == created["id"])
    assert mine["completed_at"] is not None, "the row is kept, not deleted"


@pytest.mark.asyncio
async def test_uncompleting_a_task_restores_it_to_the_plan(client: AsyncClient) -> None:
    created = (
        await client.post("/api/intents", json={"title": "Redo it", "minutes_per_period": 60})
    ).json()
    await client.post(f"/api/intents/{created['id']}/complete")

    undone = await client.delete(f"/api/intents/{created['id']}/complete")
    assert undone.status_code == 200
    assert undone.json()["completed_at"] is None

    plan = (await client.get("/api/plan")).json()
    assert any(b["intent_id"] == created["id"] for b in plan["blocks"])


@pytest.mark.asyncio
async def test_completing_a_recurring_habit_is_rejected(client: AsyncClient) -> None:
    """Completion is scoped to one-shot tasks — a habit needs per-occurrence
    state that does not exist yet, so it must fail loudly, not silently no-op
    or complete the whole recurring series."""
    created = (
        await client.post(
            "/api/intents",
            json={
                "title": "Gym",
                "kind": "habit",
                "minutes_per_period": 180,
                "period_days": 7,
                "min_chunk_minutes": 60,
                "max_chunk_minutes": 60,
            },
        )
    ).json()
    response = await client.post(f"/api/intents/{created['id']}/complete")
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_completing_an_unknown_intent_is_404(client: AsyncClient) -> None:
    response = await client.post("/api/intents/does-not-exist/complete")
    assert response.status_code == 404


def _no_overlaps(blocks: list[dict[str, typing.Any]], intent_id: str) -> bool:
    mine = sorted(
        (datetime.fromisoformat(b["start"]), datetime.fromisoformat(b["end"]))
        for b in blocks
        if b["intent_id"] == intent_id
    )
    return all(mine[i][1] <= mine[i + 1][0] for i in range(len(mine) - 1))


@pytest.mark.asyncio
async def test_editing_an_intent_keeps_its_id_and_stays_stable_when_unchanged(
    client: AsyncClient,
) -> None:
    created = (
        await client.post(
            "/api/intents", json={"title": "Original", "minutes_per_period": 60, "priority": 3}
        )
    ).json()
    before = (await client.get("/api/plan")).json()
    was = next(b for b in before["blocks"] if b["intent_id"] == created["id"])

    edited = await client.put(
        f"/api/intents/{created['id']}",
        json={"title": "Original", "minutes_per_period": 60, "priority": 1},
    )
    assert edited.status_code == 200
    assert edited.json()["id"] == created["id"]

    after = (await client.get("/api/plan")).json()
    now = next(b for b in after["blocks"] if b["intent_id"] == created["id"])
    assert now["start"] == was["start"], "an edit that doesn't touch duration must not move it"
    assert now["priority"] == 1


@pytest.mark.asyncio
async def test_editing_an_intent_larger_does_not_overlap_or_orphan(client: AsyncClient) -> None:
    created = (
        await client.post(
            "/api/intents",
            json={
                "title": "Grows",
                "minutes_per_period": 120,
                "min_chunk_minutes": 30,
                "max_chunk_minutes": 120,
            },
        )
    ).json()

    edited = await client.put(
        f"/api/intents/{created['id']}",
        json={
            "title": "Grows",
            "minutes_per_period": 180,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 120,
        },
    )
    assert edited.status_code == 200

    plan = (await client.get("/api/plan")).json()
    assert _no_overlaps(plan["blocks"], created["id"])
    placed = sum(
        (datetime.fromisoformat(b["end"]) - datetime.fromisoformat(b["start"])).total_seconds()
        for b in plan["blocks"]
        if b["intent_id"] == created["id"]
    )
    assert placed == 180 * 60


@pytest.mark.asyncio
async def test_editing_an_intent_smaller_does_not_overlap_or_orphan(client: AsyncClient) -> None:
    created = (
        await client.post(
            "/api/intents",
            json={
                "title": "Shrinks",
                "minutes_per_period": 180,
                "min_chunk_minutes": 30,
                "max_chunk_minutes": 120,
            },
        )
    ).json()

    edited = await client.put(
        f"/api/intents/{created['id']}",
        json={
            "title": "Shrinks",
            "minutes_per_period": 60,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 120,
        },
    )
    assert edited.status_code == 200

    plan = (await client.get("/api/plan")).json()
    assert _no_overlaps(plan["blocks"], created["id"])
    placed = sum(
        (datetime.fromisoformat(b["end"]) - datetime.fromisoformat(b["start"])).total_seconds()
        for b in plan["blocks"]
        if b["intent_id"] == created["id"]
    )
    assert placed == 60 * 60


@pytest.mark.asyncio
async def test_editing_an_unknown_intent_is_404(client: AsyncClient) -> None:
    response = await client.put(
        "/api/intents/does-not-exist", json={"title": "x", "minutes_per_period": 30}
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_editing_an_intent_rejects_the_same_invalid_shapes_as_creating_one(
    client: AsyncClient,
) -> None:
    created = (
        await client.post("/api/intents", json={"title": "Fine", "minutes_per_period": 60})
    ).json()
    response = await client.put(
        f"/api/intents/{created['id']}",
        json={
            "title": "Fine",
            "minutes_per_period": 60,
            "min_chunk_minutes": 90,
            "max_chunk_minutes": 30,
        },
    )
    assert response.status_code == 422


def test_preferred_start_before_workday_expands_default_window() -> None:
    base = datetime(2026, 10, 5, 0, 0, tzinfo=ZoneInfo("Europe/Warsaw"))
    wire = IntentIn(
        title="Early gym",
        minutes_per_period=90,
        min_chunk_minutes=90,
        max_chunk_minutes=90,
        preferred_start_min=6 * 60,
    )

    intent = wire.to_domain("early-gym", base)

    assert intent.preferred_start_min == 6 * 60
    assert intent.daily_windows[0].start_min == 6 * 60
    assert intent.daily_windows[0].end_min == 17 * 60


@pytest.mark.asyncio
async def test_completing_and_uncompleting_one_habit_occurrence(
    client: AsyncClient,
) -> None:
    created = (
        await client.post(
            "/api/intents",
            json={
                "title": "Recurring gym",
                "kind": "habit",
                "minutes_per_period": 180,
                "period_days": 7,
                "min_chunk_minutes": 60,
                "max_chunk_minutes": 60,
                "max_per_day": 1,
                "window_start_min": 360,
                "window_end_min": 540,
            },
        )
    ).json()

    plan = (await client.get("/api/plan")).json()
    blocks = [b for b in plan["blocks"] if b["intent_id"] == created["id"]]
    assert blocks

    occurrence = blocks[0]
    body = {
        "start": occurrence["start"],
        "end": occurrence["end"],
    }

    done = await client.post(
        f"/api/intents/{created['id']}/complete-block",
        json=body,
    )
    assert done.status_code == 200
    assert len(done.json()["completed_blocks"]) == 1

    intents = (await client.get("/api/intents")).json()
    mine = next(i for i in intents if i["id"] == created["id"])
    assert len(mine["completed_blocks"]) == 1

    undone = await client.request(
        "DELETE",
        f"/api/intents/{created['id']}/complete-block",
        json=body,
    )
    assert undone.status_code == 200
    assert undone.json()["completed_blocks"] == []



# --------------------------------------------------------------- Daily planning


@pytest.mark.asyncio
async def test_daily_item_rolls_forward_without_duplication(client: AsyncClient) -> None:
    base = origin().date()
    day1 = base.isoformat()
    day2 = (base + timedelta(days=1)).isoformat()

    created = await client.post(
        f"/api/daily/{day1}/items",
        json={
            "title": "Finish the important thing",
            "quadrant": 1,
            "minutes": 45,
            "priority": 1,
            "schedule_enabled": True,
        },
    )
    assert created.status_code == 201
    item = created.json()
    assert item["intent_id"]

    tomorrow = await client.get(f"/api/daily/{day2}")
    assert tomorrow.status_code == 200
    carried = [row for row in tomorrow.json()["items"] if row["id"] == item["id"]]
    assert len(carried) == 1
    assert carried[0]["carried"] is True
    assert carried[0]["carry_days"] == 1

    intents = (await client.get("/api/intents")).json()
    assert sum(1 for intent in intents if intent["id"] == item["intent_id"]) == 1


@pytest.mark.asyncio
async def test_daily_completion_completes_linked_task(client: AsyncClient) -> None:
    day = origin().date().isoformat()
    created = (
        await client.post(
            f"/api/daily/{day}/items",
            json={
                "title": "Close the loop",
                "quadrant": 2,
                "minutes": 30,
                "priority": 2,
                "schedule_enabled": True,
            },
        )
    ).json()

    response = await client.post(f"/api/daily/items/{created['id']}/complete")
    assert response.status_code == 200

    intents = (await client.get("/api/intents")).json()
    intent = next(row for row in intents if row["id"] == created["intent_id"])
    assert intent["completed_at"] is not None


@pytest.mark.asyncio
async def test_daily_review_seeds_tomorrows_first_step(client: AsyncClient) -> None:
    day = origin().date()
    today = day.isoformat()
    tomorrow = (day + timedelta(days=1)).isoformat()

    saved = await client.put(
        f"/api/daily/{today}/review",
        json={
            "did_well": "",
            "grateful_for": "",
            "would_change": "",
            "learned": "",
            "improve_tomorrow": "Do the hard thing before email",
            "first_step_morning": "Open the mapping file",
        },
    )
    assert saved.status_code == 200

    next_day = (await client.get(f"/api/daily/{tomorrow}")).json()
    assert next_day["plan"]["first_step"] == "Open the mapping file"



@pytest.mark.asyncio
async def test_daily_matrix_sets_priority_without_a_second_priority_choice(
    client: AsyncClient,
) -> None:
    day = origin().date().isoformat()
    created = (
        await client.post(
            f"/api/daily/{day}/items",
            json={
                "title": "Matrix decides",
                "quadrant": 1,
                "minutes": 30,
                "priority": 4,
                "schedule_enabled": True,
            },
        )
    ).json()
    assert created["priority"] == 1

    intents = (await client.get("/api/intents")).json()
    intent = next(row for row in intents if row["id"] == created["intent_id"])
    assert intent["priority"] == 1


@pytest.mark.asyncio
async def test_stale_daily_item_can_be_acknowledged_or_deferred(
    client: AsyncClient,
) -> None:
    today = origin().date()
    old = (today - timedelta(days=3)).isoformat()
    current = today.isoformat()
    tomorrow = (today + timedelta(days=1)).isoformat()

    created = (
        await client.post(
            f"/api/daily/{old}/items",
            json={
                "title": "Persistent task",
                "quadrant": 3,
                "minutes": 30,
                "schedule_enabled": False,
            },
        )
    ).json()

    daily = (await client.get(f"/api/daily/{current}")).json()
    item = next(row for row in daily["items"] if row["id"] == created["id"])
    assert item["needs_decision"] is True

    kept = await client.post(
        f"/api/daily/items/{created['id']}/keep",
        json={"date": current},
    )
    assert kept.status_code == 200
    daily = (await client.get(f"/api/daily/{current}")).json()
    item = next(row for row in daily["items"] if row["id"] == created["id"])
    assert item["needs_decision"] is False

    deferred = await client.post(
        f"/api/daily/items/{created['id']}/defer",
        json={"until": tomorrow},
    )
    assert deferred.status_code == 200
    today_view = (await client.get(f"/api/daily/{current}")).json()
    assert not any(row["id"] == created["id"] for row in today_view["items"])
    tomorrow_view = (await client.get(f"/api/daily/{tomorrow}")).json()
    assert any(row["id"] == created["id"] for row in tomorrow_view["items"])


@pytest.mark.asyncio
async def test_daily_history_and_weekly_summary_are_available(client: AsyncClient) -> None:
    day = origin().date().isoformat()
    await client.put(
        f"/api/daily/{day}",
        json={"win_condition": "Ship one thing", "first_step": "Open the file"},
    )
    await client.put(
        f"/api/daily/{day}/review",
        json={
            "did_well": "Started before email",
            "grateful_for": "",
            "would_change": "",
            "learned": "Small starts work",
            "improve_tomorrow": "",
            "first_step_morning": "",
        },
    )

    history = (await client.get("/api/daily-history")).json()
    assert any(row["date"] == day and row["review_answers"] == 2 for row in history)

    weekly = (await client.get(f"/api/daily-weekly/{day}")).json()
    assert weekly["planned_days"] >= 1
    assert weekly["reviewed_days"] >= 1
    assert any(row["text"] == "Small starts work" for row in weekly["reflection_highlights"])



@pytest.mark.asyncio
async def test_removing_daily_item_keeps_linked_task_in_inbox(client: AsyncClient) -> None:
    day = origin().date().isoformat()
    created = (
        await client.post(
            f"/api/daily/{day}/items",
            json={
                "title": "Do not delete me",
                "quadrant": 1,
                "minutes": 30,
                "schedule_enabled": True,
            },
        )
    ).json()

    removed = await client.post(f"/api/daily/items/{created['id']}/cancel")
    assert removed.status_code == 200

    intents = (await client.get("/api/intents")).json()
    assert any(intent["id"] == created["intent_id"] for intent in intents)

    daily = (await client.get(f"/api/daily/{day}")).json()
    assert not any(item["id"] == created["id"] for item in daily["items"])


@pytest.mark.asyncio
async def test_dragging_daily_item_changes_quadrant_and_task_priority(
    client: AsyncClient,
) -> None:
    day = origin().date().isoformat()
    created = (
        await client.post(
            f"/api/daily/{day}/items",
            json={
                "title": "Move me",
                "quadrant": 2,
                "minutes": 45,
                "schedule_enabled": True,
            },
        )
    ).json()

    moved = await client.post(
        f"/api/daily/items/{created['id']}/move",
        json={"quadrant": 1, "date": day},
    )
    assert moved.status_code == 200
    assert moved.json()["quadrant"] == 1
    assert moved.json()["priority"] == 1

    intents = (await client.get("/api/intents")).json()
    linked = next(intent for intent in intents if intent["id"] == created["intent_id"])
    assert linked["priority"] == 1



@pytest.mark.asyncio
async def test_hard_latest_bound_keeps_meeting_on_selected_day(client: AsyncClient) -> None:
    base = origin()
    target = base + timedelta(days=2)
    response = await client.post(
        "/api/intents",
        json={
            "title": "Future meeting",
            "kind": "meeting",
            "priority": 2,
            "minutes_per_period": 60,
            "min_chunk_minutes": 60,
            "max_chunk_minutes": 60,
            "earliest": target.isoformat(),
            "latest": (target + timedelta(days=1)).isoformat(),
        },
    )
    assert response.status_code == 201

    plan = (await client.get("/api/plan")).json()
    block = next(b for b in plan["blocks"] if b["title"] == "Future meeting")
    assert datetime.fromisoformat(block["start"]).date() == target.date()



# ------------------------------------------------ conversational assistant execution


@pytest.mark.asyncio
async def test_assistant_executes_confirmed_task_only_after_execute(client: AsyncClient) -> None:
    day = origin().date().isoformat()
    before = (await client.get("/api/intents")).json()

    action = {
        "action": "create_task",
        "title": "Prepare client notes",
        "date": day,
        "minutes": 30,
        "quadrant": 1,
    }

    # A proposal object by itself has no side effect.
    assert not any(row["title"] == "Prepare client notes" for row in before)

    response = await client.post("/api/assistant/execute", json={"actions": [action]})
    assert response.status_code == 200
    assert response.json()["count"] == 1

    after = (await client.get("/api/intents")).json()
    assert any(row["title"] == "Prepare client notes" for row in after)


@pytest.mark.asyncio
async def test_assistant_fixed_task_returns_success_after_exact_placement(client: AsyncClient) -> None:
    target = origin().date() + timedelta(days=1)
    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "create_task",
                    "title": "Fixed prep",
                    "date": target.isoformat(),
                    "minutes": 30,
                    "quadrant": 1,
                    "start_min": 9 * 60,
                    "start_mode": "fixed",
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success_count"] == 1
    assert body["results"][0]["status"] == "done"
    assert body["results"][0]["scheduled"][0]["start"].startswith(
        f"{target.isoformat()}T09:00"
    )


@pytest.mark.asyncio
async def test_assistant_create_break_returns_success_after_exact_placement(client: AsyncClient) -> None:
    target = origin().date() + timedelta(days=1)
    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "create_break",
                    "title": "Przerwa",
                    "date": target.isoformat(),
                    "minutes": 30,
                    "start_min": 14 * 60 + 30,
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success_count"] == 1
    assert body["results"][0]["status"] == "done"
    assert body["results"][0]["scheduled"][0]["start"].startswith(
        f"{target.isoformat()}T14:30"
    )

    plan = (await client.get("/api/plan")).json()
    block = next(b for b in plan["blocks"] if b["title"] == "Przerwa")
    assert datetime.fromisoformat(block["start"]).date() == target


@pytest.mark.asyncio
async def test_planner_exact_move_can_resize_task(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    start = target.replace(hour=10, minute=0, second=0, microsecond=0)
    end = start + timedelta(minutes=60)

    created = await client.post(
        "/api/intents",
        json={
            "title": "Resize me",
            "kind": "task",
            "priority": 2,
            "minutes_per_period": 60,
            "min_chunk_minutes": 60,
            "max_chunk_minutes": 60,
            "max_per_day": 1,
            "earliest": start.isoformat(),
            "latest": end.isoformat(),
            "due": end.isoformat(),
            "preferred_start_min": 10 * 60,
            "window_start_min": 10 * 60,
            "window_end_min": 11 * 60,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    new_start = target.replace(hour=12, minute=0, second=0, microsecond=0)
    new_end = new_start + timedelta(minutes=30)
    moved = await client.post(
        f"/api/intents/{ident}/move",
        json={"start": new_start.isoformat(), "end": new_end.isoformat()},
    )
    assert moved.status_code == 200

    intents = (await client.get("/api/intents")).json()
    resized = next(item for item in intents if item["id"] == ident)
    assert resized["minutes_per_period"] == 30
    assert resized["min_chunk_minutes"] == 30
    assert resized["max_chunk_minutes"] == 30

    plan = (await client.get("/api/plan")).json()
    block = next(item for item in plan["blocks"] if item["intent_id"] == ident)
    assert datetime.fromisoformat(block["start"]) == new_start
    assert datetime.fromisoformat(block["end"]) == new_end


@pytest.mark.asyncio
async def test_assistant_can_retime_and_resize_existing_task(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    start = target.replace(hour=9, minute=0, second=0, microsecond=0)
    end = start + timedelta(minutes=60)

    created = await client.post(
        "/api/intents",
        json={
            "title": "Assistant resize",
            "kind": "task",
            "priority": 2,
            "minutes_per_period": 60,
            "min_chunk_minutes": 60,
            "max_chunk_minutes": 60,
            "max_per_day": 1,
            "earliest": start.isoformat(),
            "latest": end.isoformat(),
            "due": end.isoformat(),
            "preferred_start_min": 9 * 60,
            "window_start_min": 9 * 60,
            "window_end_min": 10 * 60,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "reschedule_task",
                    "intent_id": ident,
                    "date": target.date().isoformat(),
                    "start_min": 10 * 60 + 30,
                    "minutes": 30,
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success_count"] == 1
    assert body["results"][0]["status"] == "done"

    plan = (await client.get("/api/plan")).json()
    block = next(item for item in plan["blocks"] if item["intent_id"] == ident)
    actual_start = datetime.fromisoformat(block["start"])
    actual_end = datetime.fromisoformat(block["end"])
    assert (actual_start.hour, actual_start.minute) == (10, 30)
    assert (actual_end.hour, actual_end.minute) == (11, 0)


@pytest.mark.asyncio
async def test_planner_can_retime_and_resize_break(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    start = target.replace(hour=11, minute=30, second=0, microsecond=0)
    end = start + timedelta(minutes=30)

    created = await client.post(
        "/api/intents",
        json={
            "title": "Planner break",
            "kind": "buffer",
            "priority": 1,
            "minutes_per_period": 30,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 30,
            "max_per_day": 1,
            "earliest": start.isoformat(),
            "latest": end.isoformat(),
            "due": end.isoformat(),
            "preferred_start_min": 11 * 60 + 30,
            "window_start_min": 11 * 60 + 30,
            "window_end_min": 12 * 60,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    new_start = target.replace(hour=12, minute=0, second=0, microsecond=0)
    new_end = new_start + timedelta(minutes=45)
    moved = await client.post(
        f"/api/intents/{ident}/move",
        json={"start": new_start.isoformat(), "end": new_end.isoformat()},
    )
    assert moved.status_code == 200

    intents = (await client.get("/api/intents")).json()
    resized = next(item for item in intents if item["id"] == ident)
    assert resized["minutes_per_period"] == 45

    plan = (await client.get("/api/plan")).json()
    block = next(item for item in plan["blocks"] if item["intent_id"] == ident)
    assert datetime.fromisoformat(block["start"]) == new_start
    assert datetime.fromisoformat(block["end"]) == new_end


@pytest.mark.asyncio
async def test_assistant_can_retime_existing_break(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    start = target.replace(hour=11, minute=30, second=0, microsecond=0)
    end = start + timedelta(minutes=30)

    created = await client.post(
        "/api/intents",
        json={
            "title": "Assistant break",
            "kind": "buffer",
            "priority": 1,
            "minutes_per_period": 30,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 30,
            "max_per_day": 1,
            "earliest": start.isoformat(),
            "latest": end.isoformat(),
            "due": end.isoformat(),
            "preferred_start_min": 11 * 60 + 30,
            "window_start_min": 11 * 60 + 30,
            "window_end_min": 12 * 60,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "reschedule_break",
                    "intent_id": ident,
                    "start_min": 12 * 60,
                    "minutes": 30,
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success_count"] == 1
    assert body["results"][0]["status"] == "done"

    plan = (await client.get("/api/plan")).json()
    block = next(item for item in plan["blocks"] if item["intent_id"] == ident)
    actual_start = datetime.fromisoformat(block["start"])
    actual_end = datetime.fromisoformat(block["end"])
    assert (actual_start.hour, actual_start.minute) == (12, 0)
    assert (actual_end.hour, actual_end.minute) == (12, 30)


@pytest.mark.asyncio
async def test_planner_can_retime_and_resize_meeting(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    start = target.replace(hour=11, minute=0, second=0, microsecond=0)
    end = start + timedelta(minutes=30)

    created = await client.post(
        "/api/intents",
        json={
            "title": "Planner meeting",
            "kind": "meeting",
            "priority": 2,
            "minutes_per_period": 30,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 30,
            "max_per_day": 1,
            "earliest": start.isoformat(),
            "latest": end.isoformat(),
            "due": end.isoformat(),
            "preferred_start_min": 11 * 60,
            "window_start_min": 11 * 60,
            "window_end_min": 11 * 60 + 30,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    new_start = target.replace(hour=11, minute=30, second=0, microsecond=0)
    new_end = new_start + timedelta(minutes=45)
    moved = await client.post(
        f"/api/intents/{ident}/move",
        json={"start": new_start.isoformat(), "end": new_end.isoformat()},
    )
    assert moved.status_code == 200

    intents = (await client.get("/api/intents")).json()
    resized = next(item for item in intents if item["id"] == ident)
    assert resized["minutes_per_period"] == 45
    assert resized["min_chunk_minutes"] == 45
    assert resized["max_chunk_minutes"] == 45

    plan = (await client.get("/api/plan")).json()
    block = next(item for item in plan["blocks"] if item["intent_id"] == ident)
    assert datetime.fromisoformat(block["start"]) == new_start
    assert datetime.fromisoformat(block["end"]) == new_end


@pytest.mark.asyncio
async def test_assistant_can_retime_and_resize_existing_meeting(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    start = target.replace(hour=10, minute=0, second=0, microsecond=0)
    end = start + timedelta(minutes=30)

    created = await client.post(
        "/api/intents",
        json={
            "title": "Assistant meeting",
            "kind": "meeting",
            "priority": 2,
            "minutes_per_period": 30,
            "min_chunk_minutes": 30,
            "max_chunk_minutes": 30,
            "max_per_day": 1,
            "earliest": start.isoformat(),
            "latest": end.isoformat(),
            "due": end.isoformat(),
            "preferred_start_min": 10 * 60,
            "window_start_min": 10 * 60,
            "window_end_min": 10 * 60 + 30,
        },
    )
    assert created.status_code == 201
    ident = created.json()["id"]

    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "reschedule_meeting",
                    "intent_id": ident,
                    "start_min": 11 * 60 + 15,
                    "minutes": 45,
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success_count"] == 1
    assert body["results"][0]["status"] == "done"

    plan = (await client.get("/api/plan")).json()
    block = next(item for item in plan["blocks"] if item["intent_id"] == ident)
    actual_start = datetime.fromisoformat(block["start"])
    actual_end = datetime.fromisoformat(block["end"])
    assert (actual_start.hour, actual_start.minute) == (11, 15)
    assert (actual_end.hour, actual_end.minute) == (12, 0)


@pytest.mark.asyncio
async def test_assistant_swaps_two_scheduled_tasks_atomically(client: AsyncClient) -> None:
    target = origin() + timedelta(days=1)
    first_start = target.replace(hour=9, minute=0, second=0, microsecond=0)
    second_start = target.replace(hour=11, minute=0, second=0, microsecond=0)

    async def create_fixed(title: str, start: datetime) -> dict[str, object]:
        end = start + timedelta(minutes=60)
        response = await client.post(
            "/api/intents",
            json={
                "title": title,
                "kind": "task",
                "priority": 2,
                "minutes_per_period": 60,
                "min_chunk_minutes": 60,
                "max_chunk_minutes": 60,
                "max_per_day": 1,
                "earliest": start.isoformat(),
                "latest": end.isoformat(),
                "due": end.isoformat(),
                "preferred_start_min": start.hour * 60 + start.minute,
                "window_start_min": start.hour * 60 + start.minute,
                "window_end_min": end.hour * 60 + end.minute,
            },
        )
        assert response.status_code == 201
        return response.json()

    first = await create_fixed("First swap task", first_start)
    second = await create_fixed("Second swap task", second_start)

    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "swap_tasks",
                    "intent_id": first["id"],
                    "second_intent_id": second["id"],
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success_count"] == 1
    assert body["results"][0]["status"] == "done"

    plan = (await client.get("/api/plan")).json()
    first_block = next(b for b in plan["blocks"] if b["title"] == "First swap task")
    second_block = next(b for b in plan["blocks"] if b["title"] == "Second swap task")

    first_after = datetime.fromisoformat(first_block["start"])
    second_after = datetime.fromisoformat(second_block["start"])
    assert (first_after.hour, first_after.minute) == (11, 0)
    assert (second_after.hour, second_after.minute) == (9, 0)


@pytest.mark.asyncio
async def test_assistant_confirmed_meeting_stays_on_requested_day(client: AsyncClient) -> None:
    target = origin().date() + timedelta(days=2)
    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "create_meeting",
                    "title": "Anna AZAN",
                    "date": target.isoformat(),
                    "minutes": 45,
                    "start_min": 10 * 60 + 30,
                }
            ]
        },
    )
    assert response.status_code == 200

    plan = (await client.get("/api/plan")).json()
    block = next(b for b in plan["blocks"] if b["title"] == "Anna AZAN")
    start = datetime.fromisoformat(block["start"])
    assert start.date() == target
    assert (start.hour, start.minute) == (10, 30)


@pytest.mark.asyncio
async def test_assistant_updates_daily_first_step(client: AsyncClient) -> None:
    day = origin().date().isoformat()
    response = await client.post(
        "/api/assistant/execute",
        json={
            "actions": [
                {
                    "action": "update_daily_plan",
                    "date": day,
                    "first_step": "Open the mapping workbook",
                }
            ]
        },
    )
    assert response.status_code == 200

    daily = (await client.get(f"/api/daily/{day}")).json()
    assert daily["plan"]["first_step"] == "Open the mapping workbook"
