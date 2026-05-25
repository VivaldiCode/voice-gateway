import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // The audio-conversation spec waits for whisper (~5s) + piper (~3s) plus
  // captures 2.5s of fake mic. Default 60s is too tight on a cold-cache run.
  timeout: 120_000,
  // exFAT external drives sprinkle `._*` AppleDouble files alongside every
  // real file the moment we touch them; Playwright would otherwise try to
  // parse them as test modules and crash.
  testIgnore: '**/._*',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 1 retry locally — the 28-spec suite back-to-back races on Piper
  // venv-auto-install and Whisper warmup under load. CI gets 3 retries
  // (issue #18 round-trip): on macos-latest headless Chromium the
  // bridge-error-frame → ERROR-state flow occasionally drops a
  // transition under CPU pressure (tracked in a separate follow-up
  // issue). The 3rd retry empirically lands the flaky bridge-error
  // specs (conversation-flows:174, runtime-extras:64+145, runtime-protocol:
  // 64+93+264, ux-round11:152, ux-shortcuts:106) while real regressions
  // still fail deterministically. Bumping past 3 wastes CI minutes
  // without raising the catch rate.
  retries: process.env.CI ? 3 : 1,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    actionTimeout: 10_000,
    // `on-first-retry` is useless on the local run (retries: 0). Keep traces
    // and screenshots for any failure so we have actionable diagnostics out
    // of the box.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
