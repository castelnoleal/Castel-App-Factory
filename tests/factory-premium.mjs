// Browser test for plans, checkout, licenses, premium gating and the
// Business publishing kit. The build service and PayMongo are mocked.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const html = await readFile(resolve('factory/index.html'), 'utf8');
const fakeCheckout = "<!doctype html><title>PayMongo test</title><script>setTimeout(()=>location.href='/#purchase=success',200)</script>";
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.url.startsWith('/fake-checkout') ? fakeCheckout : html);
});
await new Promise(r => server.listen(4174, '127.0.0.1', r));

const results = [];
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); results.push('PASS: ' + msg); };
const errors = [];
const state = { claims: 0, builds: [] };
const licenseFor = plan => 'IAL1.' + Buffer.from(JSON.stringify({ v: 1, plan, exp: Date.now() + 34 * 86400000, ref: 'cs_t1' })).toString('base64url') + '.sig';
const PLANS = { ok: true, currency: 'PHP', paymentsEnabled: true, plans: [
  { id: 'free', name: 'Free', tagline: 'Build and test.', features: ['Test APKs'], prices: { monthly: 0, annual: 0 } },
  { id: 'pro', name: 'Pro', tagline: 'Publish on Google Play.', features: ['Signed AAB'], prices: { monthly: 49900, annual: 499000 } },
  { id: 'business', name: 'Business', tagline: 'For companies.', features: ['Publishing kit'], prices: { monthly: 169000, annual: 1690000 } } ] };

