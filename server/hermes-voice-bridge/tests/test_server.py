"""Integration tests for the hermes-voice-bridge WS server."""
from __future__ import annotations

import json
from typing import AsyncIterator, List

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient

from hermes_voice_bridge import __version__
from hermes_voice_bridge.auth import extract_bearer, is_valid_token
from hermes_voice_bridge.config import BridgeConfig
from hermes_voice_bridge.hermes_adapter import HermesAdapter
from hermes_voice_bridge.server import build_app


TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz"


class _StaticAdapter(HermesAdapter):
    """Replaces upstream HTTP with a scripted iterator for tests."""

    def __init__(self, deltas: List[str]) -> None:
        super().__init__("http://unused", 5)
        self._deltas = list(deltas)

    async def stream_chat(self, *, text: str, session_id=None) -> AsyncIterator[str]:
        for d in self._deltas:
            yield d


def _config() -> BridgeConfig:
    return BridgeConfig(
        host="127.0.0.1",
        port=0,
        token=TOKEN,
        hermes_base_url="http://unused",
        hermes_request_timeout=5,
    )


@pytest.fixture
async def client(aiohttp_client) -> TestClient:
    app = build_app(_config(), adapter=_StaticAdapter(["olá ", "humano"]))
    return await aiohttp_client(app)


# ---------- auth helpers ----------

def test_extract_bearer_valid() -> None:
    assert extract_bearer("Bearer abc") == "abc"
    assert extract_bearer("bearer abc") == "abc"
    assert extract_bearer("Bearer   abc") == "abc"


def test_extract_bearer_invalid() -> None:
    assert extract_bearer(None) is None
    assert extract_bearer("") is None
    assert extract_bearer("Basic abc") is None
    assert extract_bearer("Bearer") is None


def test_is_valid_token_constant_time() -> None:
    assert is_valid_token("abc", "abc") is True
    assert is_valid_token("abc", "ab") is False
    assert is_valid_token("abc", None) is False


# ---------- config ----------

def test_config_requires_token() -> None:
    with pytest.raises(ValueError):
        BridgeConfig.from_dict({"bridge": {"port": 8765}})


def test_config_defaults() -> None:
    cfg = BridgeConfig.from_dict({"bridge": {"token": "x"}})
    assert cfg.host == "0.0.0.0"
    assert cfg.port == 8765
    assert cfg.hermes_base_url == "http://localhost:8642"


# ---------- server ----------

async def test_healthz(client: TestClient) -> None:
    resp = await client.get("/healthz")
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True
    assert body["version"] == __version__


async def test_ws_rejects_missing_token(client: TestClient) -> None:
    resp = await client.get("/ws")
    assert resp.status == 401


async def test_ws_rejects_bad_token(client: TestClient) -> None:
    resp = await client.get("/ws", headers={"Authorization": "Bearer wrong"})
    assert resp.status == 401


async def test_ws_welcome_after_hello(client: TestClient) -> None:
    ws = await client.ws_connect("/ws", headers={"Authorization": f"Bearer {TOKEN}"})
    await ws.send_json({"type": "hello", "client_version": "0.1.0", "capabilities": ["stt_local"]})
    msg = await ws.receive_json(timeout=2)
    assert msg["type"] == "welcome"
    assert "session_id" in msg
    assert isinstance(msg["capabilities"], list)
    await ws.close()


async def test_ws_ping_pong(client: TestClient) -> None:
    ws = await client.ws_connect("/ws", headers={"Authorization": f"Bearer {TOKEN}"})
    await ws.send_json({"type": "hello", "client_version": "0.1.0", "capabilities": []})
    await ws.receive_json(timeout=2)  # welcome
    await ws.send_json({"type": "ping"})
    msg = await ws.receive_json(timeout=2)
    assert msg["type"] == "pong"
    await ws.close()


