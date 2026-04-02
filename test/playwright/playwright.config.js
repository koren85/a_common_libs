// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,   // Sequential — DB state matters for timing
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test/playwright/report', open: 'never' }],
  ],
  use: {
    baseURL: process.env.REDMINE_URL || 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'off',
    // Отключаем кеш браузера чтобы мерить реальную нагрузку на сервер
    extraHTTPHeaders: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
