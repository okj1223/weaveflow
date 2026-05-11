"""JSON rendering helpers for CLI output."""

from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel


CONTRACT_VERSION = "weaveflow.v1"


def to_jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    return value


def dumps_json(value: Any) -> str:
    return json.dumps(to_jsonable(value), indent=2)
