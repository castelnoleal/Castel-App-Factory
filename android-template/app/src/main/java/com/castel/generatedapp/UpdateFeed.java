package com.castel.generatedapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Update feed support for instApped apps.
 *
 * The developer hosts a small JSON file (the "update feed"):
 * <pre>
 * {
 *   "versionCode": 5,            // newest available version code
 *   "versionName": "1.4.0",
 *   "minVersionCode": 3,         // optional: older versions must update
 *   "title": "Update available",
 *   "message": "What's new in this version",
 *   "url": "https://play.google.com/store/apps/details?id=...",  // optional
 *   "announcement": {"id": "oct-news", "title": "...", "body": "...", "url": "..."}  // optional
 * }
 * </pre>
 */
final class UpdateFeed {
    static final String TAG = "CastelAppFactory";
    static final String CHANNEL_UPDATES = "instapped_updates";
    static final String CHANNEL_MESSAGES = "instapped_messages";
    private static final String PREFS = "instapped.updates";

    long versionCode;
    long minVersionCode;
    String versionName = "";
    String title = "";
    String message = "";
    String url = "";
    String announcementId = "";
    String announcementTitle = "";
    String announcementBody = "";
    String announcementUrl = "";

    static UpdateFeed fetch(String feedUrl) throws Exception {
        if (feedUrl == null || !feedUrl.matches("(?i)https?://.+")) return null;
        HttpURLConnection c = (HttpURLConnection) new URL(feedUrl).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setUseCaches(false);
        c.setRequestProperty("Accept", "application/json");
        try {
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new IllegalStateException("Update feed HTTP " + code);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    if (out.size() > 256 * 1024) throw new IllegalStateException("Update feed is too large");
                }
            }
            JSONObject json = new JSONObject(out.toString("UTF-8"));
            UpdateFeed feed = new UpdateFeed();
            feed.versionCode = json.optLong("versionCode", json.optLong("latestVersionCode", 0));
            feed.minVersionCode = json.optLong("minVersionCode", 0);
            feed.versionName = json.optString("versionName", "");
            feed.title = json.optString("title", "");
            feed.message = json.optString("message", "");
            feed.url = json.optString("url", "");
            JSONObject a = json.optJSONObject("announcement");
            if (a != null) {
                feed.announcementId = a.optString("id", "");
                feed.announcementTitle = a.optString("title", "");
                feed.announcementBody = a.optString("body", "");
                feed.announcementUrl = a.optString("url", "");
            }
            return feed;
        } finally {
            c.disconnect();
        }
    }

    static long installedVersionCode(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : legacyCode(info);
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    @SuppressWarnings("deprecation")
    private static long legacyCode(PackageInfo info) { return info.versionCode; }

    boolean hasUpdate(Context context) { return versionCode > installedVersionCode(context); }

    boolean isRequired(Context context) { return minVersionCode > installedVersionCode(context); }

    String updateUrl(Context context) {
        if (url != null && url.matches("(?i)(https?|market)://.+")) return url;
        return "market://details?id=" + context.getPackageName();
    }

    String updateTitle() { return title.isEmpty() ? "Update available" : title; }

    String updateMessage() {
        String base = versionName.isEmpty() ? "A new version is ready." : "Version " + versionName + " is ready.";
        return message.isEmpty() ? base + " Tap to update." : message;
    }

    /** Posts an update and/or announcement notification once per version / announcement id. */
    void notifyIfNew(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (hasUpdate(context) && prefs.getLong("notifiedVersion", 0) < versionCode) {
            if (post(context, CHANNEL_UPDATES, "Updates", 1001, updateTitle(), updateMessage(), updateUrl(context))) {
                prefs.edit().putLong("notifiedVersion", versionCode).apply();
            }
        }
        if (!announcementId.isEmpty() && !announcementId.equals(prefs.getString("notifiedAnnouncement", ""))) {
            String link = announcementUrl.matches("(?i)(https?|market)://.+") ? announcementUrl : "";
            if (post(context, CHANNEL_MESSAGES, "News", 1002,
                    announcementTitle.isEmpty() ? appName(context) : announcementTitle, announcementBody, link)) {
                prefs.edit().putString("notifiedAnnouncement", announcementId).apply();
            }
        }
    }

    static String appName(Context context) {
        return String.valueOf(context.getApplicationInfo().loadLabel(context.getPackageManager()));
    }

    /**
     * Shows a notification. An empty url opens the app. Returns false when
     * notifications are turned off for the app.
     */
    @SuppressWarnings("deprecation")
    static boolean post(Context context, String channelId, String channelName, int id, String title, String body, String url) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return false;
            if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
            if (Build.VERSION.SDK_INT >= 33
                    && context.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            Intent open;
            if (url != null && !url.isEmpty()) {
                open = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            } else {
                open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                if (open == null) open = new Intent(context, MainActivity.class);
            }
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent tap = PendingIntent.getActivity(context, id, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel = new NotificationChannel(channelId, channelName, NotificationManager.IMPORTANCE_DEFAULT);
                manager.createNotificationChannel(channel);
                builder = new Notification.Builder(context, channelId);
            } else {
                builder = new Notification.Builder(context);
            }
            builder.setSmallIcon(context.getApplicationInfo().icon)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setAutoCancel(true)
                    .setContentIntent(tap);
            manager.notify(id, builder.build());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "NOTIFICATION_FAILED", e);
            return false;
        }
    }
}
