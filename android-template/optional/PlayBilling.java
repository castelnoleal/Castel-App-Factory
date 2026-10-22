package com.castel.generatedapp;

import android.util.Log;
import android.webkit.JavascriptInterface;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.Closeable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Google Play Billing bridge, exposed to the page as window.CastelBilling.
 * Only added to apps built with the playBilling option (MainActivity loads it by reflection).
 *
 * Every method takes a callback name last; the app calls window[callback](jsonString) once.
 *   available()                                   -> boolean (synchronous)
 *   products(idsJson, cb)                         -> {products:[{productId,name,description,offers:[{basePlanId,offerId,offerToken,phases:[{price,priceMicros,currency,period,cycles}]}]}]}
 *   purchase(productId, offerToken, accountId, cb)-> {purchases:[...]} | {cancelled:true} | {error}
 *   restore(cb)                                   -> {purchases:[...]}
 *   acknowledge(purchaseToken, cb)                -> {ok:true} | {error}
 * Purchases: {productId, purchaseToken, orderId, packageName, state:"purchased"|"pending"|"unknown", acknowledged, autoRenewing}
 *
 * Purchases must still be verified and acknowledged by your server (the instApped build
 * service does this at /license/play); Google refunds purchases left unacknowledged for 3 days.
 */
public class PlayBilling implements PurchasesUpdatedListener, Closeable {
    private static final String TAG = "CastelAppFactory";
    private final MainActivity activity;
    private final BillingClient client;
    private final Map<String, ProductDetails> details = new ConcurrentHashMap<>();
    private final List<Runnable> waiting = new ArrayList<>();
    private volatile String purchaseCallback;
    private boolean connecting;

    public PlayBilling(MainActivity activity) {
        this.activity = activity;
        this.client = BillingClient.newBuilder(activity)
                .setListener(this)
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableAutoServiceReconnection()
                .build();
        connect();
    }

