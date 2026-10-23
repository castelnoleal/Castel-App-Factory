// Long text (errors, URLs, build IDs, package names) must never widen the page on a phone,
// otherwise mobile browsers and the Android app zoom the whole factory out.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const html = await readFile(resolve('factory/index.html'), 'utf8');
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(r => server.listen(4178, '127.0.0.1', r));
const results = [];
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); results.push('PASS: ' + msg); };
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 360, 412]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
    await ctx.route('https://api.instapped.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' }));
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:4178/');
    await page.waitForTimeout(300);
    const fits = async () => page.evaluate(w => innerWidth === w && document.documentElement.scrollWidth <= w && document.body.scrollWidth <= w, width);
    await page.evaluate(() => {
      $('#status').textContent = 'Previous build ready · update pending'; $('#status').className = 'pill ok';
      go(6);
      log('Build queued: 846d760b-6b59-48bf-8fcb-837bd331e820');
      log('Build is still running or its status could not be confirmed. Your build ID has been saved. Use Check build in Projects; do not rebuild yet.', 'err');
      log('https://github.com/castelnoleal/instApped/actions/runs/39901377592/job/120243509390?check_suite_focus=true&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'err');
      toast('GitHub didn\'t start the build because of a billing problem on the GitHub account that runs the builds (a failed payment or a spending limit of $0).');
    });
    await page.waitForTimeout(150);
    assert(await fits(), `${width}px: the Build step with long log lines fits the screen`);
    assert(await page.locator('header h1').evaluate(h => h.scrollWidth <= h.clientWidth + 1), `${width}px: the instApped title isn't squeezed by a long status`);
    await page.evaluate(() => {
      const list = [{ ...blank(), id: 'a', name: 'Meiocg KodeX with a much longer project name here', pkg: 'com.duelsynapse.kodex.extra.long.packagename', status: 'built', buildId: 'x', pendingBuildId: 'y' }];
      P = list; view('projects');
    });
    await page.waitForTimeout(150);
    assert(await fits(), `${width}px: Projects with long names and every action button fits the screen`);
    await page.evaluate(() => view('settings'));
    await page.waitForTimeout(100);
    assert(await fits(), `${width}px: Settings fits the screen`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
console.log(`\n${results.length} phone layout checks passed.`);
