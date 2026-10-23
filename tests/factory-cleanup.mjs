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
  { id: '', tag: 'cards-test-latest', special: true, name: 'MEIOCG Cards Test APK', createdAt: '2026-08-28T10:00:00Z', size: 4.3e6, hasRelease: true },
];
const orphan = { id: id(10), tag: 'build-' + id(10), hasRelease: false, size: 0, packageName: 'com.duelsynapse.kodex', appName: 'Meiocg KodeX', versionName: '1.0.3', versionCode: 3, createdAt: '' };
const deleted = [], deletedTags = [], deletedArtifacts = [], deletedBranches = [], revoked = [];
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
    if (url.pathname === '/admin/activity') return json({ ok: true, repo: { visibility: 'public', url: 'https://github.com/castelnoleal/instApped' }, actions: { blocked: true, message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' }, builds: [
      { runId: 1, url: 'https://github.com/x/1', status: 'completed', conclusion: 'failure', createdAt: '2026-10-23T04:38:18Z', id: id(10), appName: 'Meiocg KodeX', packageName: 'com.duelsynapse.kodex', versionName: '1.0.3', reason: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' },
      { runId: 2, url: 'https://github.com/x/2', status: 'completed', conclusion: 'success', createdAt: '2026-10-22T17:14:33Z', id: id(1), appName: 'Meiocg KodeX', packageName: 'com.duelsynapse.kodex', versionName: '1.0.3', reason: '' }] });
    if (url.pathname === '/admin/releases/delete') { deletedTags.push(...body.tags); body.tags.forEach(t => { const i = builds.findIndex(b => b.tag === t); if (i >= 0) builds.splice(i, 1); }); return json({ ok: true, results: body.tags.map(t => ({ tag: t, release: true, tagRef: true, errors: [] })) }); }
    if (url.pathname === '/admin/artifacts') return json({ ok: true, artifacts: [1, 2, 3].filter(n => !deletedArtifacts.includes(n)).map(n => ({ id: n, name: ['castel-template-verification', 'EDOPro-Synapse', 'synapse-build-inputs'][n - 1], size: 5e7, createdAt: '2026-10-20T00:00:00Z', expiresAt: '2027-01-18T00:00:00Z', branch: 'main' })), total: 1.5e8 });
    if (url.pathname === '/admin/artifacts/delete') { deletedArtifacts.push(...body.ids); return json({ ok: true, deleted: body.ids.length, errors: [] }); }
    if (url.pathname === '/admin/branches') return json({ ok: true, main: 'main', branches: [{ name: 'editions', status: 'merged', pr: 9, ahead: 2, lastCommit: '2026-10-22T00:00:00Z' }, { name: 'plans-popup', status: 'in-main', ahead: 0, lastCommit: '2026-10-22T00:00:00Z' }, { name: 'synapse-android', status: 'unmerged', ahead: 14, lastCommit: '2026-09-01T00:00:00Z' }].filter(b => !deletedBranches.includes(b.name)) });
    if (url.pathname === '/admin/branches/delete') { deletedBranches.push(...body.names); return json({ ok: true, deleted: body.names.length, errors: [] }); }
    if (url.pathname === '/admin/licenses') return json({ ok: true, available: true, sales: [{ source: 'website', ref: 'IA-SALE1', plan: 'pro', exp: Date.now() + 864e5 * 20, revoked: false }], play: [{ source: 'google-play', ref: 'play:GPA.1', plan: 'business', exp: Date.now() + 864e5 * 5, revoked: false }], complimentary: [{ source: 'complimentary', ref: 'comp:abc', plan: 'pro', exp: Date.now() - 864e5, note: 'Client A', revoked: true }], revoked: [{ ref: 'comp:abc', at: 1 }] });
    if (url.pathname === '/admin/revoke') { revoked.push(body.ref); return json({ ok: true, revoked: body.ref }); }
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/plans') || url.pathname.startsWith('/health')) return json({ ok: true });
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4179/');
  await page.waitForTimeout(300);
  await page.evaluate(() => { P = [{ ...blank(), id: 'p1', name: 'Old Kodex', buildId: id3(), status: 'built', apkUrl: 'x' }]; function id3() { return 'aaaaaaaa-0000-0000-0000-000000000003'; } save(KEY.p, P); });
  await page.click('nav button[data-view=owner]');
  await page.waitForFunction(() => document.querySelectorAll('#oBuilds .orun').length === 2);
  assert((await page.locator('#oAlerts').innerText()).includes('The repository is public'), 'the overview warns that the repository is public');
  assert((await page.locator('#oAlerts').innerText()).includes("GitHub isn't running builds"), 'the overview flags GitHub refusing builds');
  assert((await page.locator('#oBuilds').innerText()).includes('Failed') && (await page.locator('#oBuilds').innerText()).includes('spending limit'), 'recent builds show the failure reason');
  await page.click('#bLoad');
  await page.waitForSelector('#bList .bgrp');
  assert(await page.locator('#bList .bgrp').count() === 4, 'builds are grouped by app');
  assert(await page.locator('#bList [data-bid]').count() === 10, 'every build is listed, including a failed build with no release');
  assert((await page.locator('#bList').innerText()).includes('Failed or unfinished'), 'failed builds are marked');
  const isOn = sel => page.locator(sel).isChecked();
  // Safety: newest builds are protected, and tapping an app's name selects nothing.
  for (const n of [1, 4, 7, 9]) assert(await page.locator(`[data-bid="${id(n)}"]`).isDisabled(), `newest build ${n} is protected`);
  await page.locator('.bgrp[data-pkg="com.duelsynapse.kodex"] .bhead span').click();
  assert(await page.locator('#bList [data-bid]:checked').count() === 0, "tapping an app's name doesn't select its builds");
  await page.locator(`.brow:has([data-bid="${id(2)}"]) span`).click();
  assert(!(await isOn(`[data-bid="${id(2)}"]`)), "tapping a build's text doesn't select it");
  await page.locator('[data-bgrp="com.duelsynapse.kodex"]').check();
  assert(await isOn(`[data-bid="${id(2)}"]`) && !(await isOn(`[data-bid="${id(1)}"]`)), "an app's checkbox selects its old builds but not the protected newest one");
  await page.click('[data-bsel=none]');
  await page.click('[data-bsel=kodex]');
  const picked = await page.$$eval('#bList [data-bid]:checked', cs => cs.map(c => c.dataset.bid));
  assert(JSON.stringify(picked.sort()) === JSON.stringify([id(2), id(3), id(10), id(6)].sort()), 'Old KodeX versions selects older KodeX builds only');
  assert((await page.locator('#bSum').textContent()).startsWith('4 builds selected'), 'the selection is summarised');
  await page.click('[data-bsel=failed]');
  assert(JSON.stringify(await page.$$eval('#bList [data-bid]:checked', cs => cs.map(c => c.dataset.bid))) === JSON.stringify([id(10)]), 'Failed builds selects only builds without downloads');
  // Cancel: nothing is deleted.
  await page.click('[data-bsel=kodex]');
  await page.click('#bDelete');
  await page.waitForFunction(() => document.querySelector('#delDlg').open);
  assert(/Delete 4 builds\?/.test(await page.locator('#delTitle').textContent()) && /can't be undone/.test(await page.locator('#delBody').textContent()), 'the confirmation says how many and that it can\'t be undone');
  assert(await page.locator('#delList li').count() === 4, 'the confirmation lists every build');
  assert(await page.locator('#delWordBox').isHidden(), 'no typing needed when no current build is included');
  await page.click('#delCancel'); await page.waitForTimeout(200);
  assert(deleted.length === 0, 'cancelling deletes nothing');
  await page.click('#bDelete'); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  await page.goBack(); await page.waitForTimeout(250);
  assert(!(await page.locator('#delDlg').evaluate(d => d.open)) && deleted.length === 0, 'the back button cancels too');
  await page.click('#bDelete'); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  await page.click('#delOk');
  await page.waitForFunction(() => /Deleted 4 builds/.test(document.querySelector('#toast').textContent));
  assert(JSON.stringify(deleted.sort()) === JSON.stringify([id(2), id(3), id(10), id(6)].sort()), 'only the confirmed builds are deleted');
  assert(await page.locator('#bList [data-bid]').count() === 6, 'deleted builds disappear from the list');
  const proj = await page.evaluate(() => P.find(p => p.id === 'p1'));
  assert(proj.buildId === '' && proj.apkUrl === '', 'a project whose build was deleted no longer offers dead downloads');
  // Deleting a current build needs protection off and typing DELETE.
  await page.locator('#bProtect').uncheck();
  assert(!(await page.locator(`[data-bid="${id(4)}"]`).isDisabled()), 'turning protection off unlocks the newest builds');
  await page.locator(`[data-bid="${id(4)}"]`).check();
  await page.click('#bDelete'); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  assert(await page.locator('#delWordBox').isVisible() && await page.locator('#delOk').isDisabled(), 'deleting a current build requires typing DELETE');
  assert((await page.locator('#delBody').textContent()).includes('will have no download until rebuilt'), 'the confirmation warns the app will have no download');
  await page.fill('#delWord', 'delete');
  assert(!(await page.locator('#delOk').isDisabled()), 'typing DELETE enables the button');
  await page.click('#delCancel'); await page.waitForTimeout(150);
  assert(!deleted.includes(id(4)), 'the current Swiss build was not deleted');
  await page.locator('#bProtect').check();

  // Test apps tab
  await page.click('#sTabs [data-st=releases]');
  await page.click('#rLoad');
  await page.waitForSelector('#rList .brow');
  assert((await page.locator('#rList').innerText()).includes('cards-test-latest'), 'the cards test app is listed under Test apps');
  await page.click('#rDelete'); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  await page.click('#delOk');
  await page.waitForFunction(() => /Deleted 2 test apps/.test(document.querySelector('#toast').textContent));
  assert(JSON.stringify(deletedTags.sort()) === JSON.stringify(['cards-test-latest', 'test-latest']), 'test apps are deleted');

  // Stored files tab
  await page.click('#sTabs [data-st=files]');
  await page.click('#fLoad');
  await page.waitForSelector('#fList .brow');
  assert((await page.locator('#fSum').textContent()).includes('3 files'), 'stored files are listed with totals');
  await page.click('#fDelete'); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  await page.click('#delOk');
  await page.waitForFunction(() => /Deleted 3 stored files/.test(document.querySelector('#toast').textContent));
  assert(deletedArtifacts.length === 3, 'stored files are deleted');

  // Branches tab: merged ones preselected, unmerged ones need typing
  await page.click('#sTabs [data-st=branches]');
  await page.click('#gLoad');
  await page.waitForSelector('#gList .brow');
  const preset = await page.$$eval('#gList [data-pi]:checked', cs => cs.length);
  assert(preset === 2, 'merged and in-main branches are preselected, unmerged ones aren\'t');
  await page.locator('#gList .brow:has-text("synapse-android") input').check();
  await page.click('#gDelete'); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  assert(await page.locator('#delWordBox').isVisible(), 'deleting an unmerged branch requires typing DELETE');
  await page.fill('#delWord', 'DELETE'); await page.click('#delOk');
  await page.waitForFunction(() => /Deleted 3 branches/.test(document.querySelector('#toast').textContent));
  assert(JSON.stringify(deletedBranches.sort()) === JSON.stringify(['editions', 'plans-popup', 'synapse-android']), 'the chosen branches are deleted');

  // Licenses
  await page.click('#lLoad');
  await page.waitForSelector('#lList table');
  assert(/2 active · 3 on record · 1 revoked/.test(await page.locator('#lList').innerText()), 'licenses are summarised');
  await page.locator('[data-lrev="IA-SALE1"]').click(); await page.waitForFunction(() => document.querySelector('#delDlg').open);
  await page.click('#delOk');
  await page.waitForFunction(() => /License revoked/.test(document.querySelector('#toast').textContent));
  assert(revoked.includes('IA-SALE1'), 'a license can be revoked from the list');
  assert(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
console.log(`\n${results.length} owner tools checks passed.`);
