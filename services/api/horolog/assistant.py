"""Conversational planning layer for Horolog.

The model never mutates state. It receives a compact factual snapshot and returns
either a question, an informational answer, or a structured proposal. The API
executes a proposal only after a separate explicit confirmation request.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from horolog.domain.intent import WorkCategory
from horolog.llm import Provider, extract
from horolog.settings import settings


class AssistantReference(BaseModel):
    """Explicit UI-selected reference carried alongside natural-language text."""

    kind: Literal["intent", "todo", "category"]
    token: str = Field(min_length=2, max_length=400)
    intent_id: str | None = None
    todo_id: str | None = None
    category: WorkCategory | None = None

    @model_validator(mode="after")
    def _valid_reference(self) -> "AssistantReference":
        if self.kind == "intent":
            if not self.intent_id:
                raise ValueError("intent reference requires intent_id")
            if self.todo_id is not None or self.category is not None:
                raise ValueError("intent reference can carry only intent_id")
        elif self.kind == "todo":
            if not self.todo_id:
                raise ValueError("todo reference requires todo_id")
            if self.intent_id is not None or self.category is not None:
                raise ValueError("todo reference can carry only todo_id")
        else:
            if self.category is None:
                raise ValueError("category reference requires category")
            if self.intent_id is not None or self.todo_id is not None:
                raise ValueError("category reference can carry only category")
        return self


class AssistantMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)
    references: list[AssistantReference] = Field(default_factory=list, max_length=12)


class AssistantAction(BaseModel):
    action: Literal[
        "create_task",
        "create_meeting",
        "create_break",
        "swap_tasks",
        "reschedule_task",
        "reschedule_break",
        "reschedule_meeting",
        "complete_task",
        "delete_tasks_for_date",
        "schedule_todo",
        "update_daily_plan",
        "find_time",
    ]
    title: str | None = None
    intent_id: str | None = None
    second_intent_id: str | None = None
    todo_id: str | None = None
    date: str | None = None
    minutes: int | None = None
    quadrant: int | None = None
    start_min: int | None = None
    start_mode: Literal["fixed", "preferred"] | None = None
    category: WorkCategory | None = None
    win_condition: str | None = None
    first_step: str | None = None
    search_days: int | None = Field(default=None, ge=1, le=14)
    count: int | None = Field(default=None, ge=1, le=8)
    window_start_min: int | None = Field(default=None, ge=0, lt=24 * 60)
    window_end_min: int | None = Field(default=None, ge=1, le=24 * 60)

    @model_validator(mode="after")
    def _sane(self) -> "AssistantAction":
        if self.minutes is not None and self.minutes <= 0:
            raise ValueError("minutes must be positive")
        if self.quadrant is not None and self.quadrant not in (1, 2, 3, 4):
            raise ValueError("quadrant must be 1..4")
        if self.start_min is not None and not 0 <= self.start_min < 24 * 60:
            raise ValueError("start_min must be 0..1439")
        if self.start_mode is not None and self.start_min is None:
            raise ValueError("start_mode requires start_min")
        if (
            self.action in ("reschedule_task", "reschedule_break", "reschedule_meeting")
            and self.date is None
            and self.start_min is None
            and self.minutes is None
        ):
            raise ValueError(
                f"{self.action} requires at least one of date, start_min or minutes"
            )
        if self.date is not None:
            try:
                datetime.strptime(self.date, "%Y-%m-%d")
            except ValueError as exc:
                raise ValueError("date must be YYYY-MM-DD") from exc
        if self.action == "schedule_todo":
            if self.todo_id is None or self.date is None or self.quadrant is None:
                raise ValueError("schedule_todo requires todo_id, date and quadrant")
            if self.start_min is not None and self.quadrant > 2:
                raise ValueError("a fixed/preferred Planner time requires quadrant 1 or 2")
        if self.action == "find_time":
            if self.date is None or self.minutes is None:
                raise ValueError("find_time requires date and minutes")
            if (
                self.window_start_min is not None
                and self.window_end_min is not None
                and self.window_end_min <= self.window_start_min
            ):
                raise ValueError("find_time window end must be after start")
        if self.action == "delete_tasks_for_date" and self.date is None:
            raise ValueError("delete_tasks_for_date requires date")
        return self


class TodoInboxSuggestion(BaseModel):
    minutes: int = Field(ge=15, le=480)
    quadrant: int = Field(ge=1, le=4)
    category: WorkCategory | None = None
    deadline_date: str | None = Field(
        default=None,
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    rationale: str = Field(min_length=1, max_length=800)


TODO_SUGGEST_SYSTEM = """\
You help classify one inbox task before it enters the Eisenhower matrix.
Return only a structured suggestion.

Rules:
- Preserve facts supplied by the user; never invent a client, category or deadline.
- Estimate realistic work duration in 15-minute increments, 15..480 minutes.
- Quadrants: 1 important+urgent, 2 important+not urgent, 3 not important+urgent,
  4 not important+not urgent. If urgency is not evident, prefer quadrant 2.
