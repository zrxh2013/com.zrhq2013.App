package com.zrhq2013.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;

import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private ProgressBar progressBar;
    private String polyfillJs;
    private String userAgent;
    private static final String APP_URL = "https://www.lingguang.com/share/CHAT-27eb3584-c60f-40ff-a042-ba5a820de81550?sharemedium=others";
    private static final String POLYFILL_ASSET = "polyfill.js";
    private static final int FILE_CHOOSER_RESULT_CODE = 1;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress_bar);

        WebView.setWebContentsDebuggingEnabled(true);
        polyfillJs = loadAssetText(POLYFILL_ASSET);
        applySystemProxy();
        setupWebView();
        injectPolyfill();
        loadUrl(APP_URL);
    }

    private String loadAssetText(String name) {
        InputStream is = null;
        try {
            is = getAssets().open(name);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return null;
        } finally {
            if (is != null) {
                try { is.close(); } catch (Exception ignored) { }
            }
        }
    }

    /** 让 Java 侧的 HttpURLConnection 也走系统代理（WebView 已自动使用，Java 不会） */
    private void applySystemProxy() {
        try {
            String proxy = android.provider.Settings.Global.getString(
                    getContentResolver(), android.provider.Settings.Global.HTTP_PROXY);
            if (proxy == null || proxy.trim().isEmpty()) {
                return;
            }
            String[] hp = proxy.trim().split(":");
            String host = hp[0];
            String port = hp.length > 1 ? hp[1] : "8080";
            System.setProperty("http.proxyHost", host);
            System.setProperty("http.proxyPort", port);
            System.setProperty("https.proxyHost", host);
            System.setProperty("https.proxyPort", port);
        } catch (Throwable ignored) { }
    }

    /** 在所有框架/iframe 文档开始执行前注入兼容补丁（含 document.cookie 防篡改锁） */
    private void injectPolyfill() {
        if (polyfillJs == null) {
            return;
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, polyfillJs, Collections.<String>emptySet());
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();

        // JavaScript support
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        // Cache settings
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // User agent（缓存供后台线程的 shouldInterceptRequest 使用）
        userAgent = settings.getUserAgentString();

        // Media playback
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Zoom settings
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(true);

        // Cookie：H5 依赖 ctoken / APDID 等 cookie 维持登录态
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

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

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // 兜底：低版本内核不支持 DOCUMENT_START_SCRIPT 时，主框架手动注入
                if (polyfillJs != null
                        && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    view.evaluateJavascript(polyfillJs, null);
                }
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    // 跨域 iframe（如答案卡片 uniocontent.com）在旧内核上拿不到文档启动脚本，
                    // 这里在 HTML 响应里内联注入 polyfill，保证其脚本执行前补丁已就位。
                    Uri uri = request.getUrl();
                    String scheme = uri.getScheme();
                    if (!"https".equals(scheme) && !"http".equals(scheme)) {
                        return null;
                    }
                    if (!"GET".equalsIgnoreCase(request.getMethod())) {
                        return null;
                    }
                    String host = uri.getHost() == null ? "" : uri.getHost();
                    if (host.endsWith("lingguang.com") || host.endsWith("alipayobjects.com")) {
                        return null;
                    }
                    String path = uri.getPath() == null ? "" : uri.getPath();
                    boolean looksLikeHtml = path.endsWith(".html") || path.endsWith("/")
                            || path.lastIndexOf('.') < 0;
                    if (!looksLikeHtml) {
                        return null;
                    }
                    return fetchAndInject(uri.toString());
                } catch (Throwable t) {
                    return null;
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
        });
    }

    /** 拉取跨域 HTML 文档并在 head 起始处内联注入 polyfill */
    private WebResourceResponse fetchAndInject(String url) {
        HttpURLConnection conn = null;
        try {
            if (polyfillJs == null) {
                return null;
            }
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", userAgent != null ? userAgent : "Mozilla/5.0");
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*;q=0.8");
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) {
                conn.setRequestProperty("Cookie", cookie);
            }

            int code = conn.getResponseCode();
            if (code != 200) {
                android.util.Log.i("FlashApp", "inject skip(" + code + ") " + url);
                return null;
            }
            String contentType = conn.getContentType();
            if (contentType == null || contentType.toLowerCase().indexOf("html") < 0) {
                return null;
            }

            Map<String, List<String>> headers = conn.getHeaderFields();
            List<String> setCookies = headers.get("Set-Cookie");
            if (setCookies != null) {
                for (String sc : setCookies) {
                    CookieManager.getInstance().setCookie(url, sc);
                }
            }

            InputStream is = conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = is.read(buf)) != -1) {
                bos.write(buf, 0, n);
                total += n;
                if (total > 4 * 1024 * 1024) {
                    break;
                }
            }
            is.close();

            String charset = "utf-8";
            int csIdx = contentType.toLowerCase().indexOf("charset=");
            if (csIdx >= 0) {
                charset = contentType.substring(csIdx + 8).split(";")[0].trim();
            }
            String html = new String(bos.toByteArray(), charset);
            String injection = "<script>" + polyfillJs + "</script>";
            int headIdx = html.toLowerCase().indexOf("<head");
            if (headIdx >= 0) {
                int headEnd = html.indexOf('>', headIdx);
                html = headEnd > 0
                        ? html.substring(0, headEnd + 1) + injection + html.substring(headEnd + 1)
                        : injection + html;
            } else {
                html = injection + html;
            }

            Map<String, String> outHeaders = new HashMap<String, String>();
            for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                String k = e.getKey();
                if (k == null || e.getValue() == null || e.getValue().isEmpty()) {
                    continue;
                }
                if (k.equalsIgnoreCase("Content-Length") || k.equalsIgnoreCase("Content-Encoding")
                        || k.equalsIgnoreCase("Transfer-Encoding") || k.equalsIgnoreCase("Content-Type")) {
                    continue;
                }
                outHeaders.put(k, e.getValue().get(0));
            }
            String mime = contentType.split(";")[0].trim();
            android.util.Log.i("FlashApp", "inject ok " + url + " bytes=" + html.length());
            return new WebResourceResponse(mime, charset, 200, "OK", outHeaders,
                    new ByteArrayInputStream(html.getBytes(charset)));
        } catch (Throwable t) {
            android.util.Log.i("FlashApp", "inject fail " + url + " : " + t);
            return null;
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Throwable ignored) { }
            }
        }
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
    protected void onPause() {
        super.onPause();
        // 低内存设备上及时落盘 cookie，避免被回收
        CookieManager.getInstance().flush();
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
