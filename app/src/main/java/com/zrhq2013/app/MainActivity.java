package com.zrhq2013.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ProgressBar progressBar;

    /** true = 加载 APK 内置 assets/webapp 离线应用；false = 加载 REMOTE_URL */
    private static final boolean USE_LOCAL_ASSETS = true;
    private static final String LOCAL_URL = "file:///android_asset/webapp/index.html";
    private static final String REMOTE_URL = "https://www.lingguang.com/share/CHAT-27eb3584-c60f-40ff-a042-ba5a820de81550?sharemedium=others";

    private static final int FILE_CHOOSER_RESULT_CODE = 1;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress_bar);

        setupWebView();
        webView.loadUrl(USE_LOCAL_ASSETS ? LOCAL_URL : REMOTE_URL);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        WebSettings settings = webView.getSettings();

        // JavaScript / DOM 存储（案件本地存档依赖 localStorage）
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        // 本地 assets 应用访问：允许 file 协议及其跨域 HTTPS API 调用（TronGrid/TronScan/官方核查站）
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
        }

        // 缓存
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAppCacheEnabled(true);

        // 媒体播放
        settings.setMediaPlaybackRequiresUserGesture(false);

        // 缩放
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        // H5 提存包 / JSON 文件保存桥接（写入应用专属外部目录，无需运行时存储权限）
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String saveText(final String filename, final String content) {
                try {
                    File dir = new File(getExternalFilesDir(null), "escrow");
                    if (!dir.exists() && !dir.mkdirs()) {
                        return "ERROR:目录创建失败";
                    }
                    File out = new File(dir, filename);
                    try (FileOutputStream fos = new FileOutputStream(out)) {
                        fos.write(content.getBytes(StandardCharsets.UTF_8));
                    }
                    final String path = out.getAbsolutePath();
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "已保存：" + path, Toast.LENGTH_LONG).show());
                    return path;
                } catch (Exception e) {
                    return "ERROR:" + e.getMessage();
                }
            }
        }, "EscrowBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
        });

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
        });
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
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
