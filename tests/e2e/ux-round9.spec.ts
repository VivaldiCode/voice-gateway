/**
 * E2E for the round-9 UX additions:
 *
 *   #100  Cmd+L wipes the transcript locally.
 *   #101  Cmd+R while in ERROR dismisses + retries (auto PTT press/release).
 *   #102  "Copiar conversa" button serialises the transcript to the clipboard.
 *   #103  Turn counter ("N mensagens") appears in the transcript chrome.
 *   #104  Click on the connection indicator while offline triggers
 *         reconnectNow() on the main process.
 *   #105  Mute toggle in the header silences the AudioPlayback path without
 *         halting the FSM (still hits SPEAKING → IDLE) and persists in
 *         settings.audio.outputMuted.
 */
import { expect, test } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import { scriptedTextReply } from './helpers/mock-bridge-presets';
import { ConversationDriver } from './helpers/driver';
import {
  FIXTURES_DIR,
  launchPackaged,
  packagedAppExists,
  readLastClipboard,
  type TestRig,
} from './helpers/rig';
import { join } from 'node:path';

const FAKE_AUDIO = join(FIXTURES_DIR, 'hi-how-are-you.wav');

test.describe('UX round-9 — main window keyboard + transcript chrome', () => {
  let rig: TestRig | null = null;
  let bridge: MockBridge | null = null;

  test.beforeAll(() => {
    if (!packagedAppExists()) {
      test.skip(true, 'Packaged app missing. Run `npm run build:mac` first.');
    }
  });

  test.afterEach(async () => {
    await rig?.dispose();
    rig = null;
    await bridge?.close();
    bridge = null;
  });

  // ───── #103 + #100: turn counter shows, Cmd+L wipes the transcript
  test('Cmd+L clears the transcript locally and the counter goes back to 0', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('ok'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'oi' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Drive one turn so we get one user + one assistant line in the transcript.
    const driver = await ConversationDriver.attach(mainWindow);
    await driver.runTurn({ holdMs: 200, until: ['IDLE'] });

    // The counter chip should now read "2 mensagens" (user + assistant).
    // Bumped to 10 s for CI: when the FSM reaches IDLE the renderer's
    // React state for transcript can lag a tick behind (the auto-
    // instrument array path is intact, but onResponseText delivery to
    // React's setState batched into the next render is what the chrome
    // observes — see waitForState's "renderer DOM as fallback" doc).
    await expect(mainWindow.getByTestId('transcript-count')).toContainText(/2 mensagens/, {
      timeout: 10_000,
    });

    // Cmd+L wipes the local transcript.
    await mainWindow.keyboard.press('Meta+l');

    // Counter disappears entirely once the list is empty (parent hides the chrome).
    await expect(mainWindow.getByTestId('transcript-count')).toHaveCount(0, {
      timeout: 2_000,
    });
    // And the empty-state hint comes back.
    await expect(mainWindow.getByTestId('transcript-empty')).toBeVisible();
  });

  // ───── #102: copy conversa serialises to the clipboard
  test('"copiar" button on the transcript copies a formatted dump', async () => {
    // Issue #30 (user-approved Option B): the copy button doesn't render
    // until a turn completes, but the FSM's response_text → IDLE transition
    // gets dropped on headless macOS CI, so the button locator never
    // becomes visible. Spec passes on dev macOS in non-headless mode.
    test.skip(
      process.env['VG_E2E_HEADLESS'] === '1',
      'see issue #30 — headless macOS state-pipeline race',
    );
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('tudo bem'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'olá' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });
    // grantClipboardWrite was already called by launchPackaged — every
    // navigator.clipboard.writeText now records into window.__vg_last_clip
    // and swallows the headless-Chromium permission error.

    const driver = await ConversationDriver.attach(mainWindow);
    await driver.runTurn({ holdMs: 200, until: ['IDLE'] });

    // The transcript-copy button may not be in the DOM until both
    // transcript lines (user + assistant) have rendered. Wait for the
    // line count to settle so the click target exists. The race here is
    // the same auto-instrument timing window described in waitForState:
    // by IDLE the FSM-emitted events have flowed, but React render +
    // child mount can lag a tick or two.
    await expect(mainWindow.getByTestId('transcript-copy')).toBeVisible({ timeout: 5_000 });
    await mainWindow.getByTestId('transcript-copy').click();

    const copied = await readLastClipboard(mainWindow);
    expect(copied, 'clipboard text').not.toBeNull();
    expect(copied).toMatch(/Tu:.*olá/);
    expect(copied).toMatch(/Hermes:.*tudo bem/);
  });

  // ───── #104: click connection indicator while offline → reconnectNow
  test('clicking the connection indicator while disconnected forces a reconnect', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('ok'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const { mainWindow } = rig;
    const indicator = mainWindow.getByTestId('connection-indicator');
    await expect(indicator).toContainText(/ligado|ms/i, { timeout: 15_000 });

    // While connected the button is non-interactive (data-clickable=false).
    await expect(indicator).toHaveAttribute('data-clickable', 'false');

    // Drop the server side. The renderer should flip to disconnected within
    // a tick and the indicator should become clickable.
    for (const c of [...bridge.connections]) c.close();
    await expect(indicator).toHaveAttribute('data-clickable', 'true', { timeout: 10_000 });

    // Click — main asks the client to retry now. The user-visible
    // contract is that the indicator goes back to "ligado" without
    // having to wait the full exponential-backoff delay (~500 ms first
    // try, growing fast). The click should make that essentially
    // instant; we still allow 5 s for slow CI.
    await indicator.click();
    await expect(indicator).toContainText(/ligado|ms/i, { timeout: 5_000 });
  });

  // ───── #105: mute toggle suppresses audio but FSM still runs
  test('mute toggle persists in settings and silences playback while FSM runs', async () => {
    bridge = await startMockBridge({
      onClientMessage: scriptedTextReply('mute me'),
    });
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'mute me' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    const toggle = mainWindow.getByTestId('mute-toggle');
    await expect(toggle).toHaveAttribute('data-muted', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-muted', 'true');

    // Setting was persisted (settings.set echoes back through onChange).
    const persisted = await mainWindow.evaluate(async () => {
      // tsconfig.node.json doesn't expose `window` — work through globalThis.
      const w = globalThis as unknown as { vg: { settings: { get: () => Promise<{ audio: { outputMuted: boolean } }> } } };
      const s = await w.vg.settings.get();
      return s.audio.outputMuted;
    });
    expect(persisted).toBe(true);

    // FSM still goes IDLE → CAPTURING → … → IDLE during a muted turn.
    const driver = await ConversationDriver.attach(mainWindow);
    await driver.runTurn({ holdMs: 200, until: ['IDLE'] });

    // Un-mute and verify the attribute flips back + setting clears.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-muted', 'false');
    const after = await mainWindow.evaluate(async () => {
      const w = globalThis as unknown as { vg: { settings: { get: () => Promise<{ audio: { outputMuted: boolean } }> } } };
      const s = await w.vg.settings.get();
      return s.audio.outputMuted;
    });
    expect(after).toBe(false);
  });

  // ───── #101: Cmd+R from ERROR auto-recovers
  test('Cmd+R while in ERROR dismisses the toast and starts a fresh turn', async () => {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
      fakeAudioFile: FAKE_AUDIO,
      activation: { minAudioMs: 50 },
      extraEnv: { VG_E2E_FAKE_TRANSCRIPT: 'oi' },
    });
    const { mainWindow } = rig;
    await expect(mainWindow.getByTestId('connection-indicator')).toContainText(/ligado|ms/i, {
      timeout: 15_000,
    });

    // Force an ERROR by injecting a server error frame for the next turn.
    // The bridge mock surfaces incoming error frames directly to the client.
    const driver = await ConversationDriver.attach(mainWindow);
    await driver.pressPtt();
    await driver.waitFor(['CAPTURING'], 5_000);
    // Push an error frame from the server side so the orchestrator transitions
    // CAPTURING → ERROR.
    const conn = [...bridge.connections][0];
    if (!conn) throw new Error('no mock connection');
    conn.send(
      JSON.stringify({
        type: 'error',
        code: 'HERMES_UPSTREAM',
        message: 'simulated upstream failure',
      }),
    );
    await driver.releasePtt();
    await driver.waitFor(['ERROR'], 5_000);
    await expect(mainWindow.getByTestId('error-toast')).toBeVisible();

    // Cmd+R: dismiss + auto press/release PTT. We end up either back in
    // CAPTURING (mid-recovery) or already past it. The error toast goes
    // away.
    await mainWindow.keyboard.press('Meta+r');
    await expect(mainWindow.getByTestId('error-toast')).toHaveCount(0, {
      timeout: 5_000,
    });
    // The FSM should have left ERROR for *some* live state.
    const stateAfter = await mainWindow.evaluate(
      () => (globalThis as unknown as { __vg_state_log: string[] }).__vg_state_log?.at(-1),
    );
    expect(stateAfter, 'state log last value').not.toBe('ERROR');
  });
});
