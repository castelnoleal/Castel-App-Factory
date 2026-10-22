// Browser tests for the factory editions:
//   master       – the real build-service worker serves /master (owner sign-in, mirrored factory, owner tools)
//   play-lite    – Google Play app without purchases (no prices, no buy buttons, license key only)
//   play-billing – Google Play app with Play Billing (a fake CastelBilling bridge stands in for Google Play)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import worker from '../cloudflare-worker/worker.js';

const html = await readFile(resolve('factory/index.html'), 'utf8');
const results = [];
const assert = (ok, msg) => { if (!ok) throw new Error('FAIL: ' + msg); results.push('PASS: ' + msg); };
const OWNER = 'owner-browser-token';
const env = { GITHUB_TOKEN: 'gh', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', CASTEL_SIGNING_ACCESS_TOKEN: OWNER, LICENSE_SECRET: 'browser-test-secret' };
const kvStore = new Map();
env.LICENSES = { get: async k => kvStore.get(k) ?? null, put: async (k, v) => { kvStore.set(k, v); } };

// The worker's outbound calls (GitHub) are faked; the factory HTML comes "from main".
const realFetch = globalThis.fetch;
const builds = [];
globalThis.fetch = async (url, opt = {}) => {
  url = String(url);
  if (url.includes('/contents/factory/index.html')) return new Response(JSON.stringify({ content: Buffer.from(html).toString('base64') }), { status: 200 });
  if (url.startsWith('https://api.github.com')) {
    if (url.includes('/git/ref/heads/main')) return new Response(JSON.stringify({ object: { sha: 'abc' } }), { status: 200 });
    if (opt.method === 'PUT' && url.includes('/manifest.json')) builds.push(JSON.parse(Buffer.from(JSON.parse(opt.body).content, 'base64').toString()));
    return new Response('{}', { status: 201 });
  }
  return realFetch(url, opt);
};

// Node adapter: the real worker answers every request on this server.
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('http://localhost:4175' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(4175, '127.0.0.1', r));
const site = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise(r => site.listen(4176, '127.0.0.1', r));

const browser = await chromium.launch({ headless: true });
const errors = [];
const watch = (page, label) => {
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text()); });
};
const json = (route, d, status = 200) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(d) });
const PLANS = { ok: true, currency: 'PHP', paymentsEnabled: true, plans: [
  { id: 'free', name: 'Free', tagline: 'Build and test.', features: ['Test APKs'], prices: { monthly: 0, annual: 0 } },
  { id: 'pro', name: 'Pro', tagline: 'Publish on Google Play.', features: ['Signed AAB', 'No ads in the factory'], prices: { monthly: 49900, annual: 499000 } },
  { id: 'business', name: 'Business', tagline: 'For companies.', features: ['Publishing kit'], prices: { monthly: 169000, annual: 1690000 } } ] };
const lic = (plan, ref) => 'IAL1.' + Buffer.from(JSON.stringify({ v: 1, plan, exp: Date.now() + 30 * 86400000, ref })).toString('base64url') + '.sig';

