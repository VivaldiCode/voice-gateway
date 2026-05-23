"""Adapter to the Hermes agent HTTP API.

Hermes exposes an OpenAI-compatible API at the path documented in
https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server:

    POST {base_url}/v1/chat/completions
    body: {"model": "hermes-agent",
           "messages": [{"role": "user", "content": "..."}],
           "stream": true}
    response: SSE — `data: {...}` lines with `choices[0].delta.content`
              text deltas, terminated by `data: [DONE]`.

This adapter keeps per-session message history so multi-turn conversations
work without the desktop client having to resend everything. The bridge
hands us a stable ``session_id`` (the WS connection id), and we keep a
bounded deque of {role, content} entries for each one.
"""
from __future__ import annotations

import json
import logging
from collections import deque
from contextlib import asynccontextmanager
from typing import AsyncIterator, Deque, Dict, List, Optional

import aiohttp

log = logging.getLogger(__name__)

DEFAULT_MODEL = "hermes-agent"
DEFAULT_HISTORY_TURNS = 16  # last N user+assistant messages kept per session.


class HermesUpstreamError(RuntimeError):
    pass


def _extract_openai_message(body: dict) -> Optional[str]:
    """Pull the assistant message text out of a non-streaming OpenAI-shaped
    chat completion response. Returns None on shapes we don't recognise."""
    if not isinstance(body, dict):
        return None
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        # Some non-OpenAI servers return {"text": "..."} directly.
        for key in ("text", "content", "output"):
            v = body.get(key)
            if isinstance(v, str) and v.strip():
                return v
        return None
    choice = choices[0]
    if not isinstance(choice, dict):
        return None
    msg = choice.get("message") or choice.get("delta")
    if isinstance(msg, dict):
        content = msg.get("content")
        if isinstance(content, str):
            return content
    text = choice.get("text")
    if isinstance(text, str):
        return text
    return None


