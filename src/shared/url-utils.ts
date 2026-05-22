/**
 * Helpers for normalising the bridge WebSocket URL.
 *
 * The Hermes Voice Bridge serves WebSocket on the `/ws` path. Users tend to
 * paste only `ws://host:port` (because that's what install.sh historically
 * printed, and because `/ws` is an implementation detail). We normalise that
 * for them — but preserve any explicit non-trivial path (e.g. when a reverse
 * proxy hosts the bridge under `/bridge/ws`).
 */

const BRIDGE_DEFAULT_PATH = '/ws';

export interface NormalizedUrl {
  /** The normalised URL ready to hand to a WebSocket constructor. */
  url: string;
  /** True if the input was missing a path and we appended {@link BRIDGE_DEFAULT_PATH}. */
  pathWasAdded: boolean;
}

/**
 * Normalise a user-entered bridge URL. Returns the original string on
 * malformed input (the WS constructor will surface a clearer error than we
 * would).
 */
export function normalizeBridgeUrl(input: string): NormalizedUrl {
  const trimmed = input.trim();
  if (!trimmed) return { url: trimmed, pathWasAdded: false };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: trimmed, pathWasAdded: false };
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { url: trimmed, pathWasAdded: false };
  }

  // Strip any trailing slash on the path, then decide.
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path === '' || path === '') {
    parsed.pathname = BRIDGE_DEFAULT_PATH;
    return { url: parsed.toString(), pathWasAdded: true };
  }
  // Already has a path (e.g. /ws, /bridge/ws, /custom). Leave it alone.
  return { url: parsed.toString(), pathWasAdded: false };
}
