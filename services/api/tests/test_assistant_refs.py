from __future__ import annotations

import pytest
from pydantic import ValidationError

from horolog.assistant import AssistantAction, AssistantMessage


def test_assistant_message_accepts_explicit_intent_and_category_references() -> None:
    message = AssistantMessage.model_validate(
        {
            "role": "user",
            "content": "Przesuń @[Raport] i dodaj #[CMR]",
            "references": [
                {
                    "kind": "intent",
                    "token": "@[Raport]",
                    "intent_id": "abc123",
                },
                {
                    "kind": "category",
                    "token": "#[CMR]",
                    "category": "cmr",
                },
            ],
        }
    )

    assert message.references[0].intent_id == "abc123"
    assert message.references[1].category.value == "cmr"


def test_assistant_reference_requires_matching_payload() -> None:
    with pytest.raises(ValidationError):
        AssistantMessage.model_validate(
            {
                "role": "user",
                "content": "Przesuń @[Raport]",
                "references": [
                    {
                        "kind": "intent",
                        "token": "@[Raport]",
                    }
                ],
            }
        )


def test_find_time_requires_date_and_duration() -> None:
    action = AssistantAction.model_validate(
        {
            "action": "find_time",
            "title": "Macheta Data",
            "date": "2026-10-08",
            "minutes": 90,
            "search_days": 1,
            "count": 3,
            "window_end_min": 17 * 60,
            "category": "macheta_data",
        }
    )

    assert action.action == "find_time"
    assert action.minutes == 90
    assert action.window_end_min == 17 * 60

    with pytest.raises(ValidationError):
        AssistantAction.model_validate(
            {
                "action": "find_time",
                "date": "2026-10-08",
            }
        )
