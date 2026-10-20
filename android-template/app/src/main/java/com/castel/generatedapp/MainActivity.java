package com.castel.generatedapp;

import android.content.Intent;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.widget.Toast;
import android.os.SystemClock;
import android.graphics.Color;
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
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.security.MessageDigest;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
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
    private long lastBackPressedAt = 0L;
    private static final boolean OFFLINE_STORAGE = false;
    private static final boolean AUTO_UPDATE = false;
    private static final int CACHE_MODE = WebSettings.LOAD_DEFAULT;

    private static final boolean ALLOW_EXTERNAL_LINKS = true;
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
                        return new WebResourceResponse(mimeType(safe), charsetFor(safe), new FileInputStream(f));
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

        // WebView does not download attachment responses by itself. Route APK/AAB
        // and other attachment downloads through Android's system DownloadManager
        // so they appear in Downloads and survive leaving this screen.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                Uri uri = Uri.parse(url);
                String scheme = uri.getScheme();
                if (scheme == null || !(scheme.equalsIgnoreCase("https") || scheme.equalsIgnoreCase("http"))) {
                    Toast.makeText(this, "This download link is not supported.", Toast.LENGTH_LONG).show();
                    return;
                }
                DownloadManager.Request request = new DownloadManager.Request(uri);
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                if (fileName == null || fileName.trim().isEmpty()) fileName = "download";
                fileName = fileName.replaceAll("[\\\\/:*?\\\"<>|]", "_");
                request.setTitle(fileName);
                request.setDescription("Downloading " + fileName);
                request.setMimeType(mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(true);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager == null) throw new IllegalStateException("Android download service is unavailable");
                manager.enqueue(request);
                Toast.makeText(this, "Download started. Check your notifications or Downloads folder.", Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                Log.e("CastelAppFactory", "DOWNLOAD_START_FAILED", e);
                Toast.makeText(this, "Could not start download. Please try again.", Toast.LENGTH_LONG).show();
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
                    WebView currentWebView = webView;
                    if (currentWebView != null && currentWebView.canGoBack()) {
                        currentWebView.goBack();
                        lastBackPressedAt = 0L;
                        return;
                    }

                    // Do not immediately close the app when there is no WebView
                    // history (common on the initial screen or in single-page apps).
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastBackPressedAt < 2000L) {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    } else {
                        lastBackPressedAt = now;
                        Toast.makeText(MainActivity.this,
                                "You're at the start. Press Back again to exit.",
                                Toast.LENGTH_SHORT).show();
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
        @JavascriptInterface public boolean autoUpdateEnabled() { return AUTO_UPDATE; }
        @JavascriptInterface public void downloadArtifact(String url, String fileName) {
            try {
                requireHttpUrl(url);
                Uri uri = Uri.parse(url);
                String safeName = fileName == null ? "download" : fileName.replaceAll("[\\\\/:*?\\\"<>|]", "_");
                if (safeName.trim().isEmpty()) safeName = "download";
                DownloadManager.Request request = new DownloadManager.Request(uri);
                request.setTitle(safeName);
                request.setDescription("Downloading " + safeName);
                request.setMimeType(safeName.toLowerCase().endsWith(".apk") ? "application/vnd.android.package-archive" : "application/octet-stream");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(true);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager == null) throw new IllegalStateException("Android download service is unavailable");
                manager.enqueue(request);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Download started. Check notifications or Downloads.", Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.e("CastelAppFactory", "ARTIFACT_DOWNLOAD_FAILED", e);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Could not start download. Please try again.", Toast.LENGTH_LONG).show());
            }
        }
        @JavascriptInterface public void deleteData(String key) { if (OFFLINE_STORAGE) deleteRecursively(fileForKey(key)); }
        @JavascriptInterface public void downloadData(String url, String key, String callback) {
            if (!OFFLINE_STORAGE) { callJs(callback, false, "Offline storage is disabled"); return; }
            dataExecutor.execute(() -> {
                try {
                    requireHttpUrl(url);
                    File target = fileForKey(key);
                    File temp = new File(offlineDataDir, "." + safeKey(key) + ".download");
                    downloadTo(url, temp);
                    replaceFileAtomically(temp, target);
                    callJs(callback, true, "");
                } catch (Exception e) { callJs(callback, false, e.getMessage() == null ? "Download failed" : e.getMessage()); }
            });
        }
        @JavascriptInterface public void downloadBundle(String url, String key, String sha256, String callback) {
            if (!OFFLINE_STORAGE) { callJs(callback, false, "Offline storage is disabled"); return; }
            dataExecutor.execute(() -> {
                try {
                    requireHttpUrl(url);
                    String safe = safeKey(key);
                    File bundleRoot = fileForKey(safe);
                    File zipTemp = new File(offlineDataDir, "." + safe + ".bundle.zip.download");
                    File staging = new File(offlineDataDir, "." + safe + ".bundle.staging");
                    deleteRecursively(staging);
                    downloadTo(url, zipTemp);
                    if (sha256 != null && !sha256.trim().isEmpty() && !sha256.matches("(?i)[0-9a-f]{64}")) throw new IllegalArgumentException("SHA-256 must be 64 hexadecimal characters");
                    if (sha256 != null && !sha256.trim().isEmpty() && !sha256.equalsIgnoreCase(sha256(zipTemp))) throw new IllegalStateException("Bundle integrity check failed");
                    extractBundle(zipTemp, staging);
                    File marker = new File(staging, ".castel-bundle");
                    try (FileOutputStream out = new FileOutputStream(marker)) { out.write(("updated=" + System.currentTimeMillis()).getBytes("UTF-8")); }
                    replaceDirectoryAtomically(staging, bundleRoot);
                    zipTemp.delete();
                    callJs(callback, true, "");
                } catch (Exception e) { callJs(callback, false, e.getMessage() == null ? "Bundle download failed" : e.getMessage()); }
            });
        }
        @JavascriptInterface public String bundleUrl(String key, String relativePath) {
            if (!OFFLINE_STORAGE) return "";
            String safe = safeKey(key);
            String path = relativePath == null ? "" : relativePath.replace("\\", "/");
            if (path.isEmpty() || path.startsWith("/") || path.contains("..")) return "";
            File f = new File(new File(offlineDataDir, safe), path);
            return f.isFile() ? "https://appassets.androidplatform.net/data/" + safe + "/" + path : "";
        }
    }

    private String mimeType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".txt") || p.endsWith(".csv")) return "text/plain";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".gif")) return "image/gif";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private String charsetFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm") || p.endsWith(".css") || p.endsWith(".js") ||
            p.endsWith(".json") || p.endsWith(".txt") || p.endsWith(".csv") || p.endsWith(".svg")) return "UTF-8";
        return null;
    }

    private File fileForKey(String key) { return new File(offlineDataDir, safeKey(key)); }

    private void requireHttpUrl(String url) {
        if (url == null || !url.matches("https?://.+")) throw new IllegalArgumentException("Only HTTP/HTTPS downloads are supported");
    }

    private void downloadTo(String url, File target) throws Exception {
        File parent = target.getParentFile();
        if (parent != null) parent.mkdirs();
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000); c.setReadTimeout(60000); c.setInstanceFollowRedirects(true);
        try {
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code);
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
                byte[] buf = new byte[16384]; int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                out.getFD().sync();
            }
        } finally { c.disconnect(); }
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[16384]; int n;
            while ((n = in.read(buf)) != -1) digest.update(buf, 0, n);
        }
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest()) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }

    private void extractBundle(File zipFile, File staging) throws Exception {
        if (!staging.mkdirs() && !staging.isDirectory()) throw new IllegalStateException("Could not create bundle staging directory");
        long total = 0; byte[] buf = new byte[16384];
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile)))) {
            ZipEntry entry;
            while ((entry = zin.getNextEntry()) != null) {
                String name = entry.getName().replace("\\", "/");
                if (name.isEmpty() || name.startsWith("/") || name.contains("..") || name.indexOf(0) >= 0) throw new IllegalArgumentException("Unsafe bundle entry");
                if (entry.isDirectory()) { new File(staging, name).mkdirs(); continue; }
                File out = new File(staging, name);
                File parent = out.getParentFile(); if (parent != null) parent.mkdirs();
                try (BufferedOutputStream stream = new BufferedOutputStream(new FileOutputStream(out))) {
                    int n; while ((n = zin.read(buf)) != -1) {
                        total += n;
                        if (total > 250L * 1024L * 1024L) throw new IllegalStateException("Bundle exceeds 250 MB");
                        stream.write(buf, 0, n);
                    }
                }
                zin.closeEntry();
            }
        }
    }

    private void replaceFileAtomically(File temp, File target) throws Exception {
        if (!temp.renameTo(target)) {
            if (!temp.isFile()) throw new IllegalStateException("Downloaded file is missing");
            File backup = new File(target.getParentFile(), "." + target.getName() + ".old");
            backup.delete();
            if (target.exists() && !target.renameTo(backup)) throw new IllegalStateException("Could not stage existing data");
            if (!temp.renameTo(target)) {
                if (backup.exists()) backup.renameTo(target);
                throw new IllegalStateException("Could not save downloaded data");
            }
            backup.delete();
        }
    }

    private void replaceDirectoryAtomically(File staging, File target) throws Exception {
        File backup = new File(target.getParentFile(), "." + target.getName() + ".old");
        deleteRecursively(backup);
        if (target.exists() && !target.renameTo(backup)) throw new IllegalStateException("Could not stage existing bundle");
        if (!staging.renameTo(target)) {
            if (backup.exists()) backup.renameTo(target);
            throw new IllegalStateException("Could not activate downloaded bundle");
        }
        deleteRecursively(backup);
    }

    private void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }

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
        if (scheme == null) return true;

        // Keep app-bundled pages and offline assets inside the WebView.
        if (scheme.equalsIgnoreCase("https") &&
                "appassets.androidplatform.net".equalsIgnoreCase(uri.getHost())) {
            return false;
        }
        if (scheme.equalsIgnoreCase("file") || scheme.equalsIgnoreCase("about")) {
            return false;
        }

        // Open web links in the user's browser or the installed app registered
        // for that URL (for example, social, video, or deep links). Never silently
        // navigate ordinary HTTP(S) links inside the wrapper WebView.
        if (scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                Log.w("CastelAppFactory", "EXTERNAL_LINK_OPEN_FAILED:" + uri, e);
                Toast.makeText(this, "No app is available to open this link.", Toast.LENGTH_SHORT).show();
                return true;
            }
        }

        // Hand off mailto:, tel:, geo:, and supported custom app schemes.
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        } catch (Exception e) {
            Log.w("CastelAppFactory", "LINK_SCHEME_UNSUPPORTED:" + scheme, e);
            Toast.makeText(this, "This link cannot be opened on this device.", Toast.LENGTH_SHORT).show();
            return true;
        }
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
