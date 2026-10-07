from __future__ import annotations

import pytest
from pydantic import ValidationError

from horolog.assistant import AssistantMessage


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
