import { type Page, expect, test } from '@playwright/test';
import { newDevice, uploadFromHome } from './_helpers';

/**
 * The four critical paths from the version-history test plan. Each one is here
 * because it spans boundaries no single unit test can cover: browser
 * credentials (URL fragment vs localStorage) → dashboard worker → R2/D1 → the
 * *share* worker, which is a separate process serving a separate origin.
 *
 * Notably the share-origin assertions: `apps/worker/test/versions.test.ts`
 * already proves latest_version advances, but "the recipient sees the restored
 * content" is a claim about a different worker reading the same buckets. That
 * is the promise the feature makes to the user, so it gets asserted against the
 * real second process.
 *
 * Each device gets its own context and its own client IP (see _helpers).
 */

const SHARE_ORIGIN = 'http://localhost:8788';

/** Saves new HTML through the edit page UI (not the API) and waits for the result. */
async function saveViaEditPage(page: Page, slug: string, editToken: string, html: string) {
  await page.goto(`/edit?slug=${slug}#edit=${editToken}`);
  await page.fill('#html-input', html);
  await page.click('#save-btn');
}

/**
 * One row of the version list. Exact match matters: the live version's label is
 * `Version 3 (current)`, so an exact `Version 3` never selects it — which is
 * what lets the tests below assert on the restore button's absence.
 */
function versionRow(page: Page, version: number) {
  return page
    .locator('#version-list li')
    .filter({ has: page.getByText(`Version ${version}`, { exact: true }) });
}

function currentRow(page: Page, version: number) {
  return page
    .locator('#version-list li')
    .filter({ has: page.getByText(`Version ${version} (current)`, { exact: true }) });
}

/** Clicks a restore button through its two-step confirm. */
async function confirmRestore(page: Page, version: number) {
  const btn = versionRow(page, version).getByRole('button', { name: 'restore' });
  await btn.click();
  await expect(btn).toHaveText('Confirm restore?');
  await btn.click();
}

/** Reads the share page from the *share* worker — a different origin and process. */
async function readShare(page: Page, slug: string): Promise<string> {
  const res = await page.request.get(`${SHARE_ORIGIN}/${slug}`);
  expect(res.status()).toBe(200);
  return res.text();
}

test('① 誤蓋救回:預覽確認後還原,不必重貼 HTML', async ({ browser }) => {
  const page = await newDevice(browser);
  const { slug, editToken } = await uploadFromHome(
    page,
    '<!doctype html><title>good</title><h1>the good version</h1>',
  );

  // The mistake: overwrite the good content with something wrong.
  await saveViaEditPage(page, slug, editToken, '<!doctype html><h1>OOPS wrong content</h1>');
  await expect(page.locator('#success-msg')).toBeVisible();
  expect(await readShare(page, slug)).toContain('OOPS wrong content');

  // The rescue starts from the link on the edit page, carrying the fragment
  // token across the navigation — if it didn't, the version page would have no
  // credential and the whole path would dead-end.
  await page.click('#versions-link');
  await expect(page.locator('#slug-line')).toHaveText(slug);
  await expect(currentRow(page, 2)).toBeVisible();

  // Preview v1 before committing to it (critical path ③ in miniature).
  await versionRow(page, 1).getByRole('button', { name: 'view source' }).click();
  const source = versionRow(page, 1).locator('.version-source');
  await expect(source).toContainText('the good version');

  await confirmRestore(page, 1);
  await expect(page.locator('#status-msg')).toContainText('Restored version 1 as version 3');

  // The payoff: the recipient-facing origin serves the good content again, and
  // the user never re-pasted any HTML.
  const served = await readShare(page, slug);
  expect(served).toContain('the good version');
  expect(served).not.toContain('OOPS wrong content');

  // Restore appended rather than rewound: nothing was destroyed.
  await expect(currentRow(page, 3)).toBeVisible();
  await expect(versionRow(page, 2)).toBeVisible();
  await expect(versionRow(page, 1)).toBeVisible();
});

