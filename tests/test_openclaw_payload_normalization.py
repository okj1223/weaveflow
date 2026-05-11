import copy
import json
from pathlib import Path

import pytest

from weaveflow.adapters.openclaw import (
    OpenClawAdapter,
    OpenClawPayloadNormalizationError,
    OpenClawResponse,
    normalize_openclaw_message_payload,
    openclaw_response_to_payload,
)


ROOT = Path(__file__).resolve().parents[1]
OPENCLAW_SRC = ROOT / "src" / "weaveflow" / "adapters" / "openclaw"


def canonical_payload() -> dict[str, object]:
    return {
        "channel_id": "channel-1",
        "user_id": "user-1",
        "message_id": "message-1",
        "text": "status",
        "timestamp": "2026-05-09T00:00:00Z",
    }


def alias_payload(text: str = "status", message_id: str = "message-1") -> dict[str, object]:
    return {
        "channelId": "channel-1",
        "userId": "user-1",
        "messageId": message_id,
        "content": text,
        "createdAt": "2026-05-09T00:00:00Z",
        "threadId": "thread-1",
        "replyToMessageId": "reply-1",
    }


def test_openclaw_payload_normalization_imports() -> None:
    assert normalize_openclaw_message_payload
    assert openclaw_response_to_payload
    assert OpenClawPayloadNormalizationError
    assert OpenClawAdapter


def test_canonical_payload_normalization() -> None:
    message = normalize_openclaw_message_payload(canonical_payload())

    assert message.channel_id == "channel-1"
    assert message.user_id == "user-1"
    assert message.message_id == "message-1"
    assert message.text == "status"
    assert message.timestamp == "2026-05-09T00:00:00Z"
    assert message.metadata == {}


def test_alias_payload_normalization() -> None:
    message = normalize_openclaw_message_payload(alias_payload())

    assert message.channel_id == "channel-1"
    assert message.user_id == "user-1"
    assert message.message_id == "message-1"
    assert message.text == "status"
    assert message.timestamp == "2026-05-09T00:00:00Z"
    assert message.thread_id == "thread-1"
    assert message.reply_to_message_id == "reply-1"


def test_alternative_aliases_normalize() -> None:
    payload = {
        "channel": "channel-1",
        "sender_id": "user-1",
        "id": "message-1",
        "body": "doctor",
        "ts": "2026-05-09T00:00:00Z",
    }

    message = normalize_openclaw_message_payload(payload)

    assert message.channel_id == "channel-1"
    assert message.user_id == "user-1"
    assert message.message_id == "message-1"
    assert message.text == "doctor"
    assert message.timestamp == "2026-05-09T00:00:00Z"


def test_metadata_handling() -> None:
    payload = canonical_payload()
    payload["metadata"] = {"source": "test"}

    message = normalize_openclaw_message_payload(payload)

    assert message.metadata == {"source": "test"}
    assert normalize_openclaw_message_payload(canonical_payload()).metadata == {}

    bad = canonical_payload()
    bad["metadata"] = "not-a-dict"
    with pytest.raises(OpenClawPayloadNormalizationError, match="metadata"):
        normalize_openclaw_message_payload(bad)


@pytest.mark.parametrize(
    "missing_aliases, expected_field",
    [
        (("channel_id", "channelId", "channel"), "channel_id"),
        (("user_id", "userId", "sender_id", "author_id"), "user_id"),
        (("message_id", "messageId", "id"), "message_id"),
        (("text", "content", "body", "message"), "text"),
        (("timestamp", "created_at", "createdAt", "ts"), "timestamp"),
    ],
)
def test_missing_required_fields_raise_clean_errors(
    missing_aliases: tuple[str, ...],
    expected_field: str,
) -> None:
    payload = canonical_payload()
    for alias in missing_aliases:
        payload.pop(alias, None)

    with pytest.raises(OpenClawPayloadNormalizationError, match=expected_field):
        normalize_openclaw_message_payload(payload)


@pytest.mark.parametrize("field", ["channel_id", "text"])
def test_empty_required_fields_raise_clean_errors(field: str) -> None:
    payload = canonical_payload()
    payload[field] = "   "

    with pytest.raises(OpenClawPayloadNormalizationError, match=field):
        normalize_openclaw_message_payload(payload)


def test_input_payload_is_not_mutated() -> None:
    payload = alias_payload()
    original = copy.deepcopy(payload)

    normalize_openclaw_message_payload(payload)

    assert payload == original


def test_openclaw_response_to_payload_is_json_safe() -> None:
    response = OpenClawResponse(
        channel_id="channel-1",
        thread_id="thread-1",
        reply_to_message_id="message-1",
        text="Done",
        event_type="turn_completed",
        request_id="message-1",
        requires_confirmation=False,
        ok=True,
        error_type=None,
        metadata={"action": "status"},
    )

    payload = openclaw_response_to_payload(response)

    assert payload["contract_version"] == "weaveflow.v1"
    assert payload["channel_id"] == "channel-1"
    assert payload["text"] == "Done"
    assert payload["event_type"] == "turn_completed"
    assert payload["request_id"] == "message-1"
    assert payload["requires_confirmation"] is False
    assert payload["ok"] is True
    assert payload["error_type"] is None
    assert payload["metadata"] == {"action": "status"}
    json.dumps(payload)


def test_handle_payload_status_before_init(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    response = adapter.handle_payload(alias_payload("status", "m-status"))

    assert response["ok"] is True
    assert response["event_type"] == "turn_completed"
    assert response["requires_confirmation"] is False
    assert not (tmp_path / ".weaveflow").exists()


def test_handle_payload_init_confirmation(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    response = adapter.handle_payload(alias_payload("init workspace", "m-init"))

    assert response["event_type"] == "pending_confirmation"
    assert response["requires_confirmation"] is True
    assert not (tmp_path / ".weaveflow").exists()


def test_handle_payload_yes_confirmation(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    adapter.handle_payload(alias_payload("init workspace", "req-init"))
    response = adapter.handle_payload(alias_payload("yes", "req-yes"))

    assert response["ok"] is True
    assert response["event_type"] == "turn_completed"
    assert (tmp_path / ".weaveflow").is_dir()


def test_handle_payload_missing_required_field_returns_json_safe_error(
    tmp_path: Path,
) -> None:
    adapter = OpenClawAdapter(tmp_path)

    response = adapter.handle_payload({"messageId": "bad-1", "content": "status"})

    assert response["ok"] is False
    assert response["error_type"] == "OpenClawPayloadNormalizationError"
    assert response["event_type"] == "turn_error"
    assert response["requires_confirmation"] is False
    assert response["metadata"]["source"] == "normalization"
    assert not (tmp_path / ".weaveflow").exists()
    json.dumps(response)


def test_no_real_openclaw_import_dependency() -> None:
    for path in OPENCLAW_SRC.glob("*.py"):
        lines = path.read_text(encoding="utf-8").lower().splitlines()
        for line in lines:
            stripped = line.strip()
            assert not stripped.startswith("import openclaw")
            assert not stripped.startswith("from openclaw")


def test_payload_normalization_docs() -> None:
    design = (ROOT / "docs" / "openclaw_adapter_design.md").read_text(
        encoding="utf-8"
    )
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "Payload Normalization" in design
    assert "normalize_openclaw_message_payload" in design
    assert "handle_payload" in design
    assert "docs/openclaw_adapter_design.md" in readme
