import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Chromium já instalado no sistema (não rodamos `playwright install`).
const SYSTEM_CHROMIUM = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // Os cenários compartilham o mesmo banco e seguem uma ordem (numeração dos arquivos).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    launchOptions: existsSync(SYSTEM_CHROMIUM) ? { executablePath: SYSTEM_CHROMIUM } : {},
  },
});
