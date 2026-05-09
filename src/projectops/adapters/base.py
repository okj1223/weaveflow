"""Shared adapter request and response models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from projectops.json_io import CONTRACT_VERSION


class AdapterRequest(BaseModel):
    action: str
    params: dict[str, Any] = Field(default_factory=dict)
    allow_mutation: bool = False
    request_id: str | None = None


class AdapterResponse(BaseModel):
    contract_version: str = CONTRACT_VERSION
    ok: bool
    action: str
    message: str
    data: dict[str, Any] | None = None
    error_type: str | None = None
    error_message: str | None = None
    read_only: bool
    request_id: str | None = None