try {
  // ------------------------------------------------------------------ master
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    watch(page, 'master');
    await page.goto('http://localhost:4175/master');
    assert(await page.locator('text=Owner access only').isVisible(), 'master shows the owner sign-in first');
    await page.fill('input[name=token]', 'wrong');
    await page.click('button[type=submit]');
    assert(await page.locator("text=That token isn't right").isVisible(), 'a wrong owner token is refused');
    await page.fill('input[name=token]', OWNER);
    await page.click('button[type=submit]');
    await page.waitForSelector('#planChip');
    await page.waitForTimeout(500);
    assert(await page.title() === 'instApped master', 'signing in opens the mirrored factory as instApped master');
    assert((await page.locator('#planChip').textContent()) === 'Master', 'plan chip says Master');
    assert(await page.locator('nav button[data-view=owner]').isVisible(), 'Owner tools are in the menu');
    assert(!(await page.locator('#ad-slot').isVisible()), 'no ads in the master edition');
    assert(!(await page.locator('#token').isVisible()), 'no owner token field needed');
    // Nothing is gated.
    await page.evaluate(() => { const el = document.querySelector('[data-k=sign]'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    assert(!(await page.locator('#upDlg').evaluate(d => d.open)), 'premium options work without a license');
    // Owner tools: status, issue, look up, revoke — against the real worker.
    await page.click('nav button[data-view=owner]');
    await page.waitForFunction(() => document.querySelectorAll('#oStat div').length > 3);
    assert((await page.locator('#oRev').textContent()).includes('instapped-editions-v1'), 'owner tools show the build service revision');
    assert((await page.locator('#oStat').textContent()).includes('License signing'), 'owner tools show configuration status');
    await page.selectOption('#oPlan', 'business');
    await page.fill('#oDays', '45');
    await page.fill('#oNote', 'Client A');
    await page.click('#oIssue');
    await page.waitForFunction(() => /^IAL1\./.test(document.querySelector('#oKey').textContent));
    const key = await page.locator('#oKey').textContent();
    assert((await page.locator('#oMeta').textContent()).includes('Business'), 'a complimentary Business key is issued');
    const verified = await (await realFetch('http://127.0.0.1:4175/license/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).json();
    assert(verified.valid && verified.plan === 'business', 'the issued key verifies on the build service');
    await page.fill('#oRef', key);
    await page.click('#oLook');
    assert(/Business · valid until .* reference comp:/.test(await page.locator('#oInfo').textContent()), 'looking up a key shows plan, expiry and reference');
    page.once('dialog', d => d.accept());
    await page.click('#oRevoke');
    await page.waitForFunction(() => /Revoked comp:/.test(document.querySelector('#oInfo').textContent));
    const after = await (await realFetch('http://127.0.0.1:4175/license/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })).json();
    assert(!after.valid, 'a revoked key stops working');
    // A build from the master edition goes out as the owner (Business, signed) with no token in the page.
    const fromPage = await page.evaluate(async () => {
      const r = await fetch('/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appName: 'Mine', packageName: 'com.me.mine', versionName: '1.0.0', versionCode: 1, sourceMode: 'website', sourceUrl: 'https://example.com', signing: true, playBilling: true }) });
      return { status: r.status, body: await r.json() };
    });
    assert(fromPage.status === 202 && fromPage.body.tier === 'business', 'master builds run as Business through the session cookie');
    assert(builds.at(-1)?.playBilling === true && builds.at(-1)?.signing === true, 'owner builds can use signing and Play Billing');
    // Sign out.
    await page.click('nav button[data-view=settings]');
    await page.click('#moOut');
    await page.waitForSelector('text=Owner access only');
    assert(true, 'sign out returns to the owner sign-in');
    const anon = await ctx.newPage();
    const r = await anon.goto('http://localhost:4175/master');
    assert(r.status() === 401, 'after signing out /master is locked again');
    await ctx.close();
  }

  // --------------------------------------------------------------- play-lite
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile instApped-Play/lite' });
    let checkoutCalls = 0;
    await ctx.route('https://api.instapped.com/**', route => {
      const url = route.request().url(), body = route.request().postData() ? JSON.parse(route.request().postData()) : {};
      if (url.endsWith('/plans')) return json(route, PLANS);
      if (url.endsWith('/checkout')) { checkoutCalls++; return json(route, { ok: false }); }
      if (url.endsWith('/license/verify')) { const p = JSON.parse(Buffer.from(String(body.key).split('.')[1], 'base64url').toString()); return json(route, { ok: true, valid: true, plan: p.plan, exp: p.exp }); }
      return json(route, { ok: true });
    });
    const page = await ctx.newPage();
    watch(page, 'lite');
    await page.goto('http://127.0.0.1:4176/');
    await page.waitForTimeout(400);
    await page.click('nav button[data-view=settings]');
    assert(!(await page.locator('#plansCard').isVisible()), 'play-lite has no Plans section in Settings');
    await page.click('nav button[data-view=create]');
    assert(!(await page.locator('#ad-slot').isVisible()), 'play-lite shows no Pro ad');
    const text = await page.evaluate(() => document.body.innerText);
    assert(!/₱|PayMongo|GCash|Subscribe|Get Pro|See plans/.test(text), 'play-lite shows no prices or buy links anywhere');
    await page.evaluate(() => { const el = document.querySelector('[data-k=upd]'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#upDlg').open);
    const dlg = await page.locator('#upDlg').innerText();
    assert(/license key in Settings/.test(dlg) && !/₱|month/.test(dlg), 'the upgrade prompt asks for a license key, with no price');
    await page.click('#upGo');
    assert(await page.locator('#v-settings').isVisible(), 'the prompt opens Settings');
    await page.evaluate(() => { location.hash = '#plans'; });
    await page.waitForTimeout(150);
    assert(!(await page.locator('#plansCard').isVisible()), 'the Plans section can\'t be opened by link');
    await page.fill('#licKey', lic('pro', 'IA-LITE'));
    await page.click('#licSave');
    await page.waitForFunction(() => document.querySelector('#planChip').textContent === 'Pro');
    assert(true, 'a license key bought elsewhere activates Pro in play-lite');
    assert(checkoutCalls === 0, 'play-lite never starts a checkout');
    await ctx.close();
  }

  // ------------------------------------------------------------ play-billing
  {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile instApped-Play/billing' });
    const claims = [];
    await ctx.route('https://api.instapped.com/**', route => {
      const url = route.request().url(), body = route.request().postData() ? JSON.parse(route.request().postData()) : {};
      if (url.endsWith('/plans')) return json(route, PLANS);
      if (url.endsWith('/checkout')) return json(route, { ok: false, error: 'should not be called' }, 500);
      if (url.endsWith('/license/play')) {
        claims.push(body);
        const plan = body.productId === 'instapped_business' ? 'business' : 'pro';
        return json(route, { ok: true, key: lic(plan, 'play:GPA.1'), plan, exp: Date.now() + 31 * 86400000, reference: 'GPA.1' });
      }
      if (url.endsWith('/license/verify')) return json(route, { ok: true, valid: true, plan: 'pro', exp: Date.now() + 31 * 86400000 });
      return json(route, { ok: true });
    });
    await ctx.addInitScript(() => {
      if (window.top !== window) return; // only the app page, not the sandboxed preview frame
      // Google Play remembers purchases across reinstalls; the fake keeps them in sessionStorage.
      const owned = JSON.parse(sessionStorage.getItem('fakePlayOwned') || '[]');
      const offer = (id, base, period, price) => ({ basePlanId: base, offerId: null, offerToken: id + ':' + base, phases: [{ price, priceMicros: 1, currency: 'PHP', period, cycles: 0 }] });
      const products = [
        { productId: 'instapped_pro', name: 'Pro', offers: [offer('instapped_pro', 'monthly', 'P1M', '₱499.00'), offer('instapped_pro', 'annual', 'P1Y', '₱4,990.00'),
          { basePlanId: 'monthly', offerId: 'trial', offerToken: 'trial', phases: [{ price: 'Free', priceMicros: 0, period: 'P7D' }, { price: '₱499.00', priceMicros: 1, period: 'P1M' }] }] },
        { productId: 'instapped_business', name: 'Business', offers: [offer('instapped_business', 'monthly', 'P1M', '₱1,690.00'), offer('instapped_business', 'annual', 'P1Y', '₱16,900.00')] },
      ];
      const reply = (cb, d) => setTimeout(() => window[cb] && window[cb](JSON.stringify(d)), 30);
      window.__gbLog = [];
      window.CastelApp = { appInfo: () => JSON.stringify({ packageName: 'com.instapped.app' }), openExternal: u => window.__gbLog.push('open ' + u) };
      window.CastelBilling = {
        available: () => true,
        products: (ids, cb) => { window.__gbLog.push('products ' + ids); reply(cb, { products }); },
        purchase: (pid, token, acct, cb) => { window.__gbLog.push('purchase ' + pid + ' ' + token); const p = { productId: pid, purchaseToken: 'tok_' + pid + '_xxxxxxxxxxxxxxxxxxxx', packageName: 'com.instapped.app', state: 'purchased' }; owned.push(p); sessionStorage.setItem('fakePlayOwned', JSON.stringify(owned)); reply(cb, { purchases: [p] }); },
        restore: cb => { window.__gbLog.push('restore'); reply(cb, { purchases: owned }); },
        acknowledge: (t, cb) => reply(cb, { ok: true }),
      };
    });
    const page = await ctx.newPage();
    watch(page, 'billing');
    await page.goto('http://127.0.0.1:4176/');
    await page.waitForTimeout(400);
    await page.click('#planChip');
    await page.waitForFunction(() => /₱499\.00/.test(document.querySelector('#planCards').textContent));
    const plansText = await page.locator('#plansCard').innerText();
    assert(!/PayMongo|GCash|Already paid|IA-…/.test(plansText), 'play-billing hides PayMongo checkout and recovery');
    assert(/Google Play/.test(plansText), 'play-billing explains Google Play billing and renewals');
    assert(/₱1,690\.00/.test(plansText), 'prices come from Google Play product details');
    await page.click('#billSeg button[data-v=annual]');
    assert(/₱4,990\.00/.test(await page.locator('#planCards').innerText()), 'yearly base plans are shown when Yearly is chosen');
    await page.click('#billSeg button[data-v=monthly]');
    await page.click('#planCards [data-gbuy=pro]');
    await page.waitForFunction(() => document.querySelector('#okDlg').open);
    assert(claims.length === 1 && claims[0].productId === 'instapped_pro' && claims[0].packageName === 'com.instapped.app' && /^tok_/.test(claims[0].purchaseToken), 'the Play purchase is verified with the build service');
    const log = await page.evaluate(() => window.__gbLog);
    assert(log.includes('purchase instapped_pro instapped_pro:monthly'), 'the monthly base plan (not the trial offer) is bought');
    await page.click('#okDone');
    assert((await page.locator('#planChip').textContent()) === 'Pro', 'buying in Google Play unlocks Pro');
    // Restore on a fresh device: clear the license and press Restore purchases.
    await page.evaluate(() => { localStorage.removeItem('instapped.license'); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#planChip').textContent === 'Pro', null, { timeout: 5000 });
    assert(true, 'a reinstall silently restores the plan from Google Play');
    await page.click('#planChip');
    await page.click('#gpRestore');
    await page.waitForTimeout(300);
    assert(claims.length >= 3, 'Restore purchases re-verifies the subscription');
    await page.click('#gpManage');
    assert((await page.evaluate(() => window.__gbLog)).some(l => l.startsWith('open https://play.google.com/store/account/subscriptions?package=com.instapped.app')), 'Manage subscriptions opens the Play Store');
    await ctx.close();
  }

  assert(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
} finally {
  await browser.close();
  server.close();
  site.close();
  globalThis.fetch = realFetch;
}
console.log(results.join('\n'));
console.log(`\n${results.length} edition checks passed.`);
