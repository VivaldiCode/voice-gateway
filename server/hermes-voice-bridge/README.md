# hermes-voice-bridge

WebSocket bridge between the Voice Gateway desktop app and your Hermes agent.

## What it does

Speaks the [Voice Gateway WebSocket protocol](../../docs/PROTOCOL.md) and
translates each turn into an HTTP call against the local Hermes API. By
default it assumes Hermes exposes:

```
POST {base_url}/chat
body: {"text": "...", "session_id": "...", "stream": true}
response: stream of {"delta": "..."} chunks (one per line, optional `data:` prefix)
```

If your Hermes uses a different request/response shape, edit
[`hermes_adapter.py`](src/hermes_voice_bridge/hermes_adapter.py). Keep the
`async def stream_chat(...)` signature and the async-iterator return type;
the WS server only depends on that contract.

## Install (production)

Use the top-level installer:

```bash
curl -fsSL https://raw.githubusercontent.com/<user>/voice-gateway/main/server/install.sh | bash
```

The installer creates a virtualenv at `/opt/hermes-voice-bridge`, writes
`/etc/hermes-voice-bridge/config.toml`, generates a 32-byte pairing token,
and enables a systemd service.

## Develop locally

```bash
cd server/hermes-voice-bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
HERMES_VOICE_BRIDGE_CONFIG=$(pwd)/dev-config.toml hermes-voice-bridge
```

Example `dev-config.toml`:

```toml
[bridge]
host = "127.0.0.1"
port = 8765
token = "dev-token-please-change-me"

[hermes]
base_url = "http://localhost:8000"
request_timeout = 30
```

## Tests

```bash
pip install -e ".[dev]"
pytest
```
