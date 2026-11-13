package com.zrhq2013.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ProgressBar progressBar;
    private static final String APP_URL = "https://www.lingguang.com/share/CHAT-27eb3584-c60f-40ff-a042-ba5a820de81550?sharemedium=others";
    private static final int FILE_CHOOSER_RESULT_CODE = 1;
    private static final int REQUEST_LOCATION_PERMISSION = 2;
    private static final int REQUEST_MEDIA_PERMISSION = 3;
    private ValueCallback<Uri[]> filePathCallback;

    // 网页定位授权回调，等待运行时权限申请结果后再回调
    private GeolocationPermissions.Callback geolocationCallback;
    private String geolocationOrigin;

    // 网页相机/麦克风授权请求，等待运行时权限申请结果后再回调
    private PermissionRequest pendingMediaPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress_bar);

        setupWebView();
        loadUrl(APP_URL);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();

        // JavaScript support
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        // Cache settings（AppCache API 已在新版 WebView 移除，仅保留 HTTP 缓存策略）
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // User agent
        settings.setUserAgentString(settings.getUserAgentString());

        // Media playback
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Zoom settings
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(true);

        // Geolocation support（实际授权在 WebChromeClient 回调中处理）
        settings.setGeolocationEnabled(true);

        // Performance
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        // WebViewClient for handling navigation
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    return false;
                }

                // Handle other schemes (tel:, mailto:, etc.)
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
        });

        // WebChromeClient for progress, alerts, file upload
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                super.onProgressChanged(view, newProgress);
                progressBar.setProgress(newProgress);
                if (newProgress == 100) {
                    progressBar.setVisibility(ProgressBar.GONE);
                } else {
                    progressBar.setVisibility(ProgressBar.VISIBLE);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                            FileChooserParams fileChooserParams) {
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(intent, FILE_CHOOSER_RESULT_CODE);
                return true;
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback callback) {
                // 已授权定位：直接放行；未授权：暂存回调并申请运行时权限
                if (ContextCompat.checkSelfPermission(MainActivity.this,
                        Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                } else {
                    geolocationOrigin = origin;
                    geolocationCallback = callback;
                    ActivityCompat.requestPermissions(MainActivity.this,
                            new String[]{Manifest.permission.ACCESS_FINE_LOCATION},
                            REQUEST_LOCATION_PERMISSION);
                }
            }

            @Override
            public void onGeolocationPermissionsHidePrompt() {
                // 网页关闭定位请求时无需额外处理
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 网页通过 getUserMedia 等申请相机/麦克风时触发，
                // 将 WebView 资源映射为对应的 Android 运行时权限
                List<String> requiredPermissions = new ArrayList<>();
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        requiredPermissions.add(Manifest.permission.CAMERA);
                    } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        requiredPermissions.add(Manifest.permission.RECORD_AUDIO);
                    }
                }

                // 无需映射权限的资源（如 MIDI）直接放行
                if (requiredPermissions.isEmpty()) {
                    request.grant(request.getResources());
                    return;
                }

                // 过滤出尚未授予的权限
                List<String> ungrantedPermissions = new ArrayList<>();
                for (String permission : requiredPermissions) {
                    if (ContextCompat.checkSelfPermission(MainActivity.this, permission)
                            != PackageManager.PERMISSION_GRANTED) {
                        ungrantedPermissions.add(permission);
                    }
                }

                if (ungrantedPermissions.isEmpty()) {
                    // 所需权限均已授予，直接放行网页请求的全部资源
                    request.grant(request.getResources());
                } else {
                    // 暂存请求，待运行时权限弹窗结果返回后再授权或拒绝
                    pendingMediaPermissionRequest = request;
                    ActivityCompat.requestPermissions(MainActivity.this,
                            ungrantedPermissions.toArray(new String[0]),
                            REQUEST_MEDIA_PERMISSION);
                }
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                // 网页主动取消请求时清理暂存，避免回调错位
                pendingMediaPermissionRequest = null;
            }
        });

        // 文件下载交由系统 DownloadManager 处理，支持通知栏进度与公共下载目录
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) ->
                handleDownload(url, userAgent, contentDisposition, mimeType));
    }

    private void loadUrl(String url) {
        webView.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (filePathCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    Uri uri = data.getData();
                    if (uri != null) {
                        result = new Uri[]{uri};
                    }
                }
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_LOCATION_PERMISSION && geolocationCallback != null) {
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            // 将权限申请结果回传给网页
            geolocationCallback.invoke(geolocationOrigin, granted, false);
            geolocationCallback = null;
            geolocationOrigin = null;
        } else if (requestCode == REQUEST_MEDIA_PERMISSION
                && pendingMediaPermissionRequest != null) {
            boolean allGranted = grantResults.length > 0;
            for (int result : grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted) {
                // 全部所需权限已授予，放行网页请求的资源
                pendingMediaPermissionRequest.grant(
                        pendingMediaPermissionRequest.getResources());
            } else {
                // 存在被拒绝的权限，拒绝网页请求并提示用户
                pendingMediaPermissionRequest.deny();
                Toast.makeText(this, R.string.permission_media_denied,
                        Toast.LENGTH_SHORT).show();
            }
            pendingMediaPermissionRequest = null;
        }
    }

    private void handleDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (!URLUtil.isNetworkUrl(url)) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));

            // 文件名优先取 Content-Disposition，其次从 URL 推断
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);

            // MIME 为空时按扩展名兜底推断
            String finalMimeType = mimeType;
            if (finalMimeType == null || finalMimeType.isEmpty()) {
                String extension = MimeTypeMap.getFileExtensionFromUrl(url);
                if (extension != null && !extension.isEmpty()) {
                    finalMimeType = MimeTypeMap.getSingleton()
                            .getMimeTypeFromExtension(extension.toLowerCase());
                }
            }
            if (finalMimeType != null && !finalMimeType.isEmpty()) {
                request.setMimeType(finalMimeType);
            }

            // 携带登录态 Cookie 与 User-Agent，兼容需鉴权的下载链接
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }
            request.addRequestHeader("User-Agent", userAgent);

            request.setTitle(fileName);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // 由系统 DownloadManager 写入公共 Download 目录，无需申请存储权限
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
                return;
            }
            manager.enqueue(request);
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