class HermesAdapter:
    def __init__(
        self,
        base_url: str,
        request_timeout: int = 60,
        *,
        model: str = DEFAULT_MODEL,
        history_turns: int = DEFAULT_HISTORY_TURNS,
        api_key: str = "",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        # `total` for streaming SSE chops the response off mid-stream as soon as
        # request_timeout elapses, even when Hermes is still happily producing
        # tokens. Use `sock_read` instead: the max gap between successive bytes.
        # `connect` keeps the upstream-down failure mode fast. `total` is left
        # as None so a long but actively-streaming reply is allowed to finish.
        self._timeout = aiohttp.ClientTimeout(
            total=None,
            connect=10,
            sock_connect=10,
            sock_read=max(30, request_timeout),
        )
        self._model = model
        self._api_key = api_key.strip()
        # session_id → deque of {"role": "...", "content": "..."} dicts.
        self._history: Dict[str, Deque[Dict[str, str]]] = {}
        self._history_max = max(2, history_turns)

    # ---------- session helpers ----------

    def _session_messages(self, session_id: Optional[str]) -> List[Dict[str, str]]:
        if not session_id:
            return []
        d = self._history.get(session_id)
        return list(d) if d else []

    def _record(self, session_id: Optional[str], role: str, content: str) -> None:
        if not session_id or not content.strip():
            return
        d = self._history.setdefault(session_id, deque(maxlen=self._history_max))
        d.append({"role": role, "content": content})

    def forget(self, session_id: str) -> None:
        """Drop any cached history for a session (call on WS close)."""
        self._history.pop(session_id, None)

    # ---------- HTTP ----------

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[aiohttp.ClientSession]:
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            yield session

    async def _fetch_non_stream(
        self,
        *,
        text: str,
        headers: Dict[str, str],
        messages: List[Dict[str, str]],
    ) -> Optional[str]:
        """Retry the same chat-completions request with stream=False and
        unwrap the single JSON body. Used as a fallback when the streaming
        path produces zero deltas (Hermes builds that ignore stream=true).
        Returns the assistant text or None."""
        url = f"{self._base_url}/v1/chat/completions"
        payload = {"model": self._model, "messages": messages, "stream": False}
        log.info("hermes non-stream fallback: POST %s", url)
        try:
            async with self._session() as session:
                async with session.post(url, json=payload, headers=headers) as resp:
                    body_text = await resp.text()
                    if resp.status != 200:
                        log.warning(
                            "hermes non-stream fallback returned %d: %s",
                            resp.status,
                            body_text[:200],
                        )
                        return None
                    try:
                        body = json.loads(body_text)
                    except json.JSONDecodeError:
                        log.warning(
                            "hermes non-stream fallback body not JSON: %s",
                            body_text[:200],
                        )
                        # Some servers emit a plain text string directly.
                        return body_text.strip() or None
                    extracted = _extract_openai_message(body)
                    if extracted:
                        log.info(
                            "hermes non-stream fallback OK — %d chars", len(extracted)
                        )
                    else:
                        log.warning(
                            "hermes non-stream fallback parsed but no message"
                            " content (body=%s)",
                            body_text[:200],
                        )
                    return extracted
        except Exception as e:  # noqa: BLE001
            log.warning("hermes non-stream fallback failed: %s", e)
            return None

    async def stream_chat(
        self, *, text: str, session_id: Optional[str] = None
    ) -> AsyncIterator[str]:
        """Yield text deltas for one user turn, keeping session history.

        Tries the streaming endpoint first. If the upstream returns 200 but
        yields zero parseable deltas (some Hermes builds and proxies ignore
        ``stream: true`` and return one final JSON body), automatically
        retries the same request with ``stream: false`` and emits the full
        ``choices[0].message.content`` as a single delta.

        Closes the upstream connection on cancellation.
        """
        url = f"{self._base_url}/v1/chat/completions"
        messages = self._session_messages(session_id)
        messages.append({"role": "user", "content": text})
        payload = {
            "model": self._model,
            "messages": messages,
            "stream": True,
        }

        # Buffer the assistant's reply so we can record it in history once
        # the stream completes successfully.
        buffered: List[str] = []
        headers: Dict[str, str] = {}
        if self._api_key:
            # OpenAI-compatible servers expect Bearer auth. Hermes' own API
            # follows that convention.
            headers["Authorization"] = f"Bearer {self._api_key}"
        try:
            async with self._session() as session:
                async with session.post(url, json=payload, headers=headers) as resp:
                    if resp.status == 401:
                        body = await resp.text()
                        hint = (
                            " (the bridge sent no Authorization header — set "
                            "hermes.api_key in /etc/hermes-voice-bridge/config.toml)"
                            if not self._api_key
                            else " (the configured hermes.api_key was rejected)"
                        )
                        raise HermesUpstreamError(
                            f"hermes returned 401:{hint} {body[:200]}"
                        )
                    if resp.status != 200:
                        body = await resp.text()
                        raise HermesUpstreamError(
                            f"hermes returned {resp.status}: {body[:200]}"
                        )
                    content_type = (resp.headers.get("Content-Type") or "").lower()
                    log.info("hermes responded 200 (Content-Type=%s)", content_type)
                    delta_count = 0
                    async for delta in _iter_sse_deltas(resp):
                        if delta:
                            delta_count += 1
                            buffered.append(delta)
                            yield delta
                    log.info(
                        "hermes stream done — %d delta(s), %d chars total",
                        delta_count,
                        sum(len(b) for b in buffered),
                    )
            if delta_count == 0:
                # The streaming endpoint returned 200 but emitted nothing
                # parseable. Some Hermes builds (and proxies in front of it)
                # ignore stream=true and reply with a single JSON body, in
                # which case the SSE parser sees no `data:` lines. Retry the
                # same request with stream=false and unwrap the OpenAI
                # response shape into one synthetic delta.
                fallback = await self._fetch_non_stream(text=text, headers=headers, messages=messages)
                if fallback:
                    buffered.append(fallback)
                    yield fallback
                else:
                    log.warning(
                        "hermes returned 200 with zero deltas AND empty"
                        " non-stream fallback — the upstream is producing no"
                        " content (check Hermes model + agent logs)"
                    )
        finally:
            full = "".join(buffered).strip()
            if full:
                # Only persist on success (we got at least one delta).
                self._record(session_id, "user", text)
                self._record(session_id, "assistant", full)


async def _iter_sse_deltas(resp: aiohttp.ClientResponse) -> AsyncIterator[str]:
    """Parse an OpenAI-compatible SSE chat-completions stream into text deltas.

    The previous implementation iterated `resp.content` directly, which yields
    arbitrary TCP-sized byte chunks — a single `data: {...}\\n\\n` event could
    be split across two chunks and decoded as two malformed half-lines. We now
    keep an internal byte buffer and only emit a line once we've seen the
    terminating newline. Accepts:

      - proper SSE  ('data: ...\\n\\n', terminated by 'data: [DONE]\\n\\n')
      - newline-delimited JSON (some proxies strip the 'data:' prefix)
      - free-text deltas (legacy/tolerant fallback)
    """
    buffer = b""
    async for chunk in resp.content.iter_any():
        if not chunk:
            continue
        buffer += chunk
        while b"\n" in buffer:
            raw_line, buffer = buffer.split(b"\n", 1)
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r").strip()
            if not line:
                continue
            log.debug("hermes SSE: %s", line[:160])
            if line.startswith("data:"):
                line = line[len("data:") :].strip()
            if line in ("", "[DONE]"):
                continue
            yielded = _extract_delta(line)
            if yielded:
                yield yielded
    # Flush any tail without a trailing newline (some servers terminate the
    # stream without one).
    tail = buffer.decode("utf-8", errors="replace").strip()
    if tail:
        log.debug("hermes SSE tail: %s", tail[:160])
        if tail.startswith("data:"):
            tail = tail[len("data:") :].strip()
        if tail and tail != "[DONE]":
            yielded = _extract_delta(tail)
            if yielded:
                yield yielded


def _extract_delta(line: str) -> Optional[str]:
    """Pull the assistant text out of one already-trimmed SSE payload."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return line
    if not isinstance(obj, dict):
        return None
    # OpenAI chat.completion.chunk shape:
    #   {"choices": [{"delta": {"content": "..."}, "finish_reason": ...}]}
    choices = obj.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            delta = choice.get("delta") or choice.get("message")
            if isinstance(delta, dict):
                content = delta.get("content")
                if isinstance(content, str) and content:
                    return content
    # Fall through for non-OpenAI shapes.
    for key in ("delta", "text", "content"):
        v = obj.get(key)
        if isinstance(v, str) and v:
            return v
    return None
