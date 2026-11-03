import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
const baseUrl = process.env.ADOPTION_URL;
const expectedReactVersion = process.env.ADOPTION_REACT_VERSION;

before(async () => {
  assert.ok(baseUrl, 'ADOPTION_URL must point at the packed consumer fixture');
  assert.ok(expectedReactVersion, 'ADOPTION_REACT_VERSION must select the packed React version');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__adoptionReactVersion !== undefined);
  assert.equal(await page.evaluate(() => window.__adoptionReactVersion), expectedReactVersion);
  await page.close();
});

after(async () => { await browser?.close(); });

async function openPage(context, query = '') {
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(`${baseUrl}/${query}`);
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[aria-label="Draft body"]');
    return input && !input.disabled;
  });
  return page;
}

async function hasRecoveryRecord(page, account, editorId) {
  account ??= await page.getAttribute('[data-testid="editor"]', 'data-account');
  editorId ??= await page.getAttribute('[data-testid="editor"]', 'data-editor');
  return page.evaluate(({ userId, writerId }) => localStorage.getItem(
    `react-draft-recovery:${JSON.stringify([userId, 'article-7', writerId])}`,
  ) !== null, { userId: account, writerId: editorId });
}

test('the packed React hook restores after reload only by explicit choice', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);

  await page.getByLabel('Draft body').fill('saved before reload');
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('react-draft-recovery:')));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'available');

  assert.equal(await page.getByLabel('Draft body').inputValue(), '');
  await page.getByRole('button', { name: 'Restore recovery draft' }).click();
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'saved before reload');
  assert.equal(await page.getByTestId('approval').textContent(), 'awaiting_review');
});

test('A-to-B-to-A changes isolate drafts and discard a stale account response', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context, '?staleLoad=1');
  await page.waitForFunction(() => window.__adoptionBackend.pendingLoads.length === 1);

  await page.getByLabel('Draft body').fill('alice draft');
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('react-draft-recovery:')));
  await page.getByLabel('Account').selectOption('bob');
  await page.waitForFunction(() => document.querySelector('[data-testid="editor"]')?.dataset.account === 'bob');
  await page.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'none');
  assert.equal(await page.getByLabel('Draft body').inputValue(), '');

  await page.getByLabel('Draft body').fill('bob draft');
  await page.getByLabel('Account').selectOption('alice');
  await page.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'available');
  assert.equal(await page.getByLabel('Draft body').inputValue(), '');
  await page.getByRole('button', { name: 'Restore recovery draft' }).click();
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'alice draft');

  await page.evaluate(() => window.__adoptionBackend.pendingLoads.shift()());
  await page.waitForFunction(() => window.__adoptionBackend.staleLoadsResolved === 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'alice draft');
  assert.equal(await page.getByTestId('remote-body').textContent(), '');
});

test('separate editor scopes are isolated and a new tab offers explicit recovery', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const left = await openPage(context, '?editor=left');
  await left.getByLabel('Draft body').fill('left writer');
  const right = await openPage(context, '?editor=right');
  assert.equal(await right.getByTestId('candidate').textContent(), 'none');
  assert.equal(await right.getByLabel('Draft body').inputValue(), '');

  const competingTab = await openPage(context, '?editor=left');
  assert.equal(await competingTab.getByTestId('candidate').textContent(), 'available');
  assert.equal(await competingTab.getByLabel('Draft body').inputValue(), '');
  assert.equal(await left.getByLabel('Draft body').inputValue(), 'left writer');
});

test('a live competing tab receives a storage event without replacing active input', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const a = await openPage(context, '?editor=shared');
  const b = await openPage(context, '?editor=shared');

  await a.getByLabel('Draft body').fill('tab A text');
  await b.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'available');
  await b.getByLabel('Draft body').fill('tab B text');
  await b.waitForFunction(() => document.querySelector('[data-testid="error"]')?.textContent === 'recovery_pending');

  await b.getByRole('button', { name: 'Restore recovery draft' }).click();
  await b.getByLabel('Draft body').fill('tab B after restore');
  await a.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'available');
  assert.equal(await a.getByLabel('Draft body').inputValue(), 'tab A text');
  assert.equal(await b.getByLabel('Draft body').inputValue(), 'tab B after restore');
});

test('quota failure keeps active input visible and reports the storage error', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key.startsWith('react-draft-recovery:')) throw new DOMException('Storage is full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
  await page.getByLabel('Draft body').fill('still in memory');
  await page.waitForFunction(() => document.querySelector('[data-testid="error"]')?.textContent === 'storage_quota');

  assert.equal(await page.getByLabel('Draft body').inputValue(), 'still in memory');
  assert.equal(await hasRecoveryRecord(page), false);
});

test('blocked localStorage keeps active input visible and reports storage unavailable', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Access denied', 'SecurityError'); },
    });
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
  await page.getByLabel('Draft body').fill('still editable without storage');
  await page.waitForFunction(() => document.querySelector('[data-testid="error"]')?.textContent === 'storage_unavailable');

  assert.equal(await page.getByLabel('Draft body').inputValue(), 'still editable without storage');
});