- Categories: cmr, macheta_data, private. Use null when the title/current data do
  not support one.
- deadline_date: preserve an existing explicit deadline. Infer a date only when
  the task text itself clearly contains a relative/absolute deadline. Otherwise null.
- rationale should be short and in Polish.
"""


async def suggest_todo_item(
    *,
    title: str,
    current_minutes: int,
    current_category: WorkCategory | None,
    current_deadline_date: str | None,
    provider: Provider | None = None,
) -> TodoInboxSuggestion:
    now = datetime.now(settings().zone)
    user = (
        f"Current local date: {now.date().isoformat()}\n"
        f"TITLE: {title}\n"
        f"CURRENT MINUTES: {current_minutes}\n"
        f"CURRENT CATEGORY: {current_category.value if current_category else None}\n"
        f"CURRENT DEADLINE: {current_deadline_date}\n"
        "Suggest classification for this inbox task."
    )
    return await extract(TodoInboxSuggestion, TODO_SUGGEST_SYSTEM, user, provider=provider)


class AssistantDecision(BaseModel):
    reply: str = Field(min_length=1, max_length=5000)
    actions: list[AssistantAction] = Field(default_factory=list)

    @model_validator(mode="after")
    def _limited(self) -> "AssistantDecision":
        if len(self.actions) > 8:
            raise ValueError("at most 8 proposed actions")
        return self


SYSTEM = """\
You are Horolog Assistant, a conversational planning operator for one user.

Your job is to talk naturally, establish missing details, inspect the factual
Horolog context supplied below, and propose precise changes. You NEVER perform
changes yourself. Every mutation is returned as structured actions and is
executed only after the user explicitly confirms it in the UI.

Core rules:
- Answer in the language of the user's latest message.
- Do not invent dates, times, durations, people, task IDs, or calendar facts.
- Ask a short follow-up question when a necessary detail is missing.
- If a meeting is merely mentioned as context, notice it and ask whether the
  user wants it added. Do not silently create it.
- If the user clearly asks to add a meeting but gives no time, ask for time.
- If the user gives a task but no duration, you may propose 30 minutes, clearly
  saying it is a proposal.
- For a task's Eisenhower classification:
    1 = important + urgent ("Zrób teraz")
    2 = important + not urgent ("Zaplanuj")
    3 = not important + urgent ("Ogranicz/deleguj")
    4 = not important + not urgent ("Usuń/odłóż")
  Infer only when the wording supports it; otherwise use quadrant 2 as a calm
  default and mention that assumption.
- The UI may provide EXPLICIT REFERENCES selected with @ or #. They are listed
  in FACTUAL CONTEXT under explicit_references and are authoritative:
    * @ references with kind="intent" point to one exact existing Planner
      intent_id. Use that exact id instead of fuzzy title matching.
    * @ references with kind="todo" point to one exact existing item in
      "Do zrobienia". If the user asks to plan/place it, use schedule_todo with
      that exact todo_id. NEVER replace it with create_task, because that would
      duplicate the existing inbox item.
    * # references point to an explicit work category. Apply that category when
      the user's instruction concerns the referenced/new item. Category never
      changes scheduling priority.
  If an @ reference is stale or missing from FACTUAL CONTEXT, ask rather than
  guessing another item.
- Categories describe the area of life/work and NEVER affect scheduling priority:
    * category="cmr" for CMR,
    * category="macheta_data" for Macheta Data,
    * category="private" for personal matters.
  Set category only when the user's wording or FACTUAL CONTEXT supports it.
  Do not guess a category from urgency or priority.
- create_task requires title, date, minutes, quadrant.
  For an explicit task time, also set start_min and start_mode:
    * start_mode="fixed" when the user says the task MUST start then, exactly
      then, gives a strict range such as "8:30-9:30", or says not to move it.
    * start_mode="preferred" for wording such as "najlepiej", "około",
      "jeśli się da", or a mere preference.
  If the user says "musi się zaczynać o 8:30, jeśli nie dasz rady napisz",
  propose start_min=510 and start_mode="fixed". Never silently substitute 9:00.
- create_meeting requires title, date, start_min, minutes.
- create_break represents an actual protected break in Planner, not a sentence
  in the reply. It requires date, start_min and minutes; title may be "Przerwa".
  If the user asks for a break between two known fixed blocks, calculate its
  start and duration from those blocks. If the boundaries are not known, ask.
  Never say a break was/will be added unless create_break is present in actions.
- swap_tasks is for an explicit request to exchange the current calendar
  positions of two existing one-shot tasks. It requires intent_id and
  second_intent_id, both copied from FACTUAL CONTEXT. Never emulate a swap with
  two reschedule_task actions: the first move can collide with the second task.
  Never guess either id.
