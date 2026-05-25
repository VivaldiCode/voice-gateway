#!/usr/bin/env python3
"""Boot a real hermes-voice-bridge with a scripted adapter for vitest specs.

Used by `tests/integration/connector-bridge.test.ts` (round-12 issue #14
B1 follow-up) to exercise the full **desktop client → Python bridge →
adapter** flow without faking either side.

The script speaks a tiny protocol to its parent over stderr/stdout so
the vitest harness can pick up the port + scenario state:

  stdout (line-buffered, one line):
      LISTENING port=NNNN token=<value>

  stderr (line-buffered): log lines (forwarded to vitest console when
                          VG_BRIDGE_TEST_VERBOSE=1).

Scenarios (env `VG_BRIDGE_TEST_MODE`):
  happy       — adapter yields three deltas + ends cleanly
  silent-crash — adapter raises RuntimeError before any yield
  upstream-hang — adapter sleeps long enough to exceed the wall-clock
                  cap (test monkey-patches the cap to 1 s before boot)
  empty-response — adapter yields nothing (and finishes successfully)
"""
from __future__ import annotations

import asyncio
import os
import sys
from typing import AsyncIterator, Optional

from aiohttp import web

# Allow this script to import the bridge from the source tree without
# having to `pip install -e .` it first.
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_SRC = os.path.normpath(
    os.path.join(HERE, "..", "..", "..", "server", "hermes-voice-bridge", "src")
)
if SERVER_SRC not in sys.path:
    sys.path.insert(0, SERVER_SRC)

from hermes_voice_bridge.config import BridgeConfig  # noqa: E402
from hermes_voice_bridge.hermes_adapter import HermesAdapter  # noqa: E402
from hermes_voice_bridge.server import build_app  # noqa: E402
import hermes_voice_bridge.server as server_mod  # noqa: E402


TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz"
MODE = os.environ.get("VG_BRIDGE_TEST_MODE", "happy")


class _ScriptedAdapter(HermesAdapter):
    """Adapter whose stream_chat behaviour is dictated by VG_BRIDGE_TEST_MODE."""

    def __init__(self) -> None:
        super().__init__("http://unused", 5)

    async def stream_chat(
        self, *, text: str, session_id: Optional[str] = None
    ) -> AsyncIterator[str]:
        if MODE == "silent-crash":
            raise RuntimeError("simulated upstream crash from scripted adapter")
        if MODE == "upstream-hang":
            # Sleep way past the wall-clock cap. The bridge's wait_for
            # is supposed to cancel us and emit HERMES_UPSTREAM.
            await asyncio.sleep(30)
            yield "unreachable"
            return
        if MODE == "empty-response":
            # No yields, no error — exercises the "Hermes respondeu mas
            # sem texto" branch in _run_turn_inner.
            if False:
                yield ""
            return
        # happy
        for chunk in ("olá ", "humano", "!"):
            yield chunk


async def _amain() -> None:
    # Tighten the wall-clock for the hang test so the spec runs fast.
    if MODE == "upstream-hang":
        server_mod.RUN_TURN_WALL_CLOCK_SECONDS = 1

    config = BridgeConfig(
        host="127.0.0.1",
        port=0,
        token=TOKEN,
        hermes_base_url="http://unused",
        hermes_request_timeout=5,
        hermes_api_key="",
    )
    app = build_app(config, adapter=_ScriptedAdapter())
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host="127.0.0.1", port=0)
    await site.start()
    # site.name is something like 'http://127.0.0.1:54321' — pull the port out.
    server = site._server  # noqa: SLF001 — public API doesn't expose port
    sockets = server.sockets or []
    if not sockets:
        print("FATAL no sockets bound", file=sys.stderr, flush=True)
        sys.exit(1)
    port = sockets[0].getsockname()[1]
    # Announce readiness to the vitest harness on stdout (one line, parseable).
    print(f"LISTENING port={port} token={TOKEN}", flush=True)

    # Keep running until parent kills us via SIGTERM (vitest's after-each).
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        sys.exit(0)
