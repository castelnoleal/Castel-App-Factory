// Owner-only "master" edition of the factory, served at /master by the build
// service. Sign-in uses the owner token (CASTEL_SIGNING_ACCESS_TOKEN) and sets
// an HttpOnly session cookie, so the token never lives in the page. The page
// is the factory from the main branch, fetched live (cached briefly), so the
// master edition always mirrors the public site.

import { safeEqual, issueLicense, PLAN_INFO } from "./billing.js";

const COOKIE = "ia_owner";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

function sessionSecret(env) {
  return env.OWNER_SESSION_SECRET || env.LICENSE_SECRET || env.CASTEL_SIGNING_ACCESS_TOKEN || "";
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createSession(env, now = Date.now()) {
  const exp = now + SESSION_DAYS * 86400000;
  return `v1.${exp}.${await sign(sessionSecret(env), "owner." + exp)}`;
}

export function readCookie(request, name = COOKIE) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

/** True when the request carries a valid, unexpired owner session cookie. */
export async function isOwnerSession(env, request, now = Date.now()) {
  const secret = sessionSecret(env);
  if (!secret || !env.CASTEL_SIGNING_ACCESS_TOKEN) return false;
  const [v, exp, sig] = readCookie(request).split(".");
  if (v !== "v1" || !(Number(exp) > now) || !sig) return false;
  return safeEqual(sig, await sign(secret, "owner." + exp));
}

/** Owner by session cookie or by the owner token in a header/body field. */
export async function isOwner(env, request, token) {
  if (token && env.CASTEL_SIGNING_ACCESS_TOKEN && safeEqual(token, env.CASTEL_SIGNING_ACCESS_TOKEN)) return true;
  return isOwnerSession(env, request);
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

const pageHeaders = (extra = {}) => ({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  ...extra,
});

function loginPage(message = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>instApped master — sign in</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b101d;color:#e8ebf3;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:20px}form{width:min(380px,100%);background:#141b2d;border:1px solid #263050;border-radius:16px;padding:24px;display:grid;gap:12px}h1{font-size:19px;margin:0;display:flex;gap:10px;align-items:center}.logo{width:34px;height:34px;border-radius:9px;background:#e0b050;display:grid;place-items:center;font-size:20px}p{margin:0;color:#94a0b8;font-size:13.5px}input{padding:12px;border-radius:10px;border:1px solid #263050;background:#0b101d;color:inherit;font:inherit}button{padding:12px;border-radius:10px;border:0;background:#e0b050;color:#1a1405;font:inherit;font-weight:700;cursor:pointer}.err{color:#ff8a80}</style></head>
<body><form method="post" action="/master/login"><h1><span class="logo">📦</span>instApped master</h1><p>Owner access only. Sign in with your owner access token.</p>
${message ? `<p class="err" role="alert">${message}</p>` : ""}
<input type="password" name="token" autocomplete="current-password" placeholder="Owner access token" required autofocus aria-label="Owner access token">
<button type="submit">Sign in</button></form></body></html>`;
}

let cachedPage = null; // { html, at }

async function factoryHtml(env, fetchFactory) {
  if (cachedPage && Date.now() - cachedPage.at < 60000) return cachedPage.html;
  const html = await fetchFactory();
  cachedPage = { html, at: Date.now() };
  return html;
}

export function resetMasterCache() { cachedPage = null; }

function injectEdition(html) {
  const tag = `<script>window.INSTAPPED_EDITION={edition:"master"};</script>`;
  const out = html.includes("<head>") ? html.replace("<head>", "<head>\n" + tag) : tag + html;
  return out.replace(/<title>[^<]*<\/title>/, "<title>instApped master</title>")
    .replace('<meta name="theme-color" content="#101a2e">', '<meta name="theme-color" content="#101a2e">\n<meta name="robots" content="noindex,nofollow">');
}

async function loginAllowed(env, ip) {
  if (!env.LICENSES) return true;
  const k = `login:${ip}`;
  try {
    const n = Number((await env.LICENSES.get(k)) || 0);
    if (n >= 8) return false;
    await env.LICENSES.put(k, String(n + 1), { expirationTtl: 900 });
  } catch {}
  return true;
}

/**
 * Handle /master routes. Returns a Response, or null when the path isn't one of ours.
 * fetchFactory() must return the factory HTML from the main branch.
 */
export async function handleMaster(request, env, fetchFactory) {
  const u = new URL(request.url);
  if (!u.pathname.startsWith("/master")) return null;
  if (!env.CASTEL_SIGNING_ACCESS_TOKEN) return new Response(loginPage("The owner token isn't configured on the build service."), { status: 503, headers: pageHeaders() });

  if (u.pathname === "/master/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await loginAllowed(env, ip))) return new Response(loginPage("Too many attempts. Wait 15 minutes and try again."), { status: 429, headers: pageHeaders() });
    const form = await request.formData().catch(() => null);
    const token = String(form?.get("token") || "");
    if (!safeEqual(token, env.CASTEL_SIGNING_ACCESS_TOKEN)) {
      await new Promise((r) => setTimeout(r, 600));
      return new Response(loginPage("That token isn't right."), { status: 401, headers: pageHeaders() });
    }
    return new Response(null, { status: 303, headers: { Location: "/master", "Set-Cookie": cookieHeader(await createSession(env), SESSION_DAYS * 86400), "Cache-Control": "no-store" } });
  }
  if (u.pathname === "/master/logout") {
    return new Response(null, { status: 303, headers: { Location: "/master", "Set-Cookie": cookieHeader("", 0), "Cache-Control": "no-store" } });
  }
  if ((u.pathname === "/master" || u.pathname === "/master/") && request.method === "GET") {
    if (!(await isOwnerSession(env, request))) return new Response(loginPage(), { status: 401, headers: pageHeaders() });
    try {
      const html = injectEdition(await factoryHtml(env, fetchFactory));
      return new Response(html, { status: 200, headers: pageHeaders() });
    } catch (e) {
      return new Response(loginPage("Couldn't load the factory from GitHub: " + String(e.message || e).slice(0, 160)), { status: 502, headers: pageHeaders() });
    }
  }
  return new Response("Not found", { status: 404, headers: pageHeaders() });
}

// ------------------------------------------------------------- owner tools

export function configStatus(env) {
  return {
    github: Boolean(env.GITHUB_TOKEN),
    ownerToken: Boolean(env.CASTEL_SIGNING_ACCESS_TOKEN),
    licenseSecret: Boolean(env.LICENSE_SECRET),
    paymongo: Boolean(env.PAYMONGO_SECRET_KEY),
    paymongoMode: env.PAYMONGO_SECRET_KEY ? (String(env.PAYMONGO_SECRET_KEY).startsWith("sk_live_") ? "live" : "test") : "",
    paymongoWebhook: Boolean(env.PAYMONGO_WEBHOOK_SECRET),
    licenseStore: Boolean(env.LICENSES),
    googlePlay: Boolean(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON),
    playPackages: String(env.PLAY_PACKAGES || "com.instapped.app"),
  };
}

/** Issue a complimentary license (for clients, partners or testing). */
export async function adminIssue(env, { plan, days, note }) {
  if (!env.LICENSE_SECRET) throw Object.assign(new Error("Set LICENSE_SECRET first."), { status: 503 });
  if (!["pro", "business"].includes(plan)) throw Object.assign(new Error("Choose Pro or Business."), { status: 400 });
  const d = Math.round(Number(days));
  if (!(d >= 1 && d <= 3660)) throw Object.assign(new Error("Days must be between 1 and 3660."), { status: 400 });
  const rand = new Uint8Array(6);
  crypto.getRandomValues(rand);
  const ref = "comp:" + Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  const exp = Date.now() + d * 86400000;
  const key = await issueLicense(env.LICENSE_SECRET, { plan, exp, ref });
  if (env.LICENSES) {
    try { await env.LICENSES.put("issued:" + ref, JSON.stringify({ plan, exp, note: String(note || "").slice(0, 200), at: Date.now() })); } catch {}
  }
  return { key, plan, exp, ref, name: PLAN_INFO[plan].name };
}

export async function adminRevoke(env, { ref }) {
  const r = String(ref || "").trim();
  if (!r) throw Object.assign(new Error("Enter the license reference to revoke."), { status: 400 });
  if (!env.LICENSES) throw Object.assign(new Error("Revoking needs the LICENSES KV namespace (see wrangler.toml)."), { status: 503 });
  await env.LICENSES.put("revoked:" + r, String(Date.now()));
  return { revoked: r };
}

function decodeKeyPayload(key) {
  try {
    const part = String(key || "").split(".")[1] || "";
    const raw = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
  } catch { return null; }
}

/** Licenses on record: website sales, Google Play sales, complimentary keys, and revoked references. */
export async function listLicenses(env) {
  if (!env.LICENSES) return { available: false, sales: [], play: [], complimentary: [], revoked: [] };
  const read = async (prefix, limit = 60) => {
    const out = [];
    try {
      const l = await env.LICENSES.list({ prefix, limit });
      for (const k of l.keys || []) out.push({ key: k.name.slice(prefix.length), value: await env.LICENSES.get(k.name) });
    } catch {}
    return out;
  };
  const revokedRows = await read("revoked:", 200);
  const revokedSet = new Set(revokedRows.map((r) => r.key));
  const sales = (await read("session:")).map(({ key, value }) => { const p = decodeKeyPayload(value) || {}; return { source: "website", ref: p.ref || key, plan: p.plan || "", exp: p.exp || 0, revoked: revokedSet.has(p.ref || key) }; });
  const play = (await read("play:")).map(({ value }) => { let p = {}; try { p = JSON.parse(value); } catch {} return { source: "google-play", ref: p.ref || "", plan: p.plan || "", exp: (p.expiry || 0) + 86400000, revoked: revokedSet.has(p.ref || "") }; });
  const complimentary = (await read("issued:")).map(({ key, value }) => { let p = {}; try { p = JSON.parse(value); } catch {} return { source: "complimentary", ref: key, plan: p.plan || "", exp: p.exp || 0, note: p.note || "", issuedAt: p.at || 0, revoked: revokedSet.has(key) }; });
  const revoked = revokedRows.map(({ key, value }) => ({ ref: key, at: Number(value) || 0 }));
  const byExp = (a, b) => (b.exp || 0) - (a.exp || 0);
  return { available: true, sales: sales.sort(byExp), play: play.sort(byExp), complimentary: complimentary.sort(byExp), revoked };
}
