// Owner tools → Builds and storage: list builds, preselect old KodeX versions, delete on confirm.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const html = (await readFile(resolve('factory/index.html'), 'utf8')).replace('<head>', '<head>\n<script>window.INSTAPPED_EDITION={edition:"master"};</script>');
const id = n => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const B = (n, pkg, app, v, code, date, extra = {}) => ({ id: id(n), tag: 'build-' + id(n), createdAt: date, size: 5e6, hasRelease: true, packageName: pkg, appName: app, versionName: v, versionCode: code, testBuild: false, ...extra });
const builds = [
  B(1, 'com.duelsynapse.kodex', 'Meiocg KodeX', '1.0.3', 3, '2026-10-22T10:00:00Z'),
  B(2, 'com.duelsynapse.kodex', 'Meiocg KodeX', '1.0.3', 3, '2026-10-20T10:00:00Z'),
  B(3, 'com.duelsynapse.kodex', 'Meiocg Kodex', '1.0.0', 1, '2026-10-12T10:00:00Z'),
  B(4, 'com.duelsynapse.swiss', 'MEIOCG Swiss', '1.0.0', 2, '2026-10-22T09:00:00Z'),
  B(5, 'com.duelsynapse.swiss', 'Duel Synapse', '1.0.0', 1, '2026-10-20T09:00:00Z'),
  B(6, 'com.castel.myapp', 'KodeX', '1.0.0', 1, '2026-09-19T10:00:00Z'),
  B(7, 'com.castel.myapp', 'KodeX YGO', '1.0.0', 1, '2026-09-20T10:00:00Z'),
  B(8, 'com.castelmei.castefy', 'Castefy', '1.2.0', 2, '2026-10-12T10:00:00Z'),
  B(9, 'com.castelmei.castefy', 'Castefy', '1.0.0', 1, '2026-10-16T10:00:00Z'),
  { id: '', tag: 'test-latest', special: true, name: 'instApped Test APK', createdAt: '2026-08-28T10:00:00Z', size: 4e6, hasRelease: true },
];
const orphan = { id: id(10), tag: 'build-' + id(10), hasRelease: false, size: 0, packageName: 'com.duelsynapse.kodex', appName: 'Meiocg KodeX', versionName: '1.0.3', versionCode: 3, createdAt: '' };
const deleted = [];
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(r => server.listen(4179, '127.0.0.1', r));
const results = [];
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); results.push('PASS: ' + msg); };
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
  await ctx.route('http://127.0.0.1:4179/**', route => {
    const url = new URL(route.request().url()), body = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    const json = d => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    if (url.pathname === '/license/verify') return json({ ok: true, valid: true, owner: true, plan: 'business' });
    if (url.pathname === '/admin/status') return json({ ok: true, revision: 'test', config: {} });
    if (url.pathname === '/admin/builds') return json({ ok: true, page: 1, done: true, builds: builds.filter(b => !deleted.includes(b.id)), branchIds: [...builds.filter(b => b.id).map(b => b.id), orphan.id].filter(x => !deleted.includes(x)) });
    if (url.pathname === '/admin/builds/describe') return json({ ok: true, builds: body.ids.includes(orphan.id) ? [orphan] : [] });
    if (url.pathname === '/admin/builds/delete') { deleted.push(...body.ids); return json({ ok: true, results: body.ids.map(i => ({ id: i, release: true, tag: true, branch: true, artifacts: 1, errors: [] })) }); }
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/plans') || url.pathname.startsWith('/health')) return json({ ok: true });
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4179/');
  await page.waitForTimeout(300);
  await page.evaluate(() => { P = [{ ...blank(), id: 'p1', name: 'Old Kodex', buildId: id3(), status: 'built', apkUrl: 'x' }]; function id3() { return 'aaaaaaaa-0000-0000-0000-000000000003'; } save(KEY.p, P); });
  await page.click('nav button[data-view=owner]');
  await page.click('#bLoad');
  await page.waitForSelector('#bList .bgrp');
  assert(await page.locator('#bList .bgrp').count() === 5, 'builds are grouped by app (plus other releases)');
  assert(await page.locator('#bList [data-bid]').count() === 11, 'every build is listed, including a failed build with no release');
  assert((await page.locator('#bList').innerText()).includes('Failed or unfinished'), 'failed builds are marked');
  assert(await page.locator('#bList [data-bid=""]').isDisabled(), 'the test release can\'t be selected');
  await page.click('[data-bsel=kodex]');
  const picked = await page.$$eval('#bList [data-bid]:checked', cs => cs.map(c => c.dataset.bid));
  assert(JSON.stringify(picked.sort()) === JSON.stringify([id(2), id(3), id(10), id(6)].sort()), 'Old KodeX versions selects older KodeX builds and keeps the newest of each KodeX app');
  assert(!picked.includes(id(1)) && !picked.includes(id(7)), 'the newest Meiocg KodeX and newest com.castel.myapp builds are kept');
  assert(!picked.includes(id(4)) && !picked.includes(id(5)) && !picked.includes(id(8)), 'Swiss and Castefy builds are left alone');
  assert((await page.locator('#bSum').textContent()).startsWith('4 builds selected'), 'the selection is summarised');
  // Cancel the confirmation: nothing is deleted.
  page.once('dialog', d => d.dismiss());
  await page.click('#bDelete'); await page.waitForTimeout(200);
  assert(deleted.length === 0, 'cancelling the confirmation deletes nothing');
  // Whole-app checkbox.
  await page.locator('[data-bgrp="com.castel.myapp"]').check();
  assert(await page.locator(`[data-bid="${id(7)}"]`).isChecked(), 'ticking an app selects all of its builds');
  await page.locator('[data-bgrp="com.castel.myapp"]').uncheck();
  await page.click('[data-bsel=kodex]');
  let confirmText = '';
  page.once('dialog', d => { confirmText = d.message(); d.accept(); });
  await page.click('#bDelete');
  await page.waitForFunction(() => /Deleted 4 builds/.test(document.querySelector('#toast').textContent));
  assert(/Delete 4 builds .*can't be undone/s.test(confirmText), 'the confirmation says how many and that it can\'t be undone');
  assert(JSON.stringify(deleted.sort()) === JSON.stringify([id(2), id(3), id(10), id(6)].sort()), 'only the confirmed builds are deleted');
  assert(await page.locator('#bList [data-bid]').count() === 7, 'deleted builds disappear from the list');
  const proj = await page.evaluate(() => P.find(p => p.id === 'p1'));
  assert(proj.buildId === '' && proj.apkUrl === '', 'a project whose build was deleted no longer offers dead downloads');
  // Old versions of every app also covers Swiss and Castefy, still keeping each app's newest.
  await page.click('[data-bsel=old]');
  const all = await page.$$eval('#bList [data-bid]:checked', cs => cs.map(c => c.dataset.bid));
  assert(JSON.stringify(all.sort()) === JSON.stringify([id(5), id(8)].sort()), 'Old versions of every app keeps the newest build of each app');
  assert(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
console.log(`\n${results.length} cleanup checks passed.`);
