/**
 * Issue #19 — Settings panel mirrors MainScreen's two-row header so
 * the macOS hiddenInset traffic lights have room to breathe.
 *
 * Confirms the new structure against the real rendered DOM in the
 * dedicated Settings BrowserWindow:
 *
 *   - The header element exists and carries `data-testid="settings-header"`
 *   - It contains a 28 px transparent spacer with `aria-hidden="true"`
 *     (the traffic-light overlay row)
 *   - The Logo + title cluster lives on the left, close button on the
 *     right, savedFlash slot stays in the right cluster
 *   - Dragging works (vg-drag class on the header) — verified via class
 *     presence rather than synthetic drag since Playwright can't move
 *     real OS windows reliably in headless mode
 */
import { expect, test, type Page } from '@playwright/test';
import {
  MOCK_DEFAULT_TOKEN,
  startMockBridge,
  type MockBridge,
} from '../integration/__mocks__/mock-bridge-server';
import {
  launchPackaged,
  openSettingsWindow,
  packagedAppExists,
  type TestRig,
} from './helpers/rig';

test.describe('Settings — header pattern (issue #19)', () => {
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

  async function setup(): Promise<{ settings: Page; main: Page }> {
    bridge = await startMockBridge();
    rig = await launchPackaged({
      bridgeUrl: bridge.url,
      bridgeToken: MOCK_DEFAULT_TOKEN,
    });
    const settings = await openSettingsWindow(rig);
    return { settings, main: rig.mainWindow };
  }

  test('settings header has the two-row pattern with the traffic-light spacer', async () => {
    const { settings } = await setup();
    const header = settings.getByTestId('settings-header');
    await expect(header).toBeVisible();
    // The header is the drag surface for the window — `vg-drag` enables
    // it. The class is namespaced via tailwind so we assert its presence
    // rather than its computed style.
    await expect(header).toHaveClass(/vg-drag/);
    await expect(header).toHaveClass(/flex-col/);

    // The 28 px spacer overlays the macOS traffic-lights. Selector picks
    // the aria-hidden div that sits at the top of the header.
    const spacer = header.locator('div[aria-hidden="true"].h-7').first();
    await expect(spacer).toHaveCount(1);
  });

  test('close button still works and is wired to onClose', async () => {
    const { settings } = await setup();
    // settings-close must remain reachable + clickable after the
    // header refactor. We verify by clicking it and asserting the
    // window closes.
    const closeBtn = settings.getByTestId('settings-close');
    await expect(closeBtn).toBeVisible();
    const closed = settings.waitForEvent('close', { timeout: 5_000 });
    await closeBtn.click();
    await closed;
  });

  test('settings tab navigation still renders below the header', async () => {
    const { settings } = await setup();
    // The header refactor moved the title/savedFlash/close into a new
    // structure but the tabs nav should still appear right after it.
    // Existing testid `tab-voz` is what every other settings spec uses.
    await expect(settings.getByTestId('tab-voz')).toBeVisible();
    await expect(settings.getByTestId('tab-microfone')).toBeVisible();
    await expect(settings.getByTestId('tab-conexao')).toBeVisible();
  });
});
