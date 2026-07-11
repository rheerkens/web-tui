import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:4173';
try { execFileSync('tmux', ['kill-session', '-t', '=waypoint-e2e'], { stdio: 'ignore' }); } catch {}
execFileSync('tmux', ['new-session', '-d', '-s', 'waypoint-e2e', 'bash']);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /waypoint-e2e/ }).click();
  await page.getByText('Live', { exact: true }).waitFor();
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("printf 'WAYPOINT_INPUT_OK\\n'");
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('WAYPOINT_INPUT_OK'));
  await page.screenshot({ path: '/tmp/waypoint-desktop.png', fullPage: true });
  assert.equal(await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).position), 'static');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open sessions' }).click();
  assert.equal(await page.locator('#sidebar').evaluate((el) => el.classList.contains('open')), true);
  await page.locator('#overlay').click({ position: { x: 380, y: 400 } });
  await page.getByRole('button', { name: /Keyboard/ }).click();
  assert.equal(await page.locator('#mobile-input').evaluate((el) => document.activeElement === el), true);
  await page.screenshot({ path: '/tmp/waypoint-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('E2E passed: desktop terminal I/O, responsive menu, and mobile keyboard focus.');
} finally {
  await browser.close();
  try { execFileSync('tmux', ['kill-session', '-t', '=waypoint-e2e']); } catch {}
}
