package com.castel.generatedapp;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.TextView;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.Nullable;
import androidx.webkit.WebResourceErrorCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

public class MainActivity extends ComponentActivity {
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private ValueCallback<Uri[]> fileChooserCallback;
    private final ExecutorService dataExecutor = Executors.newSingleThreadExecutor();
    private File offlineDataDir;
    private static final boolean OFFLINE_STORAGE = false;
    private static final int CACHE_MODE = WebSettings.LOAD_DEFAULT;

    private static final boolean ALLOW_EXTERNAL_LINKS = false;
    private static final boolean ENABLE_ZOOM = false;
    private static final boolean FULLSCREEN = false;
    private static final boolean BACK_NAVIGATION = true;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        window.setStatusBarColor(0xFF080B14);
        window.setNavigationBarColor(Color.BLACK);
        try {
            initializeWebView(window);
        } catch (Throwable fatal) {
            showLaunchError(fatal);
        }
    }

    private void initializeWebView(Window window) {
        webView = new WebView(this);
        setContentView(webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(ENABLE_ZOOM);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(ENABLE_ZOOM);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(CACHE_MODE);
        offlineDataDir = new File(getFilesDir(), "offline-data");
        if (OFFLINE_STORAGE) offlineDataDir.mkdirs();
        webView.addJavascriptInterface(new OfflineStorageBridge(), "CastelApp");

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/data/", path -> {
                    if (!OFFLINE_STORAGE) return null;
                    try {
                        String safe = path.replace('\\', '/');
                        if (safe.contains("..") || safe.startsWith("/")) return null;
                        File f = new File(offlineDataDir, safe);
                        if (!f.isFile()) return null;
                        return new WebResourceResponse("application/octet-stream", null, new FileInputStream(f));
                    } catch (Exception ignored) { return null; }
                })
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return assetLoader.shouldInterceptRequest(Uri.parse(url));
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i("CastelAppFactory", "PAGE_LOADED:" + url);
            }
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceErrorCompat error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) Log.e("CastelAppFactory", "PAGE_ERROR:" + request.getUrl() + ":" + error.getErrorCode());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, 1001);
                    return true;
                } catch (Exception e) {
                    fileChooserCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
        });

        if (FULLSCREEN) {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }

        if (BACK_NAVIGATION) {
            getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                }
            });
        }

        webView.post(() -> webView.loadUrl("__TARGET_URL__"));
    }

    private class OfflineStorageBridge {
        @JavascriptInterface public boolean enabled() { return OFFLINE_STORAGE; }
        @JavascriptInterface public boolean hasData(String key) { return OFFLINE_STORAGE && fileForKey(key).isFile(); }
        @JavascriptInterface public String dataUrl(String key) {
            return hasData(key) ? "https://appassets.androidplatform.net/data/" + safeKey(key) : "";
        }
        @JavascriptInterface public String metadata(String key) {
            File f = fileForKey(key);
            return f.isFile() ? Long.toString(f.lastModified()) + ":" + Long.toString(f.length()) : "";
        }
        @JavascriptInterface public void deleteData(String key) { if (OFFLINE_STORAGE) fileForKey(key).delete(); }
        @JavascriptInterface public void downloadData(String url, String key, String callback) {
            if (!OFFLINE_STORAGE) { callJs(callback, false, "Offline storage is disabled"); return; }
            dataExecutor.execute(() -> {
                try {
                    if (!url.matches("https?://.+")) throw new IllegalArgumentException("Only HTTP/HTTPS downloads are supported");
                    File target = fileForKey(key);
                    File temp = new File(offlineDataDir, "." + safeKey(key) + ".download");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setInstanceFollowRedirects(true);
                    int code = c.getResponseCode();
                    if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
                    try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(temp)) {
                        byte[] buf = new byte[8192]; int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    } finally { c.disconnect(); }
                    if (!temp.renameTo(target)) { temp.delete(); throw new IllegalStateException("Could not save downloaded data"); }
                    callJs(callback, true, "");
                } catch (Exception e) { callJs(callback, false, e.getMessage() == null ? "Download failed" : e.getMessage()); }
            });
        }
    }

    private File fileForKey(String key) { return new File(offlineDataDir, safeKey(key)); }
    private String safeKey(String key) {
        String k = key == null ? "" : key.replaceAll("[^A-Za-z0-9._-]", "_");
        return k.isEmpty() ? "data" : k;
    }
    private void callJs(String callback, boolean ok, String error) {
        if (webView == null || callback == null || !callback.matches("[A-Za-z_$][A-Za-z0-9_$.]*")) return;
        String safe = error == null ? "" : error.replace("\\", "\\\\").replace("\"", "\\\"");
        String js = callback + "(" + ok + ",\"" + safe + "\")";
        runOnUiThread(() -> { if (webView != null) webView.evaluateJavascript(js, null); });
    }

    private void showLaunchError(Throwable error) {
        TextView message = new TextView(this);
        message.setTextColor(Color.WHITE);
        message.setTextSize(16);
        message.setBackgroundColor(Color.rgb(8, 11, 20));
        message.setPadding(40, 60, 40, 40);
        message.setText("The app could not start.\n\n" + error.getClass().getSimpleName() +
                (error.getMessage() == null ? "" : "\n" + error.getMessage()));
        setContentView(message);
    }

    private boolean handleNavigation(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        if (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) {
            if (ALLOW_EXTERNAL_LINKS) {
                String host = uri.getHost();
                Uri current = Uri.parse(webView.getUrl() == null ? "" : webView.getUrl());
                String currentHost = current.getHost();
                if (currentHost != null && host != null && host.equalsIgnoreCase(currentHost)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                } catch (Exception ignored) { return false; }
            }
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        } catch (Exception ignored) { return false; }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 1001 && fileChooserCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
        }
    }

    @Override
    protected void onDestroy() {
        dataExecutor.shutdownNow();
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
