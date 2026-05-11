"""Small YAML read/write helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel


def model_to_data(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")


def write_yaml(path: Path, data: BaseModel | dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = model_to_data(data) if isinstance(data, BaseModel) else data
    path.write_text(
        yaml.safe_dump(payload, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data or {}
