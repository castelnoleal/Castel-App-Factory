package com.castel.generatedapp;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Periodic background check of the app's update feed (scheduled by MainActivity). */
public class UpdateCheckWorker extends Worker {
    static final String KEY_FEED_URL = "feedUrl";
    static final String UNIQUE_NAME = "instapped-update-check";

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String feedUrl = getInputData().getString(KEY_FEED_URL);
        if (feedUrl == null || feedUrl.isEmpty()) return Result.success();
        try {
            UpdateFeed feed = UpdateFeed.fetch(feedUrl);
            if (feed != null) feed.notifyIfNew(getApplicationContext());
            return Result.success();
        } catch (Exception e) {
            Log.w(UpdateFeed.TAG, "UPDATE_CHECK_FAILED", e);
            return getRunAttemptCount() < 3 ? Result.retry() : Result.success();
        }
    }
}
