"""Persistent diagnostic events with strict metadata allowlisting."""

from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import delete, select

from horolog.db import SystemLogRow, session
from horolog.settings import settings

logger = logging.getLogger(__name__)

LogLevel = Literal["info", "warning", "error"]
_SENSITIVE_FRAGMENTS = ("authorization", "password", "secret", "token", "api_key")


def _safe_details(details: dict[str, Any] | None) -> dict[str, str | int | float | bool | None]:
    safe: dict[str, str | int | float | bool | None] = {}
    for key, value in (details or {}).items():
        normalised_key = str(key)[:64]
        if any(fragment in normalised_key.lower() for fragment in _SENSITIVE_FRAGMENTS):
            safe[normalised_key] = "[redacted]"
        elif value is None or isinstance(value, (int, float, bool)):
            safe[normalised_key] = value
        elif isinstance(value, str):
            safe[normalised_key] = value[:300]
    return safe


async def record_system_log(
    *,
    level: LogLevel,
    category: str,
    event: str,
    message: str,
    correlation_id: str | None = None,
    method: str | None = None,
    path: str | None = None,
    provider: str | None = None,
    status_code: int | None = None,
    exception_type: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Store one event without ever affecting the operation being diagnosed."""

    try:
        async with asyncio.timeout(2):
            async with asynccontextmanager(session)() as db:
                now = datetime.now(UTC)
                db.add(
                    SystemLogRow(
                        id=uuid.uuid4().hex,
                        created_at=now,
                        level=level,
                        category=category[:32],
                        event=event[:64],
                        message=message[:300],
                        correlation_id=correlation_id[:32] if correlation_id else None,
                        method=method[:10] if method else None,
                        path=path[:300] if path else None,
                        provider=provider[:32] if provider else None,
                        status_code=status_code,
                        exception_type=exception_type[:128] if exception_type else None,
                        details=_safe_details(details),
                    )
                )
                cutoff = now - timedelta(days=settings().system_log_retention_days)
                await db.execute(delete(SystemLogRow).where(SystemLogRow.created_at < cutoff))

                overflow_ids = (
                    (
                        await db.execute(
                            select(SystemLogRow.id)
                            .order_by(SystemLogRow.created_at.desc(), SystemLogRow.id.desc())
                            .offset(settings().system_log_max_rows)
                        )
                    )
                    .scalars()
                    .all()
                )
                if overflow_ids:
                    await db.execute(delete(SystemLogRow).where(SystemLogRow.id.in_(overflow_ids)))
                await db.commit()
    except Exception:
        logger.warning("Could not persist a system log event", exc_info=True)
