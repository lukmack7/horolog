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

from horolog.llm import Provider, extract
from horolog.settings import settings


class AssistantMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


class AssistantAction(BaseModel):
    action: Literal[
        "create_task",
        "create_meeting",
        "reschedule_task",
        "complete_task",
        "update_daily_plan",
    ]
    title: str | None = None
    intent_id: str | None = None
    date: str | None = None
    minutes: int | None = None
    quadrant: int | None = None
    start_min: int | None = None
    win_condition: str | None = None
    first_step: str | None = None

    @model_validator(mode="after")
    def _sane(self) -> "AssistantAction":
        if self.minutes is not None and self.minutes <= 0:
            raise ValueError("minutes must be positive")
        if self.quadrant is not None and self.quadrant not in (1, 2, 3, 4):
            raise ValueError("quadrant must be 1..4")
        if self.start_min is not None and not 0 <= self.start_min < 24 * 60:
            raise ValueError("start_min must be 0..1439")
        if self.date is not None:
            try:
                datetime.strptime(self.date, "%Y-%m-%d")
            except ValueError as exc:
                raise ValueError("date must be YYYY-MM-DD") from exc
        return self


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
- create_task requires title, date, minutes, quadrant.
- create_meeting requires title, date, start_min, minutes.
- reschedule_task requires an intent_id from FACTUAL CONTEXT and date; start_min
  is optional. Never guess an intent_id.
- complete_task requires an intent_id from FACTUAL CONTEXT.
- update_daily_plan requires date and at least win_condition or first_step.
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
) -> AssistantDecision:
    now = datetime.now(settings().zone)
    transcript = "\n".join(
        f"{message.role.upper()}: {message.content}" for message in messages[-16:]
    )
    pending = [action.model_dump(mode="json") for action in (pending_actions or [])]
    user = (
        f"Current local time: {now.isoformat(timespec='minutes')}\n"
        f"FACTUAL CONTEXT:\n{json.dumps(context, ensure_ascii=False)}\n"
        f"PENDING PROPOSAL:\n{json.dumps(pending, ensure_ascii=False)}\n"
        f"CONVERSATION:\n{transcript}\n"
        "Return the next assistant turn."
    )
    return await extract(AssistantDecision, SYSTEM, user, provider=provider)