async def test_ws_full_turn_yields_thinking_then_deltas_then_end(client: TestClient) -> None:
    ws = await client.ws_connect("/ws", headers={"Authorization": f"Bearer {TOKEN}"})
    await ws.send_json({"type": "hello", "client_version": "0.1.0", "capabilities": []})
    await ws.receive_json(timeout=2)  # welcome
    await ws.send_json(
        {"type": "transcript", "turn_id": "t1", "text": "olá", "final": True}
    )
    types = []
    last_text = None
    for _ in range(8):
        msg = await ws.receive_json(timeout=2)
        types.append(msg["type"])
        if msg["type"] == "response_text" and msg.get("final"):
            last_text = msg["text"]
        if msg["type"] == "response_end":
            break
    assert "thinking" in types
    assert types.count("response_text") >= 1
    assert types[-1] == "response_end"
    assert last_text == "olá humano"
    await ws.close()


async def test_ws_invalid_json_yields_error_frame(client: TestClient) -> None:
    ws = await client.ws_connect("/ws", headers={"Authorization": f"Bearer {TOKEN}"})
    await ws.send_str("not json at all")
    msg = await ws.receive_json(timeout=2)
    assert msg["type"] == "error"
    assert msg["code"] == "WS_INVALID_MESSAGE"
    await ws.close()


async def test_ws_unknown_type_yields_error(client: TestClient) -> None:
    ws = await client.ws_connect("/ws", headers={"Authorization": f"Bearer {TOKEN}"})
    await ws.send_json({"type": "hello", "client_version": "0.1.0", "capabilities": []})
    await ws.receive_json(timeout=2)
    await ws.send_json({"type": "nonsense", "turn_id": "x"})
    msg = await ws.receive_json(timeout=2)
    assert msg["type"] == "error"
    await ws.close()


# ---------- HermesAdapter against a fake Hermes (real HTTP) ----------

async def _fake_hermes_chat(request: web.Request) -> web.StreamResponse:
    """Pretend to be Hermes at /v1/chat/completions, OpenAI-compatible SSE."""
    payload = await request.json()
    assert payload["model"] == "hermes-agent"
    assert payload["stream"] is True
    # Echo back the last user message as 3 SSE deltas.
    last = payload["messages"][-1]["content"]
    resp = web.StreamResponse(status=200, headers={"Content-Type": "text/event-stream"})
    await resp.prepare(request)
    for chunk in (f"ouvi-te dizer: ", f"{last}", ". confirmado."):
        line = json.dumps({"choices": [{"delta": {"content": chunk}}]})
        await resp.write(f"data: {line}\n\n".encode())
    await resp.write(b"data: [DONE]\n\n")
    await resp.write_eof()
    return resp


@pytest.fixture
async def fake_hermes_url(aiohttp_server) -> str:
    app = web.Application()
    app.router.add_post("/v1/chat/completions", _fake_hermes_chat)
    server = await aiohttp_server(app)
    return f"http://127.0.0.1:{server.port}"


async def test_hermes_adapter_parses_openai_sse_stream(fake_hermes_url: str) -> None:
    adapter = HermesAdapter(fake_hermes_url, request_timeout=5)
    deltas: List[str] = []
    async for d in adapter.stream_chat(text="testing 123"):
        deltas.append(d)
    assert "".join(deltas) == "ouvi-te dizer: testing 123. confirmado."


async def test_hermes_adapter_keeps_per_session_history(fake_hermes_url: str) -> None:
    adapter = HermesAdapter(fake_hermes_url, request_timeout=5, history_turns=8)
    # First turn populates history.
    [_ async for _ in adapter.stream_chat(text="primeira", session_id="s1")]
    # Verify history exists for the session.
    assert adapter._session_messages("s1") == [  # type: ignore[attr-defined]
        {"role": "user", "content": "primeira"},
        {"role": "assistant", "content": "ouvi-te dizer: primeira. confirmado."},
    ]
    adapter.forget("s1")
    assert adapter._session_messages("s1") == []  # type: ignore[attr-defined]


async def test_hermes_adapter_propagates_upstream_failure(aiohttp_server) -> None:
    async def boom(_request: web.Request) -> web.Response:
        return web.Response(status=503, text="overloaded")

    app = web.Application()
    app.router.add_post("/v1/chat/completions", boom)
    server = await aiohttp_server(app)
    adapter = HermesAdapter(f"http://127.0.0.1:{server.port}", request_timeout=5)
    with pytest.raises(Exception, match="hermes returned 503"):
        async for _ in adapter.stream_chat(text="x"):
            pass