test('① 之二:還原是可逆的,且最新版沒有還原按鈕', async ({ browser }) => {
  const page = await newDevice(browser);
  const { slug, editToken } = await uploadFromHome(
    page,
    '<!doctype html><title>a</title><h1>first</h1>',
  );
  await saveViaEditPage(page, slug, editToken, '<!doctype html><h1>second</h1>');
  await expect(page.locator('#success-msg')).toBeVisible();

  await page.goto(`/versions?slug=${slug}#edit=${editToken}`);
  await confirmRestore(page, 1); // v3 == v1 content
  await expect(currentRow(page, 3)).toBeVisible();
  expect(await readShare(page, slug)).toContain('first');

  // Undo the undo. v2's content comes back as v4.
  await confirmRestore(page, 2);
  await expect(currentRow(page, 4)).toBeVisible();
  expect(await readShare(page, slug)).toContain('second');

  // The live version must not offer restore: it would append an identical copy
  // and quietly push a real older version out of the retention window.
  await expect(currentRow(page, 4).getByRole('button', { name: 'restore' })).toHaveCount(0);
  await expect(versionRow(page, 3).getByRole('button', { name: 'restore' })).toHaveCount(1);
});

test('② 跨裝置救回:B 裝置全程沒有 edit token', async ({ browser }) => {
  // Device A: creates a sync code, uploads (auto-enrolled), then ruins it.
  const deviceA = await newDevice(browser);
  await deviceA.goto('/my-shares');
  await deviceA.click('#create-btn');
  await expect(deviceA.locator('#code-reveal')).toBeVisible();
  const syncCode = await deviceA.locator('#sync-code').inputValue();
  await deviceA.check('#saved-check');
  await deviceA.click('#continue-btn');

  const { slug, editToken } = await uploadFromHome(
    deviceA,
    '<!doctype html><title>keep</title><h1>content worth keeping</h1>',
  );
  await saveViaEditPage(deviceA, slug, editToken, '<!doctype html><h1>ruined by device A</h1>');
  await expect(deviceA.locator('#success-msg')).toBeVisible();

  // Device B: cold context. Its ONLY credential is the sync code — it never
  // sees the edit token, which is the point of this path.
  const deviceB = await newDevice(browser);
  await deviceB.goto('/my-shares');
  await deviceB.click('#show-import-btn');
  await deviceB.fill('#import-input', syncCode);
  await deviceB.click('#import-btn');
  await expect(deviceB.locator('#shares-list')).toContainText(slug);

  // Enter the version page from the My Shares row: no fragment, no token.
  await deviceB.locator('#shares-list a', { hasText: 'versions' }).first().click();
  await expect(deviceB).toHaveURL(new RegExp(`/versions\\?slug=${slug}$`));
  expect(deviceB.url()).not.toContain('edit=');

  // List, preview and restore must all work off the owner key alone.
  await expect(currentRow(deviceB, 2)).toBeVisible();
  await versionRow(deviceB, 1).getByRole('button', { name: 'view source' }).click();
  await expect(versionRow(deviceB, 1).locator('.version-source')).toContainText(
    'content worth keeping',
  );
  await confirmRestore(deviceB, 1);
  await expect(currentRow(deviceB, 3)).toBeVisible();

  expect(await readShare(deviceB, slug)).toContain('content worth keeping');
});

test('③ 預覽先於曝光:預覽讀得到內容,但不會發布,也不會在 dashboard 上被執行', async ({
  browser,
}) => {
  const page = await newDevice(browser);
  // v1 stands in for a version holding something the user later removed on
  // purpose — a secret. Blind-restoring it would republish that secret, so the
  // preview has to show it first.
  const { slug, editToken } = await uploadFromHome(
    page,
    '<!doctype html><title>s</title><h1>API_KEY=sk-do-not-publish</h1><script>window.__pwned=1</script>',
  );
  await saveViaEditPage(page, slug, editToken, '<!doctype html><h1>secret removed</h1>');
  await expect(page.locator('#success-msg')).toBeVisible();

  await page.goto(`/versions?slug=${slug}#edit=${editToken}`);
  await versionRow(page, 1).getByRole('button', { name: 'view source' }).click();
  const source = versionRow(page, 1).locator('.version-source');
  await expect(source).toContainText('API_KEY=sk-do-not-publish');

  // Shown as text, never parsed: the <pre> holds no element children and the
  // script never ran. Rendering user HTML on the dashboard origin is precisely
  // what the two-origin split exists to prevent.
  expect(await source.evaluate((el) => el.children.length)).toBe(0);
  expect(await page.evaluate(() => (globalThis as { __pwned?: number }).__pwned)).toBe(undefined);

  // Previewing published nothing: the share still serves the redacted version.
  const served = await readShare(page, slug);
  expect(served).toContain('secret removed');
  expect(served).not.toContain('sk-do-not-publish');
});