- reschedule_task edits an existing one-shot task. It requires intent_id from
  FACTUAL CONTEXT and at least one requested change among date, start_min or
  minutes. Use it for "move", "change the time", "make it 45 minutes",
  "shorten/extend", or any combination of those. Omitted fields mean "keep the
  task's current value". Never guess an intent_id.
- reschedule_break does the same for an existing protected break/buffer. Use it
  whenever the user asks to move, shorten, extend or otherwise change an
  existing break. It requires the break's intent_id from FACTUAL CONTEXT and at
  least one of date, start_min or minutes. Never replace an existing break with
  create_break unless the user explicitly asked for an additional new break.
- reschedule_meeting edits an existing Horolog meeting. It requires the
  meeting's intent_id from FACTUAL CONTEXT and at least one of date, start_min
  or minutes. Omitted fields keep their current values. Use it for moving or
  resizing an existing meeting; preserve the meeting itself rather than
  creating a second meeting.
- complete_task requires an intent_id from FACTUAL CONTEXT.
- delete_tasks_for_date deletes active, one-shot task-kind items whose complete
  current schedule falls on one date. It requires date. Use it only for explicit
  bulk requests such as "usuń wszystkie zadania z 10.10.2026". It does not
  delete meetings, breaks, habits, focus blocks, recurring tasks, completed
  tasks or tasks split across multiple dates. This is a mutating proposal and
  still requires UI confirmation.
- schedule_todo moves one existing "Do zrobienia" item into Daily/Planner
  without creating a duplicate inbox task. It requires todo_id copied from an
  explicit todo reference or FACTUAL CONTEXT, plus date and quadrant.
  * quadrant 1/2 makes it actionable and therefore creates/links a Planner task;
    quadrant 3/4 keeps it note-only in Daily.
  * If the user gives an exact/preferred clock time for a Q1/Q2 item, also set
    start_min and start_mode just like create_task.
  * Do not copy title/minutes/category/deadline into a new task; the backend
    uses the existing todo item's authoritative metadata.
- find_time is informational and NEVER mutates the plan. Use it when the user
  asks "znajdź mi miejsce", "kiedy mam wolne", "gdzie zmieszczę X minut" or
  equivalent. It requires date and minutes. Optional:
    * search_days = number of consecutive calendar days to search (default 1),
    * count = how many usable slots are requested (default 3),
    * window_start_min/window_end_min for explicit boundaries such as "before 17".
  Use category only as descriptive context; it does not change availability.
  Do not fabricate free slots in the reply: backend will calculate them from
  the authoritative plan and append the result.
- update_daily_plan requires date and at least win_condition or first_step.
  Use update_daily_plan ONLY when the user explicitly asks to change Daily,
  "Dzisiaj wygrywam", "Zaczynam od", or a first step. Do not use it as a
  substitute for an ordinary task or meeting.
- When a meeting is mentioned together with preparation, treat the meeting and
  preparation as separate planning objects. Ask for missing details instead of
  collapsing preparation into Daily.
- Before confirmation, use future/proposal language ("proponuję", "dodam"),
  never claim "zaplanowałem" or "zaktualizowałem" because nothing has been
  executed yet.
- When there are proposed actions, explain them in the reply in a compact,
  human-readable way so the user knows exactly what confirmation will do.
- A correction to a pending proposal replaces the relevant pending action;
  do not duplicate it.
- For purely informational questions, return no actions.

The factual context is authoritative. If something is not there, say you do not
know rather than fabricating it.
"""


async def converse(
    messages: list[AssistantMessage],
    context: dict[str, object],
    pending_actions: list[AssistantAction] | None = None,
    provider: Provider | None = None,
    extra_instruction: str | None = None,
) -> AssistantDecision:
    now = datetime.now(settings().zone)
    transcript_lines: list[str] = []
    for message in messages[-16:]:
        transcript_lines.append(f"{message.role.upper()}: {message.content}")
        if message.references:
            transcript_lines.append(
                "EXPLICIT MESSAGE REFERENCES: "
                + json.dumps(
                    [ref.model_dump(mode="json") for ref in message.references],
                    ensure_ascii=False,
                )
            )
    transcript = "\n".join(transcript_lines)
    pending = [action.model_dump(mode="json") for action in (pending_actions or [])]
    correction = (
        f"\nSTRICT CORRECTION FOR THIS RETRY:\n{extra_instruction}\n"
        if extra_instruction
        else ""
    )
    user = (
        f"Current local time: {now.isoformat(timespec='minutes')}\n"
        f"FACTUAL CONTEXT:\n{json.dumps(context, ensure_ascii=False)}\n"
        f"PENDING PROPOSAL:\n{json.dumps(pending, ensure_ascii=False)}\n"
        f"CONVERSATION:\n{transcript}\n"
        f"{correction}"
        "Return the next assistant turn."
    )
    return await extract(AssistantDecision, SYSTEM, user, provider=provider)
