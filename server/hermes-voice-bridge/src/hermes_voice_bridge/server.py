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
                    asyncio.create_task(
                        _run_turn(ws, adapter, turn_id, text, session_id)
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


async def _run_turn(
    ws: web.WebSocketResponse,
    adapter: HermesAdapter,
    turn_id: str,
    text: str,
    session_id: str,
) -> None:
    if ws.closed:
        return
    await ws.send_json({"type": "thinking", "turn_id": turn_id})
    try:
        buffered = ""
        async for delta in adapter.stream_chat(text=text, session_id=session_id):
            if ws.closed:
                return
            buffered += delta
            await ws.send_json(
                {"type": "response_text", "turn_id": turn_id, "text": delta, "final": False}
            )
        if not ws.closed:
            await ws.send_json(
                {"type": "response_text", "turn_id": turn_id, "text": buffered, "final": True}
            )
            await ws.send_json({"type": "response_end", "turn_id": turn_id})
    except HermesUpstreamError as err:
        log.warning("hermes upstream error: %s", err)
        if not ws.closed:
            await send_error(ws, "HERMES_UPSTREAM", str(err), turn_id=turn_id)
    except Exception as err:  # pragma: no cover - safety net
        log.exception("turn failed")
        if not ws.closed:
            await send_error(ws, "UNKNOWN", str(err), turn_id=turn_id)


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
