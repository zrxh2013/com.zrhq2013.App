package com.zrhq2013.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.text.TextUtils;
import android.webkit.CookieManager;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public final class DownloadCenter {

    public static final int REQ_WRITE_STORAGE = 200;
    private static final String PORTAL_REFERER = "https://etax.chinatax.gov.cn/";

    private static PendingDownload pending;

    private DownloadCenter() {
    }

    private static class PendingDownload {
        final String url;
        final String fileName;

        PendingDownload(String url, String fileName) {
            this.url = url;
            this.fileName = fileName;
        }
    }

    public static void download(Activity activity, String url, String fileName) {
        if (TextUtils.isEmpty(url)) {
            Toast.makeText(activity, R.string.download_failed, Toast.LENGTH_SHORT).show();
            return;
        }

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && ContextCompat.checkSelfPermission(activity,
                Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pending = new PendingDownload(url, fileName);
            ActivityCompat.requestPermissions(activity,
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    REQ_WRITE_STORAGE);
            return;
        }

        enqueue(activity, url, fileName);
    }

    public static void onRequestPermissionsResult(Activity activity, int requestCode,
                                                  int[] grantResults) {
        if (requestCode != REQ_WRITE_STORAGE) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED
                && pending != null) {
            enqueue(activity, pending.url, pending.fileName);
        } else {
            Toast.makeText(activity, R.string.storage_permission_denied, Toast.LENGTH_SHORT).show();
        }
        pending = null;
    }

    private static void enqueue(Context context, String url, String fileName) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(fileName);
            request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI
                    | DownloadManager.Request.NETWORK_MOBILE);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            request.allowScanningByMediaScanner();
            request.setMimeType("application/zip");
            request.addRequestHeader("Referer", PORTAL_REFERER);

            String cookie = CookieManager.getInstance().getCookie(url);
            if (!TextUtils.isEmpty(cookie)) {
                request.addRequestHeader("Cookie", cookie);
            }

            DownloadManager manager =
                    (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                Toast.makeText(context, R.string.download_unavailable, Toast.LENGTH_SHORT).show();
                return;
            }

            manager.enqueue(request);
            Toast.makeText(context,
                    context.getString(R.string.download_started, fileName),
                    Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(context, R.string.download_failed, Toast.LENGTH_SHORT).show();
        }
    }

    public static BroadcastReceiver registerCompleteReceiver(Context context) {
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id < 0) {
                    return;
                }
                DownloadManager manager =
                        (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager == null) {
                    return;
                }
                DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
                try (android.database.Cursor cursor = manager.query(query)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int status = cursor.getInt(
                                cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            String title = cursor.getString(
                                    cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE));
                            Toast.makeText(ctx,
                                    ctx.getString(R.string.download_completed, title),
                                    Toast.LENGTH_LONG).show();
                        }
                    }
                } catch (Exception ignored) {
                    // 查询失败时静默处理，不影响系统通知栏中的下载结果
                }
            }
        };
        // 下载完成广播由系统 DownloadManager 发出，需要 EXPORTED 才能接收系统广播
        ContextCompat.registerReceiver(context, receiver,
                new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED);
        return receiver;
    }

    public static void unregisterCompleteReceiver(Context context, BroadcastReceiver receiver) {
        if (receiver != null) {
            try {
                context.unregisterReceiver(receiver);
            } catch (Exception ignored) {
                // 未注册时忽略
            }
        }
    }
}
