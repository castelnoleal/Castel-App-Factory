package com.castel.generatedapp;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
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

    // ---- Build options: each line below is rewritten by scripts/generate-app.py ----
    private static final boolean OFFLINE_STORAGE = false;
    private static final boolean AUTO_UPDATE = false;
    private static final int CACHE_MODE = WebSettings.LOAD_DEFAULT;

    private static final boolean ALLOW_EXTERNAL_LINKS = true;
    private static final boolean ENABLE_ZOOM = false;
    private static final boolean FULLSCREEN = false;
    private static final boolean BACK_NAVIGATION = true;
    private static final boolean PULL_TO_REFRESH = false;
    private static final boolean KEEP_AWAKE = false;
    private static final boolean ALLOW_LOCATION = false;
    private static final boolean ALLOW_CAMERA = false;
    private static final boolean ALLOW_MICROPHONE = false;
    private static final String SPLASH_MODE = "icon";
    private static final boolean SPLASH_FIT_COVER = true;
    private static final int SPLASH_MIN_MS = 600;
    private static final int THEME_COLOR = 0xFF080B14;
    private static final int SPLASH_COLOR = 0xFF080B14;
    private static final String[] INTERNAL_HOSTS = {};
    private static final String USER_AGENT_SUFFIX = "";
    private static final String START_URL = "__TARGET_URL__";
    // ---- End of build options ----

    private static final String TAG = "CastelAppFactory";
    private static final int SPLASH_MAX_MS = 8000;
    private static final String LOCAL_HOST = "appassets.androidplatform.net";

    private FrameLayout root;
    private FrameLayout content;
    private SwipeRefreshLayout swipe;
    private View splashView;
    private View errorView;
    private TextView errorTitle;
    private TextView errorBody;
    private FrameLayout videoContainer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private WindowInsetsControllerCompat insetsController;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private final long startedAt = SystemClock.elapsedRealtime();
    private boolean contentReady = false;
    private boolean splashHidden = false;
    private boolean errorShowing = false;
    private boolean loadedWhileOffline = false;
    private String failedUrl = null;
    private Consumer<Map<String, Boolean>> pendingPermissionResult;

    private final ActivityResultLauncher<String[]> permissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                Consumer<Map<String, Boolean>> callback = pendingPermissionResult;
                pendingPermissionResult = null;
                if (callback != null) callback.accept(result);
            });

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window window = getWindow();
        try {
            configureWindow(window);
            initializeWebView(window, savedInstanceState);
        } catch (Throwable fatal) {
            Log.e(TAG, "LAUNCH_FAILED", fatal);
            showLaunchError(fatal);
        }
    }

    // ------------------------------------------------------------------ window

    private void configureWindow(Window window) {
        // Draw edge to edge on every Android version (Android 15+ forces it at
        // target API 35+) and pad the content by the system bar and keyboard
        // insets, so pages are never hidden behind the status bar or keyboard.
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT < 30) {
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }
        insetsController = WindowCompat.getInsetsController(window, window.getDecorView());
        boolean lightBars = isLightColor(THEME_COLOR);
        insetsController.setAppearanceLightStatusBars(lightBars);
        insetsController.setAppearanceLightNavigationBars(lightBars);
        if (KEEP_AWAKE) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (FULLSCREEN && Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        applyFullscreen();
    }

    private void applyFullscreen() {
        if (insetsController == null) return;
        if (FULLSCREEN || customView != null) {
            insetsController.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            insetsController.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            insetsController.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && (FULLSCREEN || customView != null)) applyFullscreen();
    }

    // ----------------------------------------------------------------- webview

    private void initializeWebView(Window window, @Nullable Bundle savedInstanceState) {
        root = new FrameLayout(this);
        root.setBackgroundColor(THEME_COLOR);
        content = new FrameLayout(this);
        root.addView(content, match());

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        if (PULL_TO_REFRESH) {
            swipe = new SwipeRefreshLayout(this);
            swipe.addView(webView, match());
            swipe.setColorSchemeColors(isLightColor(THEME_COLOR) ? Color.BLACK : THEME_COLOR);
            swipe.setOnChildScrollUpCallback((parent, child) -> webView != null && webView.getScrollY() > 0);
            swipe.setOnRefreshListener(() -> { if (errorShowing) retry(); else if (webView != null) webView.reload(); });
            content.addView(swipe, match());
        } else {
            content.addView(webView, match());
        }
        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        content.addView(errorView, match());

        videoContainer = new FrameLayout(this);
        videoContainer.setBackgroundColor(Color.BLACK);
        videoContainer.setVisibility(View.GONE);
        root.addView(videoContainer, match());

        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            int types = WindowInsetsCompat.Type.ime();
            if (!FULLSCREEN) types |= WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets bars = insets.getInsets(types);
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setupSplash(savedInstanceState != null);

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
        settings.setGeolocationEnabled(ALLOW_LOCATION);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        if (!USER_AGENT_SUFFIX.isEmpty()) settings.setUserAgentString(settings.getUserAgentString() + " " + USER_AGENT_SUFFIX);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        offlineDataDir = new File(getFilesDir(), "offline-data");
        if (OFFLINE_STORAGE) offlineDataDir.mkdirs();
        webView.addJavascriptInterface(new OfflineStorageBridge(), "CastelApp");

        connectivity = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        applyCacheMode();
        registerNetworkCallback();

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
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return assetLoader.shouldInterceptRequest(Uri.parse(url));
            }
            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                return handleNavigation(request.getUrl(), request.hasGesture(), request.isRedirect());
            }
            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url), true, false);
            }
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                if (!isOnline() && CACHE_MODE != WebSettings.LOAD_NO_CACHE) loadedWhileOffline = true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i("CastelAppFactory", "PAGE_LOADED:" + url);
                if (swipe != null) swipe.setRefreshing(false);
                // WebView's native DownloadListener cannot handle blob: URLs used by
                // canvas/image exports. Capture download links and hand their bytes
                // to the native bridge so exports save to Android Downloads.
                String downloadBridgeScript = "(function(){if(window.__castelBlobDownloadsInstalled)return;window.__castelBlobDownloadsInstalled=true;document.addEventListener('click',function(ev){var a=ev.target&&ev.target.closest?ev.target.closest('a[download]'):null;if(!a)return;var href=a.href||'';if(!href.startsWith('blob:')&&!href.startsWith('data:'))return;ev.preventDefault();ev.stopImmediatePropagation();var name=a.getAttribute('download')||'download.png';var send=function(data){try{window.CastelApp.saveBase64File(data,name)}catch(e){console.error('Native save failed',e)}};if(href.startsWith('data:')){send(href);return;}fetch(href).then(function(r){return r.blob()}).then(function(blob){var reader=new FileReader();reader.onloadend=function(){send(reader.result)};reader.readAsDataURL(blob)}).catch(function(e){console.error('Blob export failed',e)});},true)})()";
                view.evaluateJavascript(downloadBridgeScript, null);
                // Android WebView has no navigator.share; route it to the native share sheet.
                String shareShim = "(function(){if(navigator.share||!window.CastelApp)return;navigator.share=function(d){d=d||{};try{window.CastelApp.share(String(d.title||''),String(d.text||''),String(d.url||''));return Promise.resolve()}catch(e){return Promise.reject(e)}};navigator.canShare=function(){return true}})()";
                view.evaluateJavascript(shareShim, null);
                if (!errorShowing && url != null && !url.startsWith("about:")) {
                    contentReady = true;
                    maybeHideSplash();
                }
            }
            @Override
            public void onReceivedError(@NonNull WebView view, @NonNull WebResourceRequest request, @NonNull WebResourceErrorCompat error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    Log.e("CastelAppFactory", "PAGE_ERROR:" + request.getUrl() + ":" + error.getErrorCode());
                    showError(request.getUrl().toString());
                }
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
                // Send the page's session so downloads behind a login still work.
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isEmpty()) request.addRequestHeader("Cookie", cookies);
                if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);
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
                    Toast.makeText(MainActivity.this, "No app is available to choose a file.", Toast.LENGTH_SHORT).show();
                    return true;
                }
            }
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                // Fullscreen video (for example, the YouTube fullscreen button).
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customViewCallback = callback;
                videoContainer.addView(view, match());
                videoContainer.setVisibility(View.VISIBLE);
                applyFullscreen();
            }
            @Override
            public void onHideCustomView() { exitCustomView(); }
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!ALLOW_LOCATION) { callback.invoke(origin, false, false); return; }
                requestAndroidPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},
                        granted -> callback.invoke(origin, granted.contains(Manifest.permission.ACCESS_FINE_LOCATION) || granted.contains(Manifest.permission.ACCESS_COARSE_LOCATION), false));
            }
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customView != null) { exitCustomView(); return; }
                WebView currentWebView = webView;
                if (BACK_NAVIGATION) {
                    if (errorShowing && currentWebView != null && currentWebView.canGoBack()) {
                        hideError();
                        currentWebView.goBack();
                        return;
                    }
                    if (currentWebView != null && currentWebView.canGoBack()) {
                        currentWebView.goBack();
                        lastBackPressedAt = 0L;
                        return;
                    }
                    // Do not immediately close the app when there is no WebView
                    // history (common on the initial screen or in single-page apps).
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastBackPressedAt >= 2000L) {
                        lastBackPressedAt = now;
                        Toast.makeText(MainActivity.this,
                                "You're at the start. Press Back again to exit.",
                                Toast.LENGTH_SHORT).show();
                        return;
                    }
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });

        boolean restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null;
        if (!restored) {
            webView.post(() -> webView.loadUrl("__TARGET_URL__"));
        }
    }

    // ------------------------------------------------------------------ splash

    private void setupSplash(boolean restoring) {
        if (restoring) { splashHidden = true; return; }
        boolean art = "art".equals(SPLASH_MODE) && splashArtId() != 0;
        if (!art && Build.VERSION.SDK_INT >= 31) {
            // Android 12+ already shows the launcher icon on a splash screen. Keep
            // that system splash up until the first page is ready (or a timeout),
            // exactly like a normal app, instead of flashing a blank WebView.
            final View decor = getWindow().getDecorView();
            decor.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
                @Override
                public boolean onPreDraw() {
                    if (splashReady()) {
                        splashHidden = true;
                        decor.getViewTreeObserver().removeOnPreDrawListener(this);
                        return true;
                    }
                    return false;
                }
            });
            decor.postDelayed(() -> { contentReady = true; decor.invalidate(); }, SPLASH_MAX_MS);
            return;
        }
        splashView = buildSplashView(art);
        root.addView(splashView, match());
        root.postDelayed(this::forceHideSplash, SPLASH_MAX_MS);
    }

    private boolean splashReady() {
        return (contentReady || errorShowing) && SystemClock.elapsedRealtime() - startedAt >= SPLASH_MIN_MS;
    }

    @SuppressWarnings("DiscouragedApi")
    private int splashArtId() {
        return getResources().getIdentifier("splash_art", "drawable", getPackageName());
    }

    private View buildSplashView(boolean art) {
        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(SPLASH_COLOR);
        splash.setClickable(true);
        ImageView image = new ImageView(this);
        image.setContentDescription(getApplicationInfo().loadLabel(getPackageManager()));
        if (art) {
            image.setImageResource(splashArtId());
            image.setScaleType(SPLASH_FIT_COVER ? ImageView.ScaleType.CENTER_CROP : ImageView.ScaleType.FIT_CENTER);
            splash.addView(image, match());
        } else {
            Drawable icon = getPackageManager().getApplicationIcon(getApplicationInfo());
            image.setImageDrawable(icon);
            int size = dp(112);
            splash.addView(image, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
        }
        return splash;
    }

    private void maybeHideSplash() {
        if (splashView == null || splashHidden) {
            if (Build.VERSION.SDK_INT >= 31) getWindow().getDecorView().invalidate();
            return;
        }
        long wait = Math.max(0, SPLASH_MIN_MS - (SystemClock.elapsedRealtime() - startedAt));
        root.postDelayed(this::forceHideSplash, wait);
    }

    private void forceHideSplash() {
        if (splashView == null || splashHidden) return;
        splashHidden = true;
        final View splash = splashView;
        splash.animate().alpha(0f).setDuration(220).withEndAction(() -> {
            if (root != null) root.removeView(splash);
        }).start();
    }

    // ------------------------------------------------------------ offline/error

    private View buildErrorView() {
        boolean light = isLightColor(THEME_COLOR);
        int fg = light ? Color.rgb(16, 26, 46) : Color.WHITE;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(THEME_COLOR);
        box.setPadding(dp(32), dp(32), dp(32), dp(32));
        box.setClickable(true);
        errorTitle = new TextView(this);
        errorTitle.setTextColor(fg);
        errorTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        errorTitle.setGravity(Gravity.CENTER);
        errorBody = new TextView(this);
        errorBody.setTextColor(fg);
        errorBody.setAlpha(0.75f);
        errorBody.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        errorBody.setGravity(Gravity.CENTER);
        errorBody.setPadding(0, dp(8), 0, dp(20));
        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setAllCaps(false);
        retry.setOnClickListener(v -> retry());
        box.addView(errorTitle, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(errorBody, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(retry, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return box;
    }

    private void showError(String url) {
        failedUrl = url;
        errorShowing = true;
        boolean online = isOnline();
        errorTitle.setText(online ? "This page couldn't load" : "You're offline");
        errorBody.setText(online
                ? "Something went wrong while loading. Check your connection and try again."
                : "Connect to the internet and the app will try again automatically.");
        errorView.setVisibility(View.VISIBLE);
        if (swipe != null) swipe.setRefreshing(false);
        forceHideSplash();
        if (Build.VERSION.SDK_INT >= 31) getWindow().getDecorView().invalidate();
    }

    private void hideError() {
        errorShowing = false;
        errorView.setVisibility(View.GONE);
    }

    private void retry() {
        if (webView == null) return;
        String target = failedUrl;
        hideError();
        applyCacheMode();
        if (target != null && !target.isEmpty()) webView.loadUrl(target); else webView.reload();
    }

    private boolean isOnline() {
        try {
            if (connectivity == null) return true;
            Network network = connectivity.getActiveNetwork();
            if (network == null) return false;
            NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true;
        }
    }

    private void applyCacheMode() {
        if (webView == null) return;
        int mode = CACHE_MODE;
        // Standard caching follows the site's headers online, and falls back to
        // anything already cached while offline instead of showing an error.
        if (mode == WebSettings.LOAD_DEFAULT && !isOnline()) mode = WebSettings.LOAD_CACHE_ELSE_NETWORK;
        webView.getSettings().setCacheMode(mode);
    }

    private void registerNetworkCallback() {
        if (connectivity == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                runOnUiThread(() -> {
                    applyCacheMode();
                    if (errorShowing) retry();
                    else if (AUTO_UPDATE && loadedWhileOffline && webView != null) {
                        loadedWhileOffline = false;
                        webView.reload();
                    }
                });
            }
            @Override
            public void onLost(@NonNull Network network) {
                runOnUiThread(MainActivity.this::applyCacheMode);
            }
        };
        try {
            connectivity.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            Log.w(TAG, "NETWORK_CALLBACK_UNAVAILABLE", e);
            networkCallback = null;
        }
    }

    // ------------------------------------------------------------- permissions

    private void requestAndroidPermissions(String[] permissions, Consumer<List<String>> onResult) {
        List<String> granted = new ArrayList<>();
        List<String> missing = new ArrayList<>();
        for (String p : permissions) {
            if (ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED) granted.add(p);
            else missing.add(p);
        }
        if (missing.isEmpty()) { onResult.accept(granted); return; }
        if (pendingPermissionResult != null) { onResult.accept(granted); return; }
        pendingPermissionResult = result -> {
            for (Map.Entry<String, Boolean> e : result.entrySet()) if (Boolean.TRUE.equals(e.getValue())) granted.add(e.getKey());
            onResult.accept(granted);
        };
        try {
            permissionLauncher.launch(missing.toArray(new String[0]));
        } catch (Exception e) {
            pendingPermissionResult = null;
            onResult.accept(granted);
        }
    }

    private void handleWebPermission(PermissionRequest request) {
        List<String> resources = new ArrayList<>();
        List<String> needed = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && ALLOW_CAMERA) { resources.add(r); needed.add(Manifest.permission.CAMERA); }
            else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && ALLOW_MICROPHONE) { resources.add(r); needed.add(Manifest.permission.RECORD_AUDIO); }
        }
        if (resources.isEmpty()) { request.deny(); return; }
        requestAndroidPermissions(needed.toArray(new String[0]), granted -> {
            List<String> allow = new ArrayList<>();
            for (int i = 0; i < resources.size(); i++) if (granted.contains(needed.get(i))) allow.add(resources.get(i));
            if (allow.isEmpty()) request.deny(); else request.grant(allow.toArray(new String[0]));
        });
    }

    // ------------------------------------------------------------- lifecycle

    private void exitCustomView() {
        if (customView == null) return;
        videoContainer.removeView(customView);
        videoContainer.setVisibility(View.GONE);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        applyFullscreen();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
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
        @JavascriptInterface public boolean isOnline() { return MainActivity.this.isOnline(); }
        @JavascriptInterface public String appInfo() {
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : legacyVersionCode(info);
                return "{\"packageName\":\"" + getPackageName() + "\",\"versionName\":\"" + String.valueOf(info.versionName).replace("\"", "") + "\",\"versionCode\":" + code + ",\"android\":" + Build.VERSION.SDK_INT + "}";
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void share(String title, String text, String url) {
            runOnUiThread(() -> {
                try {
                    StringBuilder body = new StringBuilder();
                    if (text != null && !text.isEmpty()) body.append(text);
                    if (url != null && !url.isEmpty()) { if (body.length() > 0) body.append("\n"); body.append(url); }
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_TEXT, body.toString());
                    if (title != null && !title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
                    startActivity(Intent.createChooser(send, title == null || title.isEmpty() ? null : title));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Sharing isn't available on this device.", Toast.LENGTH_SHORT).show();
                }
            });
        }
        @JavascriptInterface public void openExternal(String url) {
            runOnUiThread(() -> { if (url != null && url.matches("(?i)https?://.+")) openOutside(Uri.parse(url)); });
        }
        @JavascriptInterface public void saveBase64File(String dataUrl, String fileName) {
            try {
                if (dataUrl == null || !dataUrl.startsWith("data:") || !dataUrl.contains(",")) {
                    throw new IllegalArgumentException("Invalid data URL");
                }
                String meta = dataUrl.substring(0, dataUrl.indexOf(','));
                if (!meta.toLowerCase(Locale.ROOT).contains(";base64")) throw new IllegalArgumentException("Expected base64 data");
                String mime = meta.substring(5).split(";")[0];
                if (mime.isEmpty()) mime = "application/octet-stream";
                String payload = dataUrl.substring(dataUrl.indexOf(',') + 1);
                if (payload.length() > 40000000) throw new IllegalArgumentException("File is too large");
                byte[] bytes = Base64.decode(payload, Base64.DEFAULT);
                String safeName = fileName == null ? "download.png" : fileName.replaceAll("[\\\\/:*?\\\"<>|]", "_");
                if (safeName.trim().isEmpty()) safeName = "download.png";
                if (Build.VERSION.SDK_INT >= 29) {
                    // Android 10+ shared storage: write through MediaStore, no permission needed.
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri item = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (item == null) throw new IllegalStateException("Downloads folder unavailable");
                    try (OutputStream stream = getContentResolver().openOutputStream(item)) {
                        if (stream == null) throw new IllegalStateException("Could not open Downloads");
                        stream.write(bytes);
                        stream.flush();
                    }
                } else {
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(() -> requestAndroidPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, granted ->
                                Toast.makeText(MainActivity.this, granted.isEmpty() ? "Allow storage access to save files." : "Storage allowed. Tap save again.", Toast.LENGTH_LONG).show()));
                        return;
                    }
                    File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloads.exists() && !downloads.mkdirs()) throw new IllegalStateException("Downloads folder unavailable");
                    File output = new File(downloads, safeName);
                    try (FileOutputStream stream = new FileOutputStream(output)) { stream.write(bytes); stream.flush(); }
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Saved to Downloads.", Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.e("CastelAppFactory", "BLOB_DOWNLOAD_FAILED", e);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Could not save file. Please try again.", Toast.LENGTH_LONG).show());
            }
        }
        @JavascriptInterface public void downloadArtifact(String url, String fileName) {
            try {
                requireHttpUrl(url);
                Uri uri = Uri.parse(url);
                String safeName = fileName == null ? "download" : fileName.replaceAll("[\\\\/:*?\\\"<>|]", "_");
                if (safeName.trim().isEmpty()) safeName = "download";
                DownloadManager.Request request = new DownloadManager.Request(uri);
                request.setTitle(safeName);
                request.setDescription("Downloading " + safeName);
                request.setMimeType(safeName.toLowerCase(Locale.ROOT).endsWith(".apk") ? "application/vnd.android.package-archive" : "application/octet-stream");
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

    @SuppressWarnings("deprecation")
    private static long legacyVersionCode(PackageInfo info) { return info.versionCode; }

    private String mimeType(String path) {
        String p = path.toLowerCase(Locale.ROOT);
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
        String p = path.toLowerCase(Locale.ROOT);
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

    // -------------------------------------------------------------- navigation

    /** True for links that belong to this app and should stay inside it. */
    private boolean isInternalHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (LOCAL_HOST.equals(host)) return true;
        for (String allowed : INTERNAL_HOSTS) {
            String a = allowed.toLowerCase(Locale.ROOT);
            if (host.equals(a) || host.endsWith("." + a)) return true;
        }
        String start = Uri.parse(START_URL).getHost();
        if (start == null || LOCAL_HOST.equalsIgnoreCase(start)) return false;
        String s = stripWww(start.toLowerCase(Locale.ROOT));
        String h = stripWww(host);
        // Same site: example.com, www.example.com and any subdomain of the start host.
        return h.equals(s) || h.endsWith("." + s) || s.endsWith("." + h);
    }

    private static String stripWww(String host) { return host.startsWith("www.") ? host.substring(4) : host; }

    private boolean handleNavigation(Uri uri, boolean userGesture, boolean redirect) {
        String scheme = uri.getScheme();
        if (scheme == null) return true;
        scheme = scheme.toLowerCase(Locale.ROOT);

        if (scheme.equals("http") || scheme.equals("https")) {
            // App pages, the app's own website and listed domains stay in the app.
            if (isInternalHost(uri.getHost())) return false;
            // "Open external links" off: every link opens inside the app.
            if (!ALLOW_EXTERNAL_LINKS) return false;
            // Redirects and script navigations without a tap (sign-in flows,
            // www/https redirects) stay in the app so it never ends up blank.
            if (redirect || !userGesture) return false;
            openOutside(uri);
            return true;
        }
        if (scheme.equals("file") || scheme.equals("about") || scheme.equals("data") || scheme.equals("blob") || scheme.equals("javascript")) {
            return false;
        }
        if (scheme.equals("intent")) {
            try {
                Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.setComponent(null);
                intent.setSelector(null);
                try {
                    startActivity(intent);
                } catch (ActivityNotFoundException notInstalled) {
                    String fallback = intent.getStringExtra("browser_fallback_url");
                    if (fallback != null && fallback.matches("(?i)https?://.+")) {
                        if (webView != null) webView.loadUrl(fallback);
                    } else if (intent.getPackage() != null) {
                        openOutside(Uri.parse("market://details?id=" + intent.getPackage()));
                    } else {
                        Toast.makeText(this, "This link cannot be opened on this device.", Toast.LENGTH_SHORT).show();
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "INTENT_LINK_FAILED:" + uri, e);
                Toast.makeText(this, "This link cannot be opened on this device.", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
        // Hand off mailto:, tel:, sms:, geo:, market: and other app schemes.
        openOutside(uri);
        return true;
    }

    private void openOutside(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception e) {
            Log.w("CastelAppFactory", "EXTERNAL_LINK_OPEN_FAILED:" + uri, e);
            Toast.makeText(this, "No app is available to open this link.", Toast.LENGTH_SHORT).show();
        }
    }

    // ----------------------------------------------------------------- helpers

    private static FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static boolean isLightColor(int color) {
        double r = Color.red(color) / 255.0, g = Color.green(color) / 255.0, b = Color.blue(color) / 255.0;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.6;
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
        if (connectivity != null && networkCallback != null) {
            try { connectivity.unregisterNetworkCallback(networkCallback); } catch (Exception ignored) { }
        }
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
