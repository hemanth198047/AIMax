import { defineConfig } from '@playwright/test';

// Set AIMAX_E2E_CHROME to use an installed Chrome/Chromium binary; otherwise run `npx playwright install chromium` once.
const executablePath = process.env.AIMAX_E2E_CHROME || undefined;

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,                       // one shared server + database
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    launchOptions: { executablePath, args: ['--no-sandbox'] },
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results',
  webServer: {
    command: 'npm run dev --workspace=packages/client -- --port 5173 --strictPort',
    cwd: '..',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
