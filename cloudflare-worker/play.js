// Google Play Billing verification for the Play edition of instApped.
// The Android app buys a subscription with Google Play Billing; this module
// checks the purchase token with the Google Play Developer API (service
// account), acknowledges it, and issues the same license key the website uses.
//
// Secrets / variables:
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  service account key JSON with access to the app in Play Console
//   PLAY_PACKAGES   allowed package names, comma separated (default "com.instapped.app")
//   PLAY_PRODUCTS   JSON map of subscription product IDs to plans
//                   (default {"instapped_pro":"pro","instapped_business":"business"})

import { issueLicense } from "./billing.js";

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const GRACE_MS = 86400000;
let tokenCache = null; // { token, exp, email }

export function playProducts(env) {
  try {
    const m = env.PLAY_PRODUCTS ? JSON.parse(env.PLAY_PRODUCTS) : null;
    if (m && typeof m === "object") return m;
  } catch {}
  return { instapped_pro: "pro", instapped_business: "business" };
}

export function playPackages(env) {
  return String(env.PLAY_PACKAGES || "com.instapped.app").split(",").map((s) => s.trim()).filter(Boolean);
}

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlText = (t) => b64url(new TextEncoder().encode(t));

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function accessToken(env) {
  let sa;
  try { sa = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || ""); } catch { throw Object.assign(new Error("Google Play isn't connected to the build service yet."), { status: 503 }); }
  if (!sa.client_email || !sa.private_key) throw Object.assign(new Error("The Google Play service account key is incomplete."), { status: 503 });
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp > now + 60) return tokenCache.token;
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`)));
  const r = await fetch(sa.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + `${head}.${claims}.${b64url(sig)}`,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw Object.assign(new Error("Google sign-in for the Play API failed" + (d.error ? `: ${d.error}` : ".")), { status: 502 });
  tokenCache = { token: d.access_token, exp: now + Number(d.expires_in || 3600), email: sa.client_email };
  return d.access_token;
}

export function resetPlayTokenCache() { tokenCache = null; }

const VALID_STATES = new Set(["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_CANCELED"]);

/** Verify a Play subscription purchase and issue a license key for it. */
export async function claimPlayPurchase(env, { packageName, productId, purchaseToken }) {
  if (!env.LICENSE_SECRET) throw Object.assign(new Error("Licensing isn't configured on the build service."), { status: 503 });
  const pkg = String(packageName || "");
  if (!playPackages(env).includes(pkg)) throw Object.assign(new Error("This app isn't allowed to sell instApped plans."), { status: 403 });
  const plans = playProducts(env);
  const token = String(purchaseToken || "");
  if (!/^[A-Za-z0-9._\-:]{20,600}$/.test(token)) throw Object.assign(new Error("That purchase token isn't valid."), { status: 400 });
  const auth = { Authorization: "Bearer " + (await accessToken(env)) };
  const r = await fetch(`${API}/${encodeURIComponent(pkg)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`, { headers: auth });
  const sub = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("Google Play couldn't confirm this purchase" + (sub?.error?.message ? `: ${sub.error.message}` : ".")), { status: r.status === 404 || r.status === 400 ? 400 : 502 });
  const items = Array.isArray(sub.lineItems) ? sub.lineItems : [];
  const item = items.find((li) => plans[li.productId]) || null;
  const plan = item ? plans[item.productId] : null;
  if (!plan || (productId && item.productId !== productId)) throw Object.assign(new Error("That purchase isn't an instApped plan."), { status: 400 });
  const expiry = Date.parse(item.expiryTime || "");
  if (!VALID_STATES.has(sub.subscriptionState) || !(expiry > Date.now())) {
    return { ok: false, inactive: true, error: "This subscription isn't active. Renew it in Google Play.", state: sub.subscriptionState || "" };
  }
  // Google refunds purchases that aren't acknowledged within three days.
  if (sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
    try {
      await fetch(`${API}/${encodeURIComponent(pkg)}/purchases/subscriptions/${encodeURIComponent(item.productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}",
      });
    } catch {}
  }
  const ref = "play:" + String(sub.latestOrderId || token.slice(0, 24));
  const key = await issueLicense(env.LICENSE_SECRET, { plan, exp: expiry + GRACE_MS, ref });
  if (env.LICENSES) { try { await env.LICENSES.put("play:" + token.slice(0, 120), JSON.stringify({ ref, plan, expiry })); } catch {} }
  return { ok: true, key, plan, exp: expiry + GRACE_MS, reference: sub.latestOrderId || "" };
}
