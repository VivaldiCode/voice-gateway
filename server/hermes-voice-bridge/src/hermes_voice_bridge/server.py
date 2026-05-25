"""aiohttp WebSocket server speaking the Voice Gateway protocol.

Authentication: clients must send `Authorization: Bearer <token>` during
the WS upgrade. Rejected with HTTP 401 otherwise.

Per-connection flow:
    client → {"type": "hello", ...}
    server → {"type": "welcome", "session_id": "...", "capabilities": [...]}
    client → {"type": "start_turn", "turn_id": "..."}
    client → {"type": "transcript", "turn_id": "...", "text": "...", "final": true}
    client → {"type": "end_turn", "turn_id": "..."}
    server → {"type": "thinking", "turn_id": "..."}
    server → {"type": "response_text", "turn_id": "...", "text": "<delta>", "final": false}
              ...
    server → {"type": "response_text", "turn_id": "...", "text": "", "final": true}
    server → {"type": "response_end", "turn_id": "..."}
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Optional

from aiohttp import WSMsgType, web

from . import __version__
from .auth import extract_bearer, is_valid_token
from .config import BridgeConfig
from .hermes_adapter import HermesAdapter, HermesUpstreamError

log = logging.getLogger(__name__)

SUPPORTED_CAPS = ["streaming_text"]


def build_app(config: BridgeConfig, adapter: Optional[HermesAdapter] = None) -> web.Application:
    app = web.Application()
    app["config"] = config
    app["adapter"] = adapter or HermesAdapter(
        config.hermes_base_url,
        config.hermes_request_timeout,
        api_key=config.hermes_api_key,
    )

    async def _auth_middleware(request: web.Request, handler):
        if request.path != "/ws":
            return await handler(request)
        token = extract_bearer(request.headers.get("Authorization"))
        if not is_valid_token(config.token, token):
            return web.Response(status=401, text="unauthorized")
        return await handler(request)

    app.middlewares.append(web.middleware(_auth_middleware))
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/healthz", health_handler)
    return app


async def health_handler(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "version": __version__})


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=15.0, compress=False)
    await ws.prepare(request)
    adapter: HermesAdapter = request.app["adapter"]
    session_id = secrets.token_hex(8)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                log.warning("ws error: %s", ws.exception())
                break
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                await send_error(ws, "WS_INVALID_MESSAGE", "invalid JSON")
                continue
            if not isinstance(data, dict):
                await send_error(ws, "WS_INVALID_MESSAGE", "expected JSON object")
                continue

            t = data.get("type")
            if t == "hello":
                await ws.send_json(
                    {
                        "type": "welcome",
                        "session_id": session_id,
                        "server_version": __version__,
                        "capabilities": SUPPORTED_CAPS,
                    }
                )
                continue
            if t == "ping":
                await ws.send_json({"type": "pong"})
                continue
            if t == "transcript":
                turn_id = str(data.get("turn_id", ""))
                text = str(data.get("text", ""))
                final = bool(data.get("final"))
                if final and text.strip():
                    log.info(
                        "received final transcript (session=%s turn=%s chars=%d)",
                        session_id,
                        turn_id,
                        len(text),
                    )
                    task = asyncio.create_task(
                        _run_turn(ws, adapter, turn_id, text, session_id)
                    )
                    # Attach a done-callback so an uncaught exception in
                    # _run_turn surfaces in logs AND the client gets an
                    # error frame instead of being silently stuck in
                    # "thinking" forever (round-12 B1: this was the
                    # documented failure mode — client hangs because the
                    # task crashed before the try/except inside _run_turn).
                    task.add_done_callback(
                        lambda t, w=ws, tid=turn_id: _log_task_outcome(t, w, tid)
                    )
                continue
            if t in {"start_turn", "end_turn", "audio_chunk", "interrupt"}:
                # Acknowledge silently. Audio path not yet wired through.
                continue

            await send_error(
                ws, "WS_INVALID_MESSAGE", f"unknown type {t!r}", turn_id=data.get("turn_id")
            )
    finally:
        # Drop the cached chat history so a reconnect is clean. (No-op on the
        # test fake adapter, which doesn't implement forget.)
        forget = getattr(adapter, "forget", None)
        if callable(forget):
            forget(session_id)
    return ws


# Wall-clock cap for one full turn. Hermes streaming should normally take
# only a few seconds; anything past this is almost certainly a stuck
# upstream (open socket, no data) and we'd rather the user see a clear
# error than stare at "A pensar" indefinitely.
RUN_TURN_WALL_CLOCK_SECONDS = 120


async def _run_turn(
    ws: web.WebSocketResponse,
    adapter: HermesAdapter,
    turn_id: str,
    text: str,
    session_id: str,
) -> None:
    if ws.closed:
        return
    log.info("run_turn start (session=%s turn=%s)", session_id, turn_id)
    await ws.send_json({"type": "thinking", "turn_id": turn_id})
    try:
        await asyncio.wait_for(
            _run_turn_inner(ws, adapter, turn_id, text, session_id),
            timeout=RUN_TURN_WALL_CLOCK_SECONDS,
        )
    except asyncio.TimeoutError:
        log.warning(
            "run_turn wall-clock timeout (%ds) session=%s turn=%s",
            RUN_TURN_WALL_CLOCK_SECONDS,
            session_id,
            turn_id,
        )
        if not ws.closed:
            await send_error(
                ws,
                "HERMES_UPSTREAM",
                f"Hermes não respondeu em {RUN_TURN_WALL_CLOCK_SECONDS}s."
                " O upstream pode estar pendurado — verifica os logs do agent.",
                turn_id=turn_id,
            )
    except HermesUpstreamError as err:
        log.warning("hermes upstream error: %s", err)
        if not ws.closed:
            await send_error(ws, "HERMES_UPSTREAM", str(err), turn_id=turn_id)
    except Exception as err:  # pragma: no cover - safety net
        # Some exceptions (aiohttp.ServerDisconnectedError, asyncio.CancelledError)
        # carry no useful str(). Always include the type so the desktop log shows
        # something actionable instead of an empty "UNKNOWN" toast.
        log.exception("turn failed")
        if not ws.closed:
            tail = str(err).strip()
            detail = f"{type(err).__name__}: {tail}" if tail else type(err).__name__
            await send_error(ws, "UNKNOWN", detail, turn_id=turn_id)
    finally:
        log.info("run_turn end (session=%s turn=%s)", session_id, turn_id)


async def _run_turn_inner(
    ws: web.WebSocketResponse,
    adapter: HermesAdapter,
    turn_id: str,
    text: str,
    session_id: str,
) -> None:
    """The actual streaming loop, factored out so the wall-clock timeout
    in _run_turn can wrap it cleanly."""
    buffered = ""
    delta_count = 0
    async for delta in adapter.stream_chat(text=text, session_id=session_id):
        if ws.closed:
            return
        buffered += delta
        delta_count += 1
        await ws.send_json(
            {"type": "response_text", "turn_id": turn_id, "text": delta, "final": False}
        )
    if ws.closed:
        return
    log.info(
        "stream complete (turn=%s deltas=%d chars=%d)",
        turn_id,
        delta_count,
        len(buffered),
    )
    if not buffered.strip():
        # Hermes accepted the request but produced no content. Surface
        # an error so the desktop user sees something actionable instead
        # of a silently-empty assistant bubble.
        await send_error(
            ws,
            "HERMES_UPSTREAM",
            "Hermes respondeu mas sem texto. Verifica os logs do agent"
            " (journalctl -u hermes-agent ou equivalente) — o modelo pode"
            " não estar carregado.",
            turn_id=turn_id,
        )
        return
    await ws.send_json(
        {"type": "response_text", "turn_id": turn_id, "text": buffered, "final": True}
    )
    await ws.send_json({"type": "response_end", "turn_id": turn_id})


def _log_task_outcome(
    task: "asyncio.Task[None]",
    ws: web.WebSocketResponse,
    turn_id: str,
) -> None:
    """Done-callback for the _run_turn task. Bare ``asyncio.create_task``
    would swallow exceptions raised before the inner try/except (e.g. an
    `await ws.send_json` failure on the initial ``thinking`` frame), and
    the client would stay stuck in "A pensar" forever. This callback both
    logs the crash and best-effort dispatches an error frame so the UI
    can recover."""
    if task.cancelled():
        log.warning("_run_turn task cancelled (turn=%s)", turn_id)
        return
    err = task.exception()
    if err is None:
        return
    log.exception("_run_turn crashed (turn=%s): %r", turn_id, err, exc_info=err)
    if ws.closed:
        return
    detail = f"{type(err).__name__}: {err}" if str(err).strip() else type(err).__name__
    # The error-frame dispatch is itself a coroutine; wrap it with its own
    # done-callback so a secondary failure (WS closed mid-write, etc.)
    # doesn't recreate the exact "task crashes silently" pattern this
    # function exists to prevent. Reviewer-suggested nit, PR #1 round-12.
    recovery = asyncio.create_task(send_error(ws, "UNKNOWN", detail, turn_id=turn_id))
    recovery.add_done_callback(lambda r, tid=turn_id: _log_recovery_outcome(r, tid))


def _log_recovery_outcome(task: "asyncio.Task[None]", turn_id: str) -> None:
    """Inner safety net for the error-frame dispatch fired from
    _log_task_outcome. Just logs — there's no further fallback to try
    once the WS itself rejected our error frame."""
    if task.cancelled():
        return
    err = task.exception()
    if err is not None:
        log.warning(
            "recovery error frame failed (turn=%s): %r — nothing more we can do",
            turn_id,
            err,
        )


async def send_error(
    ws: web.WebSocketResponse, code: str, message: str, *, turn_id: Optional[str] = None
) -> None:
    payload = {"type": "error", "code": code, "message": message}
    if turn_id:
        payload["turn_id"] = str(turn_id)
    await ws.send_json(payload)


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = BridgeConfig.from_file()
    app = build_app(config)
    log.info("hermes-voice-bridge listening on %s:%s", config.host, config.port)
    web.run_app(app, host=config.host, port=config.port, print=None)
