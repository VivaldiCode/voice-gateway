"""Adapter to the existing Hermes agent HTTP API.

Default assumption (documented in README): Hermes exposes
    POST {base_url}/chat
    body: {"text": "...", "session_id": "...", "stream": true}
    response: text/event-stream of {"delta": "..."} events.

If the real Hermes uses a different shape, override `HermesAdapter` or
edit this file — keep the async iterator interface.
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

import aiohttp

log = logging.getLogger(__name__)


class HermesAdapter:
    def __init__(self, base_url: str, request_timeout: int = 30) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = aiohttp.ClientTimeout(total=request_timeout)

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[aiohttp.ClientSession]:
        async with aiohttp.ClientSession(timeout=self._timeout) as session:
            yield session

    async def stream_chat(
        self, *, text: str, session_id: Optional[str] = None
    ) -> AsyncIterator[str]:
        """Yield response text deltas. Closes the upstream on cancellation."""
        url = f"{self._base_url}/chat"
        payload = {"text": text, "stream": True}
        if session_id:
            payload["session_id"] = session_id
        async with self._session() as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    raise HermesUpstreamError(
                        f"hermes returned {resp.status}: {body[:200]}"
                    )
                async for raw in resp.content:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    # Tolerant SSE-style parser: strip `data:` prefix if present.
                    if line.startswith("data:"):
                        line = line[len("data:") :].strip()
                    if line in ("[DONE]", ""):
                        continue
                    try:
                        delta = json.loads(line)
                    except json.JSONDecodeError:
                        # Plain-text streaming: treat as a chunk.
                        yield line
                        continue
                    if isinstance(delta, dict):
                        for key in ("delta", "text", "content"):
                            v = delta.get(key)
                            if isinstance(v, str) and v:
                                yield v
                                break


class HermesUpstreamError(RuntimeError):
    pass
