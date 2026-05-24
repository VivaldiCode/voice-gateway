/**
 * Tiny fluent driver for the most common conversation-flow shape:
 *
 *   instrument the renderer once
 *   →  press PTT, hold N ms, release
 *   →  wait for some terminal state (IDLE or LISTENING_WAKE)
 *   →  return the stats snapshot
 *
 * Every behavioural spec under tests/e2e/ writes the same five lines —
 * this helper turns them into one.
 *
 * Usage:
 *   const driver = await ConversationDriver.attach(rig.mainWindow);
 *   const stats = await driver.runTurn({ holdMs: 200, until: ['IDLE'] });
 *   expect(stats.chunks).toBeGreaterThan(0);
 *
 * The driver is just sugar over rig.ts's holdPtt + waitForState +
 * readVgStats; nothing magical, but it makes spec bodies read like a
 * sequence of intent rather than orchestration plumbing.
 */
import { type Page } from '@playwright/test';
import {
  holdPtt,
  instrumentTtsCounter,
  readVgStats,
  waitForState,
  type VgStats,
} from './rig';

export interface RunTurnOptions {
  /** How long to hold the PTT button (ms). Default 200. */
  holdMs?: number;
  /** Which state(s) to wait for after release. Default ['IDLE']. */
  until?: readonly string[];
  /** Per-state timeout. Default 20_000 ms (long enough for STT + Hermes). */
  timeoutMs?: number;
}

export class ConversationDriver {
  private constructor(public readonly page: Page) {}

  /**
   * Attach to a packaged-app page and install the in-page event log.
   * Idempotent; calling twice on the same page resets the counters.
   */
  static async attach(page: Page): Promise<ConversationDriver> {
    await instrumentTtsCounter(page);
    return new ConversationDriver(page);
  }

  /** Press PTT, hold, release, wait for a terminal state. */
  async runTurn(opts: RunTurnOptions = {}): Promise<VgStats> {
    const holdMs = opts.holdMs ?? 200;
    const until = opts.until ?? ['IDLE'];
    const timeoutMs = opts.timeoutMs ?? 20_000;
    await holdPtt(this.page, holdMs);
    await waitForState(this.page, until, { timeoutMs });
    return await readVgStats(this.page);
  }

  /** Just press the call button (no release). For barge-in / interrupt tests. */
  async pressPtt(): Promise<void> {
    await this.page
      .getByTestId('call-button')
      .dispatchEvent('pointerdown');
  }

  /** Release the call button (paired with pressPtt). */
  async releasePtt(): Promise<void> {
    await this.page.getByTestId('call-button').dispatchEvent('pointerup');
  }

  /** Read the accumulated stats without driving a turn. */
  async stats(): Promise<VgStats> {
    return await readVgStats(this.page);
  }

  /** Wait for the renderer's event log to include the given state. */
  async waitFor(states: readonly string[], timeoutMs = 20_000): Promise<string> {
    return await waitForState(this.page, states, { timeoutMs });
  }
}
