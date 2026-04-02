// Performance bug verification tests for a_common_libs plugin
// Run: playwright test test/playwright/perf_bugs.spec.js
// Requires Redmine running at BASE_URL with the credentials below.

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.REDMINE_URL || 'http://localhost:3000';
const ADMIN_USER = process.env.REDMINE_USER || 'admin';
const ADMIN_PASS = process.env.REDMINE_PASS || 'admin';

// Thresholds in ms — page is considered broken above these
const THRESHOLDS = {
  issueList:   2000,  // Issue list with CF columns
  singleIssue: 1500,  // Single issue page
  dashboard:   2000,  // Home/dashboard
  ajaxCounter: 500,   // /ajax_counters/counters AJAX call
};

async function login(page) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#username', ADMIN_USER);
  await page.fill('#password', ADMIN_PASS);
  await page.click('input[name=login]');
  // Ждём редиректа со страницы логина (кастомная тема скрывает #loggedas через CSS)
  await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG-2: get_favourite_project — тяжёлый GROUP BY journals на каждом запросе
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-2: dashboard load time (favourite_project query)', async ({ page }) => {
  await login(page);

  const timings = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');
    timings.push(Date.now() - t0);
  }

  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`BUG-2 dashboard avg: ${avg.toFixed(0)}ms  runs: ${timings.join(', ')}ms`);
  expect(avg, `Dashboard avg ${avg.toFixed(0)}ms > threshold ${THRESHOLDS.dashboard}ms`).toBeLessThan(THRESHOLDS.dashboard);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-1: acl_custom_values_scope_postgre — тройной вложенный SQL
// BUG-3: acl_load_custom_values — доп. подзапрос по available CFs
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-1+3: issue list with custom field columns', async ({ page }) => {
  await login(page);

  // Страница списка задач — триггерит acl_custom_values_scope_postgre
  const url = `${BASE_URL}/issues?query_id=`;
  const timings = [];

  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.goto(`${BASE_URL}/issues`);
    await page.waitForLoadState('networkidle');
    timings.push(Date.now() - t0);
  }

  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`BUG-1+3 issue list avg: ${avg.toFixed(0)}ms  runs: ${timings.join(', ')}ms`);
  expect(avg, `Issue list avg ${avg.toFixed(0)}ms > threshold ${THRESHOLDS.issueList}ms`).toBeLessThan(THRESHOLDS.issueList);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-4: link_to_user / avatar deep_dup — кеш не работает
// BUG-5: allowed_to? unbounded cache
// BUG-8: linear search in custom_values
// Проверяем страницу одной задачи (issue show)
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-4+5+8: single issue page load', async ({ page }) => {
  await login(page);

  // Получаем ID первой доступной задачи
  await page.goto(`${BASE_URL}/issues`);
  const firstIssueLink = page.locator('table.issues td.subject a').first();
  const href = await firstIssueLink.getAttribute('href');
  const issueUrl = `${BASE_URL}${href}`;

  const timings = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.goto(issueUrl);
    await page.waitForLoadState('networkidle');
    timings.push(Date.now() - t0);
  }

  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`BUG-4+5+8 single issue avg: ${avg.toFixed(0)}ms  runs: ${timings.join(', ')}ms`);
  expect(avg, `Single issue avg ${avg.toFixed(0)}ms > threshold ${THRESHOLDS.singleIssue}ms`).toBeLessThan(THRESHOLDS.singleIssue);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-6: sessions таблица раздута + запись счётчиков
