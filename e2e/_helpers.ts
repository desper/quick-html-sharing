import { type Browser, type Page, expect } from '@playwright/test';

/**
 * Shared device/upload plumbing for the E2E suites.
 *
 * THE IP MATTERS MORE THAN IT LOOKS
 *
 * The worker caps uploads at 1 per 30 seconds per client IP, keyed off
 * `CF-Connecting-IP`. Handing every browser context a hard-coded address meant
 * the suite passed on a cold run and failed on the next one inside that window
 * — including the ordinary "run one test, then run the whole file" loop, where
 * the failure surfaces as an unrelated `#result-panel` timeout rather than as
 * "you were rate limited". A test that fails because it just ran teaches people
 * to ignore it.
 *
 * So each device gets a fresh address. The worker only hashes this string, so
 * width is the only thing that matters: 2001:db8::/32 (the IPv6 documentation
 * range) gives enough of it that collisions across runs stop being a concern.
 */
export function nextClientIp(): string {
  const quad = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  return `2001:db8:${quad()}:${quad()}:${quad()}:${quad()}::1`;
}

/** A fresh cookie/localStorage-isolated context behind its own client IP. */
export async function newDevice(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    extraHTTPHeaders: { 'CF-Connecting-IP': nextClientIp() },
  });
  return ctx.newPage();
}

export interface UploadedShare {
  slug: string;
  editToken: string;
}

/** Types HTML into the homepage editor, clicks Share, returns the new credentials. */
export async function uploadFromHome(page: Page, html: string): Promise<UploadedShare> {
  await page.goto('/');
  await page.fill('#html-input', html);
  await page.click('#share-btn');
  await expect(page.locator('#result-panel')).toBeVisible();

  const shareUrl = await page.locator('#share-url').inputValue();
  const slug = new URL(shareUrl).pathname.replace(/^\//, '');
  const editUrl = await page.locator('#edit-url').inputValue();
  const editToken = new URL(editUrl).hash.replace('#edit=', '');

  expect(slug).not.toHaveLength(0);
  expect(editToken).not.toHaveLength(0);
  return { slug, editToken };
}
