// Back button on a phone: it must step back inside the factory (close the pop-up or
// preview, then the previous step or page) and only leave from the first screen.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const html = await readFile(resolve('factory/index.html'), 'utf8');
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/start') ? '<!doctype html><title>start</title><a id="go" href="/">factory</a>' : html);
});
await new Promise(r => server.listen(4177, '127.0.0.1', r));
const results = [];
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); results.push('PASS: ' + msg); };
const PLANS = { ok: true, currency: 'PHP', paymentsEnabled: true, plans: [
  { id: 'free', name: 'Free', tagline: 'Build.', features: ['Test APKs'], prices: { monthly: 0, annual: 0 } },
  { id: 'pro', name: 'Pro', tagline: 'Publish.', features: ['Signed AAB'], prices: { monthly: 49900, annual: 499000 } },
  { id: 'business', name: 'Business', tagline: 'Companies.', features: ['Kit'], prices: { monthly: 169000, annual: 1690000 } } ] };

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
  await ctx.route('https://api.instapped.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r.request().url().endsWith('/plans') ? PLANS : { ok: true }) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4177/start');
  await page.click('#go');
  await page.waitForSelector('#planChip');
  await page.waitForTimeout(300);
  const back = async () => { await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(250); };
  const plansOpen = () => page.locator('#plansDlg').evaluate(d => d.open);
  const onView = v => page.locator('#v-' + v).evaluate(e => e.classList.contains('on'));
  const stepNow = () => page.evaluate(() => step);
  const pvNow = () => page.evaluate(() => pvOpen);

  // Create steps
  await page.click('#next'); await page.waitForTimeout(100);
  await page.click('#next'); await page.waitForTimeout(100);
  assert(await stepNow() === 2, 'Next moves through the create steps');
  await back();
  assert(await stepNow() === 1 && await onView('create'), 'back returns to the previous step');

  // Pages
  await page.click('nav button[data-view=settings]'); await page.waitForTimeout(100);
  await back();
  assert(await onView('create') && await stepNow() === 1, 'back from Settings returns to Create at the same step');

  // Plans pop-up from the plan chip
  await page.click('#planChip'); await page.waitForTimeout(150);
  assert(await plansOpen(), 'the plan chip opens Plans');
  await back();
  assert(!(await plansOpen()) && await onView('create'), 'back closes Plans and stays in the factory');

  // Plans from a Pro feature, closed with its own button: back must not reopen it or skip a page
  await page.click('nav button[data-view=settings]'); await page.waitForTimeout(100);
  await page.click('#plansOpen'); await page.waitForTimeout(150);
  await page.click('#plansClose'); await page.waitForTimeout(250);
  assert(!(await plansOpen()) && await onView('settings'), 'Close leaves you on Settings');
  await back();
  assert(!(await plansOpen()) && await onView('create'), 'after closing Plans, back goes to the previous page');

  // Escape and tapping outside
  await page.click('#planChip'); await page.waitForTimeout(150);
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  assert(!(await plansOpen()), 'Escape closes Plans');
  await page.click('#planChip'); await page.waitForTimeout(150);
  await page.mouse.click(4, 4); await page.waitForTimeout(250);
  assert(!(await plansOpen()), 'tapping outside closes Plans');
  await back();
  assert(await onView('create') && await stepNow() === 0, 'closed pop-ups leave no extra back steps');

  // Preview panel
  await page.click('#pvOpen'); await page.waitForTimeout(200);
  assert(await pvNow(), 'Preview opens');
  await back();
  assert(!(await pvNow()) && await onView('create'), 'back closes the preview panel');

  // Upgrade from a Pro feature, then back
  await page.click('#steps button[data-i="2"]'); await page.waitForTimeout(100);
  await page.locator('.seg[data-k=splash] button[data-v=art]').click(); await page.waitForTimeout(150);
  assert(await plansOpen(), 'a Pro feature opens Plans');
  await back();
  assert(!(await plansOpen()) && await stepNow() === 2, 'back closes Plans and keeps your step');
  await back();
  assert(await stepNow() === 0, 'back after a step tab returns to the previous step');

  // #plans link (ad banner) and back
  await page.evaluate(() => { location.hash = '#plans'; }); await page.waitForTimeout(250);
  assert(await plansOpen(), 'a #plans link opens Plans');
  await back();
  assert(!(await plansOpen()), 'one back closes Plans opened from a link');

  // Back to the first screen, then out of the factory
  await back();
  assert(await stepNow() === 0 && await onView('create'), 'back reaches the first screen');
  await back();
  assert(page.url().endsWith('/start'), 'only then does back leave the factory');
  assert(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
} finally {
  await browser.close();
  server.close();
}
console.log(results.join('\n'));
console.log(`\n${results.length} back-button checks passed.`);
