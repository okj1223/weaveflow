"""Channel-specific rendering policy for adapter events."""

from __future__ import annotations

import json
import re
from typing import Optional

from pydantic import BaseModel

from weaveflow.adapters.events import AdapterEvent, AdapterTranscript
from weaveflow.adapters.renderers import render_event_as_text
from weaveflow.json_io import to_jsonable


SUPPORTED_CHANNELS = {"openclaw", "slack", "telegram", "terminal", "log"}
ABSOLUTE_PATH_RE = re.compile(r"(?<![\w<])/(?:home|tmp|mnt)/[^\s,)>\]]+")
STATUS_EMOJI_PREFIXES = (
    "\u2705 ",
    "\u26a0\ufe0f ",
    "\U0001f6ab ",
    "\u274c ",
)


class ChannelRenderPolicy(BaseModel):
    channel: str
    style: str
    allow_markdown: bool
    include_emoji: bool
    include_request_id: bool
    include_error_type: bool
    include_metadata: bool
    max_length: Optional[int] = None
    multiline: bool
    redacts_absolute_paths: bool
    confirmation_hint: str


CHANNEL_POLICIES: dict[str, ChannelRenderPolicy] = {
    "openclaw": ChannelRenderPolicy(
        channel="openclaw",
        style="chat",
        allow_markdown=True,
        include_emoji=True,
        include_request_id=True,
        include_error_type=True,
        include_metadata=False,
        max_length=2000,
        multiline=True,
        redacts_absolute_paths=True,
        confirmation_hint="Reply yes to confirm or no to reject.",
    ),
    "slack": ChannelRenderPolicy(
        channel="slack",
        style="chat",
        allow_markdown=True,
        include_emoji=True,
        include_request_id=True,
        include_error_type=True,
        include_metadata=False,
        max_length=3000,
        multiline=True,
        redacts_absolute_paths=True,
        confirmation_hint="Reply yes to confirm or no to reject.",
    ),
    "telegram": ChannelRenderPolicy(
        channel="telegram",
        style="chat",
        allow_markdown=False,
        include_emoji=True,
        include_request_id=True,
        include_error_type=True,
        include_metadata=False,
        max_length=1500,
        multiline=True,
        redacts_absolute_paths=True,
        confirmation_hint="Reply yes to confirm or no to reject.",
    ),
    "terminal": ChannelRenderPolicy(
        channel="terminal",
        style="chat",
        allow_markdown=False,
        include_emoji=True,
        include_request_id=True,
        include_error_type=True,
        include_metadata=True,
        max_length=None,
        multiline=True,
        redacts_absolute_paths=False,
        confirmation_hint="Type yes to confirm or no to reject.",
    ),
    "log": ChannelRenderPolicy(
        channel="log",
        style="log",
        allow_markdown=False,
        include_emoji=False,
        include_request_id=True,
        include_error_type=True,
        include_metadata=True,
        max_length=None,
        multiline=False,
        redacts_absolute_paths=False,
        confirmation_hint="confirmation required",
    ),
}


def get_channel_render_policy(channel: str) -> ChannelRenderPolicy:
    normalized = channel.strip().lower()
    if normalized not in CHANNEL_POLICIES:
        raise ValueError(f"Unknown adapter render channel: {channel}")
    return CHANNEL_POLICIES[normalized].model_copy()


def render_event_for_channel(
    event: AdapterEvent,
    channel: str = "openclaw",
) -> str:
    policy = get_channel_render_policy(channel)
    text = render_event_as_text(event, style=policy.style)
    text = _apply_channel_policy(text, event, policy)
    return truncate_text(text, policy.max_length)


def render_transcript_for_channel(
    transcript: AdapterTranscript,
    channel: str = "openclaw",
) -> str:
    policy = get_channel_render_policy(channel)
    rendered_events = [
        render_event_for_channel(event, channel=policy.channel)
        for event in transcript.events
    ]
    separator = "\n" if policy.multiline else " | "
    text = f"Adapter transcript: {transcript.session_id}"
    if rendered_events:
        text = separator.join([text] + rendered_events)
    return truncate_text(text, policy.max_length)


def redact_absolute_paths(text: str) -> str:
    return ABSOLUTE_PATH_RE.sub("<path>", text)


def truncate_text(text: str, max_length: Optional[int]) -> str:
    if max_length is None or len(text) <= max_length:
        return text
    suffix = "... [truncated]"
    if max_length <= len(suffix):
        return suffix[:max_length]
    return text[: max_length - len(suffix)] + suffix


def collapse_multiline(text: str) -> str:
    return " ".join(text.split())


def _apply_channel_policy(
    text: str,
    event: AdapterEvent,
    policy: ChannelRenderPolicy,
) -> str:
    if not policy.include_emoji:
        text = _remove_status_emoji(text)
    if policy.include_request_id and event.request_id and event.request_id not in text:
        text = _append(text, f"Request ID: {event.request_id}", policy)
    if (
        event.event_type == "pending_confirmation"
        and policy.confirmation_hint
        and policy.confirmation_hint not in text
    ):
        text = _append(text, policy.confirmation_hint, policy)
    if policy.include_error_type and event.error_type and event.error_type not in text:
        text = _append(text, f"Error type: {event.error_type}", policy)
    if policy.include_metadata and event.data:
        metadata = json.dumps(to_jsonable(event.data), sort_keys=True)
        text = _append(text, f"Metadata: {metadata}", policy)
    if policy.redacts_absolute_paths:
        text = redact_absolute_paths(text)
    if not policy.multiline:
        text = collapse_multiline(text)
    return text


def _append(text: str, addition: str, policy: ChannelRenderPolicy) -> str:
    separator = "\n" if policy.multiline else " "
    return f"{text}{separator}{addition}"


def _remove_status_emoji(text: str) -> str:
    lines = []
    for line in text.splitlines():
        for prefix in STATUS_EMOJI_PREFIXES:
            if line.startswith(prefix):
                line = line[len(prefix) :]
                break
        lines.append(line)
    return "\n".join(lines)
