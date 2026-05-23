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
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    actionTimeout: 10_000,
    trace: 'on-first-retry',
  },
});
