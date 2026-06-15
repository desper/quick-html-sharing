import { type Browser, type Page, expect, test } from '@playwright/test';

/**
 * Two journeys the design (PR2 / eng-review Issue 7A) calls out as needing real
 * browser + real worker, not unit mocks:
 *
 *   ① create sync code → upload (auto-enrolled) → My Shares lists it
 *   ② fresh context pastes the code → local remnant is claimed → list reconnects
 *
 * Each "device" gets its own browser context AND a distinct CF-Connecting-IP, so
 * the worker's per-IP upload cap (1 / 30s) doesn't false-trip when several
 * devices share localhost. The header rides through the dev /api proxy to the
 * worker's getClientIp().
 */

const SAMPLE = '<!doctype html><title>e2e</title><h1>hello from e2e</h1>';

/** A fresh, cookied+localStorage-isolated context fronted by a unique IP. */
async function newDevice(browser: Browser, ip: string): Promise<Page> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'CF-Connecting-IP': ip } });
  return ctx.newPage();
}

/** Type unique HTML into the homepage editor, Share, and return the new slug. */
async function uploadFromHome(page: Page): Promise<string> {
  await page.goto('/');
  await page.fill('#html-input', `${SAMPLE}<!-- ${Date.now()}-${Math.random()} -->`);
  await page.click('#share-btn');
  await expect(page.locator('#result-panel')).toBeVisible();
  const shareUrl = await page.locator('#share-url').inputValue();
  const slug = new URL(shareUrl).pathname.replace(/^\//, '');
  expect(slug.length).toBeGreaterThan(0);
  return slug;
}

/** Run the Create-a-sync-code ritual on /my-shares and return the minted code. */
async function createSyncCode(page: Page): Promise<string> {
  await page.goto('/my-shares');
  await page.click('#create-btn');
  await expect(page.locator('#code-reveal')).toBeVisible();
  const code = await page.locator('#sync-code').inputValue();
  expect(code).toMatch(/^qhsk_[A-Za-z0-9_-]{43}$/);
  await page.check('#saved-check');
  await expect(page.locator('#continue-btn')).toBeEnabled();
  await page.click('#continue-btn');
  await expect(page.locator('#list-region')).toBeVisible();
  return code;
}

test('① create code → upload → My Shares lists the new share', async ({ browser }) => {
  const page = await newDevice(browser, '203.0.113.10');
  await createSyncCode(page);

  // Upload from the homepage — the stored sync key auto-attaches (D20).
  const slug = await uploadFromHome(page);
  await expect(page.locator('#added-note')).toBeVisible();

  // The share shows up in My Shares without any manual claim.
  await page.goto('/my-shares');
  await expect(page.locator('#shares-list')).toContainText(slug);
});

test('② new context pastes code → claims local remnant → list reconnects', async ({ browser }) => {
  // Device A: owns the sync code and one enrolled share (S1).
  const pageA = await newDevice(browser, '203.0.113.20');
  const code = await createSyncCode(pageA);
  const slugA = await uploadFromHome(pageA); // enrolled via A's key

  // Device B: starts cold, makes its own un-enrolled share (S2).
  const pageB = await newDevice(browser, '203.0.113.30');
  const slugB = await uploadFromHome(pageB); // no key yet → S2 unclaimed

  // B imports A's code. Server list returns S1; B's local remnant S2 is claimed.
  await pageB.goto('/my-shares');
  await expect(pageB.locator('#setup')).toBeVisible();
  await pageB.click('#show-import-btn');
  await pageB.fill('#import-input', code);
  await pageB.click('#import-btn');

  await expect(pageB.locator('#list-region')).toBeVisible();
  // Reconnected to S1 (from the server) AND pulled in S2 (claimed locally).
  await expect(pageB.locator('#shares-list')).toContainText(slugA);
  await expect(pageB.locator('#shares-list')).toContainText(slugB);
});
