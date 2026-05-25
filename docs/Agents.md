# Agents — making Voice Gateway speak to more than just Hermes

This document is the architectural contract for plugging a new
agent backend into Voice Gateway. The desktop app already speaks a
single protocol (the WebSocket flow described in
[Protocol](Protocol.md)) — we just need a small "adapter" service
per agent that bridges that protocol to whatever the agent's
native API looks like.

## Why an abstraction at all

Voice Gateway shouldn't know about Hermes, Claude Code, ChatGPT,
Cursor, or any other agent. The desktop app does the audio, the
STT, the TTS, the FSM, and the UX. What it asks of the agent is
narrow:

  - "Here is a turn id and a user transcript. Stream me text back."
  - "Tell me when you're done so I can clear the THINKING state."
  - "Surface errors with a code I can render in a toast."

Anything the agent needs beyond that (file-system access, browser
sessions, OS automation) is the agent's own problem and stays in the
agent's process. The bridge is intentionally dumb plumbing.

## The unit of integration: a Voice Gateway Bridge

A "bridge" is a small long-lived process that:

  1. Listens on a WebSocket endpoint (`/ws`) using Voice Gateway's
     own protocol.
  2. Authenticates the desktop client via a single bearer token (the
     one the user pastes into the pairing wizard).
  3. For each incoming turn (`transcript` frame, `final=true`), calls
     the agent backend and streams the textual reply back as
     `response_text` frames followed by a `response_end`.

The reference implementation is [hermes-voice-bridge](../server/hermes-voice-bridge/),
which talks to a local Hermes daemon via its OpenAI-compatible
chat-completions endpoint. New agents follow the same shape.

## How a new agent is plugged in

Each agent ships its own **adapter** Python module that implements
a tiny interface:

```python
from typing import AsyncIterator, Optional

class AgentAdapter:
    """Minimum surface every agent needs to expose to the bridge."""

    async def stream_chat(
        self, *, text: str, session_id: Optional[str] = None
    ) -> AsyncIterator[str]:
        """Yield text deltas for one user turn, keeping session
        history. Closes the upstream on cancellation."""
        ...

    def forget(self, session_id: str) -> None:
        """Drop any cached state for a session — called on WS close."""
        ...
```

`hermes_voice_bridge.hermes_adapter.HermesAdapter` is the canonical
example. A new agent ships its own equivalent.

## install.sh: one script, many agents

The intent (round-12 I4) is for the **same** `server/install.sh`
script to work for every agent. The user picks the agent via a flag:

```bash
# Hermes (default — current behaviour)
curl -fsSL ${INSTALL_SCRIPT_URL} | bash

# Future agents:
curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --agent=claude-code
curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --agent=chatgpt
curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --agent=cursor
curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --agent=openclaw
```

Internally each agent is a small set of bash functions in
`server/install.sh` that the dispatcher calls based on the flag:

  - `agent_${name}_validate()`     — preflight checks (binary on PATH,
                                      API key reachable, etc.)
  - `agent_${name}_install_deps()` — apt / dnf / brew incantations
  - `agent_${name}_write_config()` — append agent-specific keys to
                                      `/etc/hermes-voice-bridge/config.toml`
  - `agent_${name}_systemd_unit()` — produce the systemd unit text

The dispatcher (`run_install()`) always handles the bits that are
shared across all agents:

  - The base bridge package + venv install
  - The bearer token generation
  - The `hermes-voice` system user
  - Enabling + starting the systemd unit
  - Printing the pairing block (URL + token) at the end

## Supported agents

| Agent       | Flag              | Status      | Notes |
|-------------|-------------------|-------------|-------|
| Hermes      | `--agent=hermes`  | ✅ shipping | Default. Local Hermes daemon on :8642. Uses `hermes_adapter.HermesAdapter`. |
| Claude Code | `--agent=claude-code` | 🚧 placeholder | Adapter file scaffolded but the actual SDK wiring is TBD. See [#claude-code](#claude-code) below. |
| ChatGPT     | `--agent=chatgpt` | 🚧 placeholder | Will wrap the OpenAI chat-completions API; needs `OPENAI_API_KEY` in `/etc/hermes-voice-bridge/secrets`. |
| Cursor      | `--agent=cursor`  | 🚧 placeholder | Cursor exposes no public API yet; deferred until [Cursor Agents](https://cursor.com/docs/agents) ships. |
| OpenClaw    | `--agent=openclaw`| 🚧 placeholder | Awaits OpenClaw's API spec; treat as "OpenAI-compatible" until proven otherwise. |

When you choose an unimplemented agent today the installer prints
a clear "not yet supported — see docs/Agents.md" message and
exits non-zero rather than producing a broken install.

### Claude Code

Claude Code's native interface is the [Anthropic SDK](https://docs.anthropic.com/en/api/client-sdks).
A `claude_code_adapter` would:

  1. Receive `text` + `session_id`.
  2. Call `client.messages.create(stream=True, ...)` with the
     accumulated history.
  3. Yield each `content_block_delta.delta.text` chunk.

Pre-reqs the install script must surface:

  - `pip install anthropic` into the bridge venv.
  - `[claude_code]` section in the config TOML with `api_key` and
    optional `model` (default `claude-sonnet-4-5`).

### ChatGPT (OpenAI)

Conceptually identical to Hermes — Hermes already speaks the
OpenAI-compatible chat-completions endpoint, so the existing
`HermesAdapter` would handle ChatGPT too. The only delta is the
config:

  - `[openai]` section with `api_key` and `model`.
  - `[openai].base_url` defaults to `https://api.openai.com`.

### Cursor + OpenClaw

Both currently lack a stable third-party API surface. The agents
stay registered in the dispatcher so the install command can
**fail gracefully** with a pointer to this doc, instead of an
opaque "unknown flag" error.

## How E2E tests will cover this

Round-12 ships only the dispatcher scaffolding (the flag, the
table, the placeholder error). Future PRs that wire a real agent
must add:

  1. `server/hermes-voice-bridge/tests/test_<agent>_adapter.py`
     with the same shape as `test_server.py::test_hermes_*` —
     scripted fake upstream, assert deltas + history.
  2. A bash integration test that runs
     `bash server/install.sh --agent=<name> --dry-run` and
     diff-asserts the generated systemd unit + config file.

This document is the source of truth for those expectations — if
the API of `AgentAdapter` changes, update this file first.
