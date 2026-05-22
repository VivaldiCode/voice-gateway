import { describe, expect, it } from 'vitest';
import { normalizeBridgeUrl } from '@shared/url-utils';

describe('normalizeBridgeUrl', () => {
  it('appends /ws when the URL has no path', () => {
    const r = normalizeBridgeUrl('ws://10.0.19.1:8765');
    expect(r.url).toBe('ws://10.0.19.1:8765/ws');
    expect(r.pathWasAdded).toBe(true);
  });

  it('appends /ws when the path is just /', () => {
    const r = normalizeBridgeUrl('wss://hermes.casa.lan/');
    expect(r.url).toBe('wss://hermes.casa.lan/ws');
    expect(r.pathWasAdded).toBe(true);
  });

  it('appends /ws when path is /// (multiple trailing slashes)', () => {
    const r = normalizeBridgeUrl('ws://host:8765///');
    expect(r.url).toBe('ws://host:8765/ws');
    expect(r.pathWasAdded).toBe(true);
  });

  it('leaves a non-trivial path intact', () => {
    const r = normalizeBridgeUrl('ws://gateway/proxy/bridge/ws');
    expect(r.url).toBe('ws://gateway/proxy/bridge/ws');
    expect(r.pathWasAdded).toBe(false);
  });

  it('leaves /ws intact when the user typed it', () => {
    const r = normalizeBridgeUrl('ws://10.0.19.1:8765/ws');
    expect(r.url).toBe('ws://10.0.19.1:8765/ws');
    expect(r.pathWasAdded).toBe(false);
  });

  it('trims surrounding whitespace before normalising', () => {
    const r = normalizeBridgeUrl('  ws://h:1\n');
    expect(r.url).toBe('ws://h:1/ws');
    expect(r.pathWasAdded).toBe(true);
  });

  it('returns input unchanged on malformed URL', () => {
    const r = normalizeBridgeUrl('not a url');
    expect(r.url).toBe('not a url');
    expect(r.pathWasAdded).toBe(false);
  });

  it('returns input unchanged on non-ws scheme', () => {
    const r = normalizeBridgeUrl('http://host:8765');
    expect(r.url).toBe('http://host:8765');
    expect(r.pathWasAdded).toBe(false);
  });

  it('returns empty input unchanged', () => {
    const r = normalizeBridgeUrl('   ');
    expect(r.url).toBe('');
    expect(r.pathWasAdded).toBe(false);
  });
});
