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


class HermesAdapter:
    def __init__(
        self,
        base_url: str,
        request_timeout: int = 60,
        *,
        model: str = DEFAULT_MODEL,
        history_turns: int = DEFAULT_HISTORY_TURNS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = aiohttp.ClientTimeout(total=request_timeout)
        self._model = model
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

    async def stream_chat(
        self, *, text: str, session_id: Optional[str] = None
    ) -> AsyncIterator[str]:
        """Yield text deltas for one user turn, keeping session history.

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
        try:
            async with self._session() as session:
                async with session.post(url, json=payload) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        raise HermesUpstreamError(
                            f"hermes returned {resp.status}: {body[:200]}"
                        )
                    async for delta in _iter_sse_deltas(resp):
                        if delta:
                            buffered.append(delta)
                            yield delta
        finally:
            full = "".join(buffered).strip()
            if full:
                # Only persist on success (we got at least one delta).
                self._record(session_id, "user", text)
                self._record(session_id, "assistant", full)


async def _iter_sse_deltas(resp: aiohttp.ClientResponse) -> AsyncIterator[str]:
    """Parse an OpenAI-compatible SSE chat-completions stream into text deltas.

    Accepts both proper SSE (`data: ...` prefix) and plain newline-delimited
    JSON, since some proxies strip the prefix. Yields the empty string when
    the upstream sends a finish_reason without delta content.
    """
    async for raw in resp.content:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[len("data:") :].strip()
        if line in ("", "[DONE]"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            # Some Hermes builds emit plain text deltas without JSON wrapping.
            yield line
            continue
        if not isinstance(obj, dict):
            continue
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
                        yield content
                        continue
        # Fall through for non-OpenAI-shaped payloads (older / tolerant path):
        for key in ("delta", "text", "content"):
            v = obj.get(key)
            if isinstance(v, str) and v:
                yield v
                break
