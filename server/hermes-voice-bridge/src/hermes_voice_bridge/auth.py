"""Bearer-token authentication for the WS upgrade handshake."""
from __future__ import annotations

import hmac
from typing import Optional


def extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def is_valid_token(expected: str, provided: Optional[str]) -> bool:
    if not provided:
        return False
    # Constant-time comparison to prevent timing attacks.
    return hmac.compare_digest(expected.encode("utf-8"), provided.encode("utf-8"))
