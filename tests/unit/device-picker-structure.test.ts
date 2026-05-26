/**
 * Issue #20 — lock in the DevicePicker source structure and the two
 * MainScreen instances that wire it up. The repo doesn't ship
 * @testing-library/react so we can't mount-and-click in vitest;
 * the source-string assertions catch the regression class we care
 * about (someone removes a picker, or rewires it to a wrong
 * settings key) at vitest speed.
 *
 * Same pattern as logo-a11y.test.ts and settings-header-structure
 * .test.ts.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PICKER_SRC = join(HERE, '..', '..', 'src', 'renderer', 'components', 'DevicePicker.tsx');
const MAIN_SRC = join(HERE, '..', '..', 'src', 'renderer', 'components', 'MainScreen.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('DevicePicker (issue #20)', () => {
  it('component file exists + exports the DevicePicker symbol', () => {
    const src = read(PICKER_SRC);
    expect(src).toMatch(/export function DevicePicker\(/);
    expect(src).toMatch(/role="listbox"/);
  });

  it('enumerates the right device kind from mediaDevices', () => {
    const src = read(PICKER_SRC);
    // The kind prop drives the filter — without it the picker would
    // mix mic + speaker into one popover.
    expect(src).toMatch(/navigator\.mediaDevices\.enumerateDevices/);
    expect(src).toMatch(/d\.kind === kind/);
  });

  it('re-enumerates on devicechange while open', () => {
    const src = read(PICKER_SRC);
    expect(src).toMatch(/addEventListener\('devicechange'/);
  });

  it('closes on outside pointerdown + Escape', () => {
    const src = read(PICKER_SRC);
    expect(src).toMatch(/addEventListener\('pointerdown'/);
    expect(src).toMatch(/ev\.key === 'Escape'/);
    // Escape uses capture phase so it beats sibling handlers
    // (e.g. cancel-capture).
    expect(src).toMatch(/addEventListener\('keydown',\s*onKey,\s*true\)/);
  });

  it('always offers a "system default" option first (deviceId=null)', () => {
    const src = read(PICKER_SRC);
    // Without this option the user can never undo a manual selection
    // without going through Settings.
    expect(src).toMatch(/onSelect\(null\);/);
    expect(src).toMatch(/active=\{selectedId === null\}/);
  });

  it('paints a dot indicator on the trigger when a non-default device is active', () => {
    const src = read(PICKER_SRC);
    expect(src).toMatch(/hasOverride/);
    expect(src).toMatch(/data-has-override=\{hasOverride/);
  });
});

describe('MainScreen wires both pickers (issue #20)', () => {
  it('renders the mic picker before the mute toggle', () => {
    const src = read(MAIN_SRC);
    const micIdx = src.indexOf('testId="mic-picker"');
    const muteIdx = src.indexOf('data-testid="mute-toggle"');
    expect(micIdx).toBeGreaterThan(-1);
    expect(muteIdx).toBeGreaterThan(-1);
    expect(micIdx).toBeLessThan(muteIdx);
  });

  it('renders the speaker picker before the mute toggle', () => {
    const src = read(MAIN_SRC);
    const spkIdx = src.indexOf('testId="speaker-picker"');
    const muteIdx = src.indexOf('data-testid="mute-toggle"');
    expect(spkIdx).toBeGreaterThan(-1);
    expect(spkIdx).toBeLessThan(muteIdx);
  });

  it('mic picker persists via settings.audio.inputDeviceId', () => {
    const src = read(MAIN_SRC);
    expect(src).toMatch(/audio:\s*\{\s*inputDeviceId:\s*deviceId\s*\}/);
  });

  it('speaker picker persists via settings.audio.outputDeviceId', () => {
    const src = read(MAIN_SRC);
    expect(src).toMatch(/audio:\s*\{\s*outputDeviceId:\s*deviceId\s*\}/);
  });

  it('passes localised aria-labels (not hardcoded strings)', () => {
    const src = read(MAIN_SRC);
    expect(src).toMatch(/ariaLabel=\{t\.app\.micPickerAria\}/);
    expect(src).toMatch(/ariaLabel=\{t\.app\.speakerPickerAria\}/);
  });

  it('hooks both pickers to the kind that matches their icon', () => {
    const src = read(MAIN_SRC);
    expect(src).toMatch(/kind="audioinput"\s+Icon=\{MicIcon\}/);
    expect(src).toMatch(/kind="audiooutput"\s+Icon=\{HeadphonesIcon\}/);
  });
});
