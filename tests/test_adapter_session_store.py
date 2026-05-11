from pathlib import Path

import pytest

from weaveflow.adapters import AdapterSession, AdapterSessionStore
from weaveflow.adapters.openclaw import (
    OpenClawAdapter,
    OpenClawMessage,
    OpenClawSessionStore,
)


def msg(
    text: str,
    message_id: str,
    *,
    channel: str = "channel-1",
    user: str = "user-1",
    thread: str | None = "thread-1",
) -> OpenClawMessage:
    return OpenClawMessage(
        channel_id=channel,
        user_id=user,
        message_id=message_id,
        text=text,
        timestamp="2026-05-09T00:00:00Z",
        thread_id=thread,
    )


def test_adapter_session_store_imports() -> None:
    assert AdapterSessionStore
    assert OpenClawSessionStore


def test_get_or_create_session_returns_adapter_session(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    session = store.get_or_create_session("channel:user:thread", tmp_path)

    assert isinstance(session, AdapterSession)


def test_same_key_returns_same_session_object(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    first = store.get_or_create_session("key-1", tmp_path)
    second = store.get_or_create_session("key-1", tmp_path)

    assert first is second


def test_different_keys_return_different_sessions(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    first = store.get_or_create_session("key-1", tmp_path)
    second = store.get_or_create_session("key-2", tmp_path)

    assert first is not second


def test_has_session_behavior(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    assert store.has_session("key-1") is False
    store.get_or_create_session("key-1", tmp_path)
    assert store.has_session("key-1") is True


def test_pending_request_lifecycle() -> None:
    store = AdapterSessionStore()

    store.set_latest_pending("key-1", "req-1")
    assert store.get_latest_pending("key-1") == "req-1"

    store.clear_latest_pending("key-1")
    assert store.get_latest_pending("key-1") is None


def test_list_session_keys(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    store.get_or_create_session("key-b", tmp_path)
    store.get_or_create_session("key-a", tmp_path)

    assert store.list_session_keys() == ["key-a", "key-b"]


def test_clear_session_removes_session_and_pending(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    store.get_or_create_session("key-1", tmp_path)
    store.set_latest_pending("key-1", "req-1")
    store.clear_session("key-1")

    assert store.has_session("key-1") is False
    assert store.get_latest_pending("key-1") is None


def test_clear_all_removes_sessions_and_pending(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    store.get_or_create_session("key-1", tmp_path)
    store.get_or_create_session("key-2", tmp_path)
    store.set_latest_pending("key-1", "req-1")
    store.set_latest_pending("key-2", "req-2")
    store.clear_all()

    assert store.list_session_keys() == []
    assert store.get_latest_pending("key-1") is None
    assert store.get_latest_pending("key-2") is None


def test_empty_session_key_raises_clean_error(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    with pytest.raises(ValueError, match="session_key"):
        store.get_or_create_session("", tmp_path)

    with pytest.raises(ValueError, match="session_key"):
        store.set_latest_pending("", "req-1")


def test_session_store_has_no_filesystem_side_effects(tmp_path: Path) -> None:
    store = AdapterSessionStore()

    store.get_or_create_session("key-1", tmp_path)

    assert not (tmp_path / ".weaveflow").exists()


def test_openclaw_session_store_remains_compatible(tmp_path: Path) -> None:
    store = OpenClawSessionStore()

    session = store.get_or_create_session("key-1", tmp_path)
    store.set_latest_pending("key-1", "req-1")

    assert isinstance(session, AdapterSession)
    assert store.get_latest_pending("key-1") == "req-1"
    store.clear_latest_pending("key-1")
    assert store.get_latest_pending("key-1") is None


def test_openclaw_adapter_still_works_with_default_store(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    status = adapter.handle_message(msg("status", "m-status"))
    pending = adapter.handle_message(msg("init workspace", "m-init"))
    confirmed = adapter.handle_message(msg("yes", "m-yes"))

    assert status.ok is True
    assert pending.event_type == "pending_confirmation"
    assert confirmed.ok is True
    assert (tmp_path / ".weaveflow").is_dir()


def test_openclaw_adapter_works_with_injected_store(tmp_path: Path) -> None:
    store = OpenClawSessionStore()
    adapter = OpenClawAdapter(tmp_path, session_store=store)

    pending = adapter.handle_message(msg("init workspace", "m-init"))
    confirmed = adapter.handle_message(msg("yes", "m-yes"))

    assert pending.event_type == "pending_confirmation"
    assert confirmed.ok is True
    assert (tmp_path / ".weaveflow").is_dir()


def test_openclaw_session_isolation_still_works(tmp_path: Path) -> None:
    adapter = OpenClawAdapter(tmp_path)

    adapter.handle_message(msg("init workspace", "a-init", user="user-a"))
    user_b = adapter.handle_message(msg("yes", "b-yes", user="user-b"))

    assert user_b.ok is False
    assert user_b.error_type == "PendingConfirmationNotFound"
    assert not (tmp_path / ".weaveflow").exists()

    user_a = adapter.handle_message(msg("yes", "a-yes", user="user-a"))

    assert user_a.ok is True
    assert (tmp_path / ".weaveflow").is_dir()
