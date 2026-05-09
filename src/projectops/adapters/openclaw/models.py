"""Placeholder OpenClaw-like message and response models."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from projectops.json_io import CONTRACT_VERSION


class OpenClawMessage(BaseModel):
    """Normalized placeholder message for future OpenClaw payloads."""

    channel_id: str
    user_id: str
    message_id: str
    text: str
    timestamp: str
    thread_id: Optional[str] = None
    reply_to_message_id: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class OpenClawResponse(BaseModel):
    """Normalized placeholder response for future OpenClaw-like channels."""

    contract_version: str = CONTRACT_VERSION
    channel_id: str
    thread_id: Optional[str] = None
    reply_to_message_id: Optional[str] = None
    text: str
    event_type: str
    request_id: str
    requires_confirmation: bool
    ok: bool
    error_type: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