async function api(route) {
  const req = route.request(), url = req.url(), body = req.postData() ? JSON.parse(req.postData()) : {};
  const json = (d, status = 200) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(d) });
  if (url.endsWith('/plans')) return json(PLANS);
  if (url.endsWith('/checkout')) { state.checkout = body; return json({ ok: true, sessionId: 'cs_t1', checkoutUrl: 'http://127.0.0.1:4174/fake-checkout', reference: 'IA-ABCDEF123456' }); }
  if (url.endsWith('/license/claim')) {
    if (++state.claims < 2) return json({ ok: false, pending: true }, 202);
    return json({ ok: true, key: licenseFor(state.checkout.plan), plan: state.checkout.plan, exp: Date.now() + 34 * 86400000, reference: 'IA-ABCDEF123456' });
  }
  if (url.endsWith('/license/verify')) {
    const key = String(body.key || '');
    if (!key.startsWith('IAL1.')) return json({ ok: true, valid: false, plan: 'free', reason: "That isn't an instApped license key." });
    const p = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    return json({ ok: true, valid: true, plan: p.plan, exp: p.exp });
  }
  if (url.endsWith('/build') && req.method() === 'POST') {
    state.builds.push(body);
    if (body.signing && !body.licenseKey) return json({ ok: false, code: 'upgrade_required', error: 'Signed Play-ready AAB needs instApped Pro.' }, 402);
    return json({ ok: true, buildId: '11111111-2222-3333-4444-555555555555' });
  }
  if (url.includes('/build/')) return json({ status: 'success', buildApkUrl: 'x', buildAabUrl: 'y' });
  return json({ ok: true });
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 950 } });
  await context.route('https://api.instapped.com/**', api);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForTimeout(300);
  assert((await page.locator('#planChip').textContent()) === 'Free', 'new visitors are on the Free plan');
  assert((await page.locator('#ad-slot').textContent()).includes('See plans'), 'free users see the Pro house ad');

  // Free plan: premium options open the upgrade prompt and stay off.
  await page.locator('.seg[data-k=stype] button[data-v=url]').click();
  await page.locator('[data-k=url]').fill('example.com');
  await page.locator('#steps button[data-i="1"]').click();
  await page.locator('[data-k=name]').fill('Shop App');
  await page.locator('#steps button[data-i="6"]').click();
  const plansOpen = () => page.locator('#plansDlg').evaluate(d => d.open);
  await page.locator('.row:has([data-k=sign])').click();
  assert(await plansOpen(), 'signing on the Free plan opens the Plans pop-up');
  assert((await page.locator('#plansWhy').textContent()).startsWith('Signed Play-ready AAB is part of instApped Pro'), 'the pop-up says which plan the feature needs');
  assert(await page.locator('.plan.need[data-plan=pro]').count() === 1, 'the needed plan is highlighted');
  assert(!(await page.locator('[data-k=sign]').isChecked()), 'signing stays off on the Free plan');
  await page.locator('#plansClose').click();
  assert(!(await plansOpen()), 'Close dismisses the Plans pop-up');
  await page.locator('#steps button[data-i="2"]').click();
  await page.locator('.seg[data-k=splash] button[data-v=art]').click();
  assert((await page.locator('#plansWhy').textContent()).startsWith('Splash art'), 'splash art is gated');
  await page.keyboard.press('Escape');
  assert(!(await plansOpen()), 'Escape dismisses the Plans pop-up');
  await page.locator('[data-k=theme]').fill('#FF0000');
  assert((await page.locator('[data-k=theme]').inputValue()) === '#080B14', 'custom colours are reverted on the Free plan');
  await page.locator('#plansClose').click();

  // Plans and checkout.
  assert(await page.locator('nav button', { hasText: 'Plans' }).count() === 0, 'Plans is not a separate menu item');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert(await page.locator('#v-settings #plansEntry').isVisible() && !(await page.locator('#v-settings .plan').count()), 'Settings shows a Plans entry, not the plans themselves');
  await page.locator('#plansOpen').click();
  assert(await plansOpen() && await page.locator('#plansWhy').isHidden(), 'View plans in Settings opens the pop-up');
  await page.locator('#plansClose').click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('#planChip').click();
  assert(await plansOpen() && await page.locator('#v-create').isVisible(), 'the plan chip opens the pop-up over the current page');
  assert(await page.locator('.plan').count() === 3, 'three plans are shown');
  await page.locator('#billSeg button[data-v=annual]').click();
  assert((await page.locator('.plan[data-plan=pro] .price').textContent()).includes('₱4,990'), 'annual pricing is shown in pesos');
  await page.locator('#buyEmail').fill('me@example.com');
  await Promise.all([page.waitForURL('**/fake-checkout'), page.locator('.plan[data-plan=business] [data-buy]').click()]);
  assert(state.checkout.plan === 'business' && state.checkout.period === 'annual' && state.checkout.email === 'me@example.com', 'checkout is requested for the chosen plan and period');
  await page.waitForURL(u => u.hash === '#plans' || u.hash === '', { timeout: 10000 });
  await page.locator('#okDlg').waitFor({ state: 'visible', timeout: 15000 });
  assert((await page.locator('#okTitle').textContent()).includes('Business'), 'returning from checkout activates the license (after waiting for confirmation)');
  assert(!(await plansOpen()), 'the Plans pop-up closes when the license arrives');
  await page.locator('#okDone').click();
  assert((await page.locator('#planChip').textContent()) === 'Business', 'the plan badge updates');
  assert(await page.locator('#ad-slot').isHidden(), 'paid plans see no ads');

  // Paid: premium options and the publishing kit work.
  await page.locator('#steps button[data-i="6"]').click();
  await page.locator('.row:has([data-k=sign])').click();
  assert(await page.locator('[data-k=sign]').isChecked(), 'signing can be turned on with a paid plan');
  assert(await page.locator('#kitBody').isVisible(), 'the publishing kit is unlocked on Business');
  await page.locator('[data-k=shortDesc]').fill('The fastest way to shop local deals');
  await page.locator('[data-k=fullDesc]').fill('Shop App helps you find deals near you. '.repeat(4));
  await page.locator('[data-k=devEmail]').fill('support@shop.test');
  await page.locator('[data-k=cat]').selectOption('Shopping');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#kitZip').click()]);
  const zip = await readFile(await download.path());
  assert(zip.readUInt32LE(0) === 0x04034b50 && zip.includes(Buffer.from('privacy-policy.html')) && zip.includes(Buffer.from('store/feature-graphic-1024x500.png')), 'the publishing kit downloads as a ZIP with the policy and graphics');
  await page.locator('#buildBtn').click();
  await page.waitForTimeout(6500);
  const last = state.builds.at(-1);
  assert(last && last.licenseKey && last.signing === true, 'builds send the license key');

  // License survives a reload and shows in Settings.
  await page.reload();
  await page.waitForTimeout(400);
  assert((await page.locator('#planChip').textContent()) === 'Business', 'the license persists after reload');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert((await page.locator('#licStatus').textContent()).includes('Business'), 'Settings shows the active plan');

  if (errors.length) throw new Error('Browser errors:\n' + errors.join('\n'));
  results.push('PASS: no browser errors');
  console.log(results.join('\n'));
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