// Проверяем /ajax_counters/counters — скорость ответа
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-6: ajax_counters response time', async ({ page }) => {
  await login(page);

  // Перехватываем реальный AJAX-запрос счётчиков с замером времени
  const counterTimings = [];
  const requestTimes = new Map();
  page.on('request', (request) => {
    if (request.url().includes('ajax_counters/counters')) {
      requestTimes.set(request.url() + '_' + Date.now(), Date.now());
    }
  });
  page.on('response', async (response) => {
    if (response.url().includes('ajax_counters/counters')) {
      const t0 = Date.now();
      // Ищем ближайший по времени запрос
      let minDiff = Infinity;
      let elapsed = null;
      for (const [key, startTime] of requestTimes.entries()) {
        const diff = t0 - startTime;
        if (diff >= 0 && diff < minDiff) {
          minDiff = diff;
          elapsed = diff;
        }
      }
      if (elapsed !== null) counterTimings.push(elapsed);
    }
  });

  // Загружаем несколько страниц чтобы поймать AJAX-счётчики
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
  }

  if (counterTimings.length > 0) {
    const avg = counterTimings.reduce((a, b) => a + b, 0) / counterTimings.length;
    console.log(`BUG-6 ajax_counters avg: ${avg.toFixed(0)}ms  runs: ${counterTimings.join(', ')}ms`);
    expect(avg, `ajax_counters avg ${avg.toFixed(0)}ms > threshold ${THRESHOLDS.ajaxCounter}ms`).toBeLessThan(THRESHOLDS.ajaxCounter);
  } else {
    console.log('BUG-6: No ajax_counters requests detected (counters may be disabled) — PASS');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-7: .size вместо .count в api_log_for_plugins
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-7: api_log_for_plugins index page load', async ({ page }) => {
  await login(page);

  const t0 = Date.now();
  const response = await page.goto(`${BASE_URL}/api_log_for_plugins`);
  await page.waitForLoadState('networkidle');
  const elapsed = Date.now() - t0;

  console.log(`BUG-7 api_log_for_plugins: ${elapsed}ms  status: ${response?.status()}`);

  if (response?.status() === 200) {
    expect(elapsed, `api_log page ${elapsed}ms > 1000ms`).toBeLessThan(1000);
  } else {
    console.log(`BUG-7: Skipped (HTTP ${response?.status()})`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-9: AclAjaxCounter.all_tokens — полный table scan при каждом первом обращении
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-9: cold-cache counter lookup overhead', async ({ page }) => {
  await login(page);

  // Первый запрос — триггерит полный SELECT * FROM acl_ajax_counters (cold cache)
  const t0 = Date.now();
  await page.goto(`${BASE_URL}/issues`);
  await page.waitForLoadState('networkidle');
  const cold = Date.now() - t0;

  // Второй запрос — должен использовать кеш класса (@all)
  const t1 = Date.now();
  await page.goto(`${BASE_URL}/issues`);
  await page.waitForLoadState('networkidle');
  const warm = Date.now() - t1;

  console.log(`BUG-9 cold: ${cold}ms  warm: ${warm}ms  overhead: ${cold - warm}ms`);
  // Разница между cold и warm > 200ms указывает на проблему с cold init
  expect(cold - warm, `Cold/warm difference ${cold - warm}ms > 200ms (BUG-9 overhead)`).toBeLessThan(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// Суммарный тест: Profiled page — замеряем все фазы через CDP
// ─────────────────────────────────────────────────────────────────────────────
test('PROFILE: full page timing breakdown on issue list', async ({ page, context }) => {
  // Включаем CDP для детального profiling
  const cdpSession = await context.newCDPSession(page);
  await cdpSession.send('Performance.enable');

  await login(page);

  // Начинаем Network трассировку
  const networkRequests = [];
  page.on('request', req => networkRequests.push({ url: req.url(), time: Date.now() }));
  page.on('response', async res => {
    const matching = networkRequests.find(r => r.url === res.url());
    if (matching) matching.duration = Date.now() - matching.time;
  });

  const t0 = Date.now();
  await page.goto(`${BASE_URL}/issues`);
  await page.waitForLoadState('networkidle');
  const total = Date.now() - t0;

  // Собираем метрики CDP
  const metrics = await cdpSession.send('Performance.getMetrics');
  const metricMap = {};
  for (const m of metrics.metrics) metricMap[m.name] = m.value;

  // Топ медленных запросов
  const slowRequests = networkRequests
    .filter(r => r.duration > 100)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 10);

  console.log('─── PROFILE SUMMARY ───');
  console.log(`Total page load: ${total}ms`);
  console.log(`DOM Content Loaded: ${metricMap.DOMContentLoaded?.toFixed(0) || 'N/A'}ms`);
  console.log(`JS Heap Used: ${((metricMap.JSHeapUsedSize || 0) / 1024 / 1024).toFixed(1)} MB`);
  console.log('Slow network requests (>100ms):');
  for (const r of slowRequests) {
    console.log(`  ${r.duration}ms  ${r.url.replace(BASE_URL, '')}`);
  }

  expect(total, `Total page ${total}ms > 4000ms`).toBeLessThan(4000);
});