test('delayed and uncertain remote outcomes preserve newer input and replay the same request', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);

  await page.evaluate(() => { window.__adoptionBackend.delayNextSave = true; });
  await page.getByLabel('Draft body').fill('submitted snapshot');
  await page.getByRole('button', { name: 'Save remotely' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'saving');
  await page.getByLabel('Draft body').fill('newer input');
  await page.waitForFunction(() => window.__adoptionBackend.pendingSaves.length === 1);
  await page.evaluate(() => window.__adoptionBackend.pendingSaves.shift()());
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'idle');
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'newer input');
  assert.equal(await page.getByTestId('dirty').textContent(), 'true');
  assert.equal(await page.getByTestId('remote-body').textContent(), 'submitted snapshot');

  await page.evaluate(() => { window.__adoptionBackend.unknownNextSave = true; });
  await page.getByRole('button', { name: 'Save remotely' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'unknown');
  const firstRequest = await page.evaluate(() => window.__adoptionBackend.requests.at(-1));
  // Unknown outcomes use the engine's 250 ms retry backoff; wait past it before explicit replay.
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Retry remote save' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="status"]')?.textContent === 'idle');
  const replayedRequest = await page.evaluate(() => window.__adoptionBackend.requests.at(-1));
  assert.deepEqual(replayedRequest, firstRequest);
  assert.equal(await page.getByTestId('remote-body').textContent(), 'newer input');
});

test('external document creation acknowledges the server identity without dropping later edits', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context);

  await page.getByLabel('Draft body').fill('submitted for publication');
  await page.evaluate(() => { window.__adoptionBackend.delayNextDocument = true; });
  await page.getByRole('button', { name: 'Publish document' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="document-saving"]')?.textContent === 'true');
  await page.getByLabel('Draft body').fill('typed while publishing');
  await page.waitForFunction(() => window.__adoptionBackend.documentRequests.length === 1);
  const submitted = await page.evaluate(() => window.__adoptionBackend.documentRequests[0]);
  assert.equal(submitted.document.id, null);
  await page.evaluate(() => window.__adoptionBackend.pendingDocument());

  await page.waitForFunction(() => document.querySelector('[data-testid="document-id"]')?.textContent === 'server-article-42');
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'typed while publishing');
  assert.equal(await page.getByTestId('document-dirty').textContent(), 'true');
});

test('legacy import restores content only and preserves the source when cleanup fails', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function removeItem(key) {
      if (key.startsWith('legacy:v1:')) throw new DOMException('Storage is blocked', 'SecurityError');
      return original.call(this, key);
    };
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
  await page.getByRole('button', { name: 'Seed legacy record' }).click();
  await page.getByRole('button', { name: 'Import legacy record' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'available');
  assert.equal(await page.getByLabel('Draft body').inputValue(), '');
  await page.getByRole('button', { name: 'Use imported legacy draft' }).click();

  await page.waitForFunction(() => /cleanup failed/.test(
    document.querySelector('[data-testid="legacy-cleanup"]')?.textContent ?? '',
  ));
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'Legacy recovery text');
  assert.equal(await page.getByTestId('approval').textContent(), 'awaiting_review');
  assert.match(await page.getByTestId('legacy-cleanup').textContent(), /cleanup failed/i);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('legacy:v1:alice:'))), true);
  assert.equal(await hasRecoveryRecord(page), true);
});

test('legacy import keeps the source when persisting the restored copy fails', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__blockRecoveryPersistence = false;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (window.__blockRecoveryPersistence && key.startsWith('react-draft-recovery:')) {
        throw new DOMException('Storage is full', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.goto(baseUrl);
  await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
  await page.getByRole('button', { name: 'Seed legacy record' }).click();
  await page.getByRole('button', { name: 'Import legacy record' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="candidate"]')?.textContent === 'available');
  await page.evaluate(() => { window.__blockRecoveryPersistence = true; });
  await page.getByRole('button', { name: 'Use imported legacy draft' }).click();

  await page.waitForFunction(() => /Local recovery save failed/.test(
    document.querySelector('[data-testid="legacy-cleanup"]')?.textContent ?? '',
  ));
  assert.equal(await page.getByLabel('Draft body').inputValue(), 'Legacy recovery text');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('legacy:v1:alice:'))), true);
});

test('Chromium router confirmation and pagehide preserve manual local recovery', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await openPage(context, '?manual=1');
  await page.getByLabel('Draft body').fill('manual local draft');
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty"]')?.textContent === 'true');
  assert.equal(await hasRecoveryRecord(page), false);

  const warningPrevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(warningPrevented, true);

  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Navigate next' }).click();
  assert.notEqual(new URL(page.url()).hash, '#next');
  assert.equal(await hasRecoveryRecord(page), false);

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Navigate next' }).click();
  await page.waitForFunction(() => location.hash === '#next');
  assert.equal(await hasRecoveryRecord(page), true);

  const pagehidePage = await openPage(context, '?manual=1&editor=pagehide');
  await pagehidePage.getByLabel('Draft body').fill('pagehide draft');
  assert.equal(await hasRecoveryRecord(pagehidePage), false);
  pagehidePage.on('dialog', dialog => dialog.accept());
  await pagehidePage.goto(new URL('/destination.html', baseUrl).href);
  assert.equal(await pagehidePage.getByText('Navigation completed').textContent(), 'Navigation completed');
  assert.equal(await hasRecoveryRecord(pagehidePage, 'alice', 'pagehide'), true);
});