    private void connect() {
        synchronized (waiting) {
            if (connecting || client.isReady()) return;
            connecting = true;
        }
        client.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(BillingResult result) {
                List<Runnable> run;
                synchronized (waiting) { connecting = false; run = new ArrayList<>(waiting); waiting.clear(); }
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    Log.w(TAG, "Play Billing setup failed: " + result.getDebugMessage());
                }
                for (Runnable r : run) r.run();
            }
            @Override public void onBillingServiceDisconnected() {
                synchronized (waiting) { connecting = false; }
            }
        });
    }

    /** Runs the task once the billing service is connected (or after setup fails, so callers can report it). */
    private void whenReady(Runnable task) {
        if (client.isReady()) { task.run(); return; }
        synchronized (waiting) { waiting.add(task); }
        connect();
    }

    private void reply(String callback, JSONObject json) {
        activity.billingReply(callback, json.toString());
    }

    private void fail(String callback, String message) {
        try { reply(callback, new JSONObject().put("error", message)); } catch (JSONException ignored) { }
    }

    private String describe(BillingResult r) {
        switch (r.getResponseCode()) {
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE: return "Google Play Billing isn't available on this device or account.";
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE:
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
            case BillingClient.BillingResponseCode.NETWORK_ERROR: return "Couldn't reach Google Play. Check your connection and try again.";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE: return "This plan isn't available in your country yet.";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED: return "You already have this plan. Use Restore purchases.";
            case BillingClient.BillingResponseCode.DEVELOPER_ERROR: return "This app's Google Play setup isn't complete (" + r.getDebugMessage() + ").";
            default: return "Google Play error " + r.getResponseCode() + (r.getDebugMessage().isEmpty() ? "" : ": " + r.getDebugMessage());
        }
    }

    @JavascriptInterface public boolean available() { return true; }

    @JavascriptInterface public void products(String idsJson, String callback) {
        activity.billingGuard(callback, () -> {
            List<QueryProductDetailsParams.Product> list = new ArrayList<>();
            try {
                JSONArray ids = new JSONArray(idsJson == null ? "[]" : idsJson);
                for (int i = 0; i < ids.length() && i < 20; i++) {
                    list.add(QueryProductDetailsParams.Product.newBuilder().setProductId(ids.getString(i)).setProductType(BillingClient.ProductType.SUBS).build());
                }
            } catch (JSONException e) { fail(callback, "Invalid product list."); return; }
            if (list.isEmpty()) { fail(callback, "No products requested."); return; }
            whenReady(() -> client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(list).build(), (result, found) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { fail(callback, describe(result)); return; }
                try {
                    JSONArray out = new JSONArray();
                    for (ProductDetails pd : found.getProductDetailsList()) {
                        details.put(pd.getProductId(), pd);
                        JSONArray offers = new JSONArray();
                        List<ProductDetails.SubscriptionOfferDetails> subs = pd.getSubscriptionOfferDetails();
                        if (subs != null) for (ProductDetails.SubscriptionOfferDetails o : subs) {
                            JSONArray phases = new JSONArray();
                            for (ProductDetails.PricingPhase ph : o.getPricingPhases().getPricingPhaseList()) {
                                phases.put(new JSONObject().put("price", ph.getFormattedPrice()).put("priceMicros", ph.getPriceAmountMicros())
                                        .put("currency", ph.getPriceCurrencyCode()).put("period", ph.getBillingPeriod()).put("cycles", ph.getBillingCycleCount()));
                            }
                            offers.put(new JSONObject().put("basePlanId", o.getBasePlanId()).put("offerId", o.getOfferId() == null ? JSONObject.NULL : o.getOfferId())
                                    .put("offerToken", o.getOfferToken()).put("phases", phases));
                        }
                        out.put(new JSONObject().put("productId", pd.getProductId()).put("name", pd.getName()).put("description", pd.getDescription()).put("offers", offers));
                    }
                    reply(callback, new JSONObject().put("products", out));
                } catch (JSONException e) { fail(callback, "Couldn't read the Google Play plans."); }
            }));
        });
    }

    @JavascriptInterface public void purchase(String productId, String offerToken, String accountId, String callback) {
        activity.billingGuard(callback, () -> {
            ProductDetails pd = details.get(productId == null ? "" : productId);
            if (pd == null) { fail(callback, "Load the plans before buying."); return; }
            if (purchaseCallback != null) { fail(callback, "A purchase is already in progress."); return; }
            BillingFlowParams.ProductDetailsParams item = BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(pd).setOfferToken(offerToken == null ? "" : offerToken).build();
            BillingFlowParams.Builder flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(Collections.singletonList(item));
            if (accountId != null && !accountId.isEmpty() && accountId.length() <= 64) flow.setObfuscatedAccountId(accountId);
            whenReady(() -> {
                purchaseCallback = callback;
                BillingResult r = client.launchBillingFlow(activity, flow.build());
                if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    purchaseCallback = null;
                    fail(callback, describe(r));
                }
            });
        });
    }

    @Override public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        String callback = purchaseCallback;
        purchaseCallback = null;
        if (callback == null) return; // Pending purchases completing later are picked up by restore().
        try {
            int code = result.getResponseCode();
            if (code == BillingClient.BillingResponseCode.USER_CANCELED) { reply(callback, new JSONObject().put("cancelled", true)); return; }
            if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) { queryOwned(callback); return; }
            if (code != BillingClient.BillingResponseCode.OK) { fail(callback, describe(result)); return; }
            reply(callback, new JSONObject().put("purchases", toJson(purchases)));
        } catch (JSONException e) { fail(callback, "Couldn't read the purchase."); }
    }

    @JavascriptInterface public void restore(String callback) {
        activity.billingGuard(callback, () -> whenReady(() -> queryOwned(callback)));
    }

    private void queryOwned(String callback) {
        client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(), (result, purchases) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) { fail(callback, describe(result)); return; }
            try { reply(callback, new JSONObject().put("purchases", toJson(purchases))); }
            catch (JSONException e) { fail(callback, "Couldn't read your purchases."); }
        });
    }

    @JavascriptInterface public void acknowledge(String purchaseToken, String callback) {
        activity.billingGuard(callback, () -> whenReady(() -> client.acknowledgePurchase(
                AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken == null ? "" : purchaseToken).build(), r -> {
                    if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                        try { reply(callback, new JSONObject().put("ok", true)); } catch (JSONException ignored) { }
                    } else fail(callback, describe(r));
                })));
    }

    private JSONArray toJson(List<Purchase> purchases) throws JSONException {
        JSONArray out = new JSONArray();
        if (purchases == null) return out;
        for (Purchase p : purchases) {
            String state = p.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "purchased"
                    : p.getPurchaseState() == Purchase.PurchaseState.PENDING ? "pending" : "unknown";
            for (String id : p.getProducts()) {
                out.put(new JSONObject().put("productId", id).put("purchaseToken", p.getPurchaseToken())
                        .put("orderId", p.getOrderId() == null ? "" : p.getOrderId()).put("packageName", p.getPackageName())
                        .put("state", state).put("acknowledged", p.isAcknowledged()).put("autoRenewing", p.isAutoRenewing()));
            }
        }
        return out;
    }

    @Override public void close() {
        try { client.endConnection(); } catch (Exception ignored) { }
    }
}