test('④ 並行編輯不丟資料:兩份內容都留在版本歷史裡', async ({ browser }) => {
  const page = await newDevice(browser);
  const { slug, editToken } = await uploadFromHome(
    page,
    '<!doctype html><title>c</title><h1>base</h1>',
  );

  // Two tabs on the same share, both loaded before either saves.
  const tabA = page;
  const tabB = await page.context().newPage();
  await tabA.goto(`/edit?slug=${slug}#edit=${editToken}`);
  await tabB.goto(`/edit?slug=${slug}#edit=${editToken}`);

  const textA = '<!doctype html><h1>written in tab A</h1>';
  const textB = '<!doctype html><h1>written in tab B</h1>';
  await tabA.fill('#html-input', textA);
  await tabB.fill('#html-input', textB);

  await Promise.all([tabA.click('#save-btn'), tabB.click('#save-btn')]);

  // Deliberately NOT asserting that someone gets a 409. writeNewVersion retries
  // past a lost CAS, so under real contention both writers usually land — that
  // is the feature working, not a missed case. What must hold either way: every
  // tab ends up with a definite answer, and a tab told "conflict" still has the
  // user's text (the 409 message promises exactly that).
  for (const [tab, text] of [
    [tabA, textA],
    [tabB, textB],
  ] as const) {
    await expect(tab.locator('#success-msg, #error-msg').and(tab.locator(':visible'))).toHaveCount(
      1,
    );
    if (await tab.locator('#error-msg').isVisible()) {
      await expect(tab.locator('#error-msg')).toContainText('409');
      expect(await tab.locator('#html-input').inputValue()).toBe(text);
      await tab.click('#save-btn');
      await expect(tab.locator('#success-msg')).toBeVisible();
    }
  }

  // Both texts survive in the history: no writer was silently overwritten.
  // Read them through the API rather than the DOM — the question here is
  // whether the bytes are still stored, and test ① already covers the fact that
  // "view source" renders them.
  const listed = await tabA.request.post(`/api/share/${slug}/versions`, { data: { editToken } });
  const { versions } = (await listed.json()) as { versions: { version: number }[] };
  const sources = await Promise.all(
    versions.map(async (v) => {
      const res = await tabA.request.post(`/api/share/${slug}/versions/${v.version}/raw`, {
        data: { editToken },
      });
      return res.text();
    }),
  );
  expect(sources.some((s) => s.includes('written in tab A'))).toBe(true);
  expect(sources.some((s) => s.includes('written in tab B'))).toBe(true);
});

test('④ 之二:收到 409 時編輯框不清空,再按一次就成功', async ({ browser }) => {
  const page = await newDevice(browser);
  const { slug, editToken } = await uploadFromHome(
    page,
    '<!doctype html><title>k</title><h1>base</h1>',
  );

  // Natural contention resolves itself (see the test above), so the 409 is
  // injected here instead. What is under test is the UI's half of the contract
  // — "Your content is still here — save again" is only true if the textarea
  // survives the failure — and that must hold no matter how rare the 409 is.
  let injected = false;
  await page.route('**/api/edit/**', async (route) => {
    if (injected) return route.continue();
    injected = true;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'conflict',
        message: 'Another edit landed first. Your content is still here — save again.',
      }),
    });
  });

  const draft = '<!doctype html><h1>a draft the user must not lose</h1>';
  await page.goto(`/edit?slug=${slug}#edit=${editToken}`);
  await page.fill('#html-input', draft);
  await page.click('#save-btn');

  await expect(page.locator('#error-msg')).toContainText('409');
  expect(await page.locator('#html-input').inputValue()).toBe(draft);
  // The button has to come back, or "save again" is impossible to follow.
  await expect(page.locator('#save-btn')).toBeEnabled();

  await page.click('#save-btn');
  await expect(page.locator('#success-msg')).toBeVisible();
  await expect(page.locator('#error-msg')).toBeHidden();
  expect(await readShare(page, slug)).toContain('a draft the user must not lose');
});
