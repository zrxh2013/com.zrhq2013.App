# 闪应用 Android WebView APK

本项目是一个完整的 Android WebView 应用，用于将闪应用打包成 APK 安装包。

## 项目结构

```
com.zrhq2013.App/
├── app/
│   ├── src/main/
│   │   ├── java/com/zrhq2013/app/
│   │   │   └── MainActivity.java           # 主活动类
│   │   ├── res/
│   │   │   ├── layout/
│   │   │   │   ├── activity_main.xml       # 主布局
│   │   │   │   └── progress_bar.xml        # 进度条
│   │   │   ├── drawable/
│   │   │   │   ├── progress_drawable.xml   # 进度条样式
│   │   │   │   └── splash_background.xml   # 启动页背景
│   │   │   ├── values/
│   │   │   │   ├── strings.xml             # 字符串资源
│   │   │   │   ├── colors.xml              # 颜色资源
│   │   │   │   └── styles.xml              # 样式资源
│   │   │   ├── xml/
│   │   │   │   └── network_security_config.xml  # 网络安全配置
│   │   │   └── mipmap-*/
│   │   │       └── ic_launcher.png         # 应用图标
│   │   └── AndroidManifest.xml             # 应用清单
│   ├── build.gradle                         # 应用级构建配置
│   └── proguard-rules.pro                   # 代码混淆规则
├── build.gradle                             # 项目级构建配置
├── settings.gradle                          # 项目设置
└── gradle.properties                        # Gradle 属性
```

## 功能特性

- ✅ WebView 核心实现
- ✅ JavaScript 支持
- ✅ 文件上传下载
- ✅ 进度条显示
- ✅ 返回按钮处理
- ✅ 网络安全配置
- ✅ 代码混淆优化
- ✅ 缓存管理
- ✅ 媒体播放支持

## 快速开始

### 1. 环境要求

- Android Studio 2023.1 或更高版本
- JDK 11 或更高版本
- Android SDK 24-34
- Gradle 8.1 或更高版本

### 2. 项目配置

#### 2.1 修改应用 URL

打开 `app/src/main/java/com/zrhq2013/app/MainActivity.java`，修改以下内容：

```java
private static final String APP_URL = "https://your-app-url.com";
```

替换为你的闪应用链接。

#### 2.2 修改网络安全配置

打开 `app/src/main/res/xml/network_security_config.xml`，修改域名配置：

```xml
<domain includeSubdomains="true">your-app-domain.com</domain>
```

#### 2.3 添加应用图标

将应用图标放到以下目录：
- `app/src/main/res/mipmap-ldpi/ic_launcher.png` (36x36)
- `app/src/main/res/mipmap-mdpi/ic_launcher.png` (48x48)
- `app/src/main/res/mipmap-hdpi/ic_launcher.png` (72x72)
- `app/src/main/res/mipmap-xhdpi/ic_launcher.png` (96x96)
- `app/src/main/res/mipmap-xxhdpi/ic_launcher.png` (144x144)
- `app/src/main/res/mipmap-xxxhdpi/ic_launcher.png` (192x192)

### 3. 编译和打包

#### 3.1 使用 Android Studio

1. 打开 Android Studio
2. 选择 **File → Open** 打开项目
3. 等待 Gradle 同步完成
4. 选择 **Build → Generate Signed Bundle/APK**
5. 选择 **APK**
6. 创建或选择签名密钥
7. 选择 **release** 版本
8. 点击 **Finish** 开始打包

#### 3.2 使用命令行

```bash
# 生成签名密钥（仅第一次需要）
keytool -genkey -v -keystore my-release-key.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias my-key-alias

# 编译 Release APK
./gradlew clean assembleRelease

# 生成的 APK 位于：
# app/build/outputs/apk/release/app-release.apk
```

### 4. 签名密钥管理

创建签名密钥文件 `key.properties` 在项目根目录：

```properties
storeFile=../my-release-key.keystore
storePassword=your-password
keyAlias=my-key-alias
keyPassword=your-password
```

然后在 `app/build.gradle` 中配置：

```gradle
signingConfigs {
    release {
        storeFile file(keystoreProperties['storeFile'])
        storePassword keystoreProperties['storePassword']
        keyAlias keystoreProperties['keyAlias']
        keyPassword keystoreProperties['keyPassword']
    }
}

buildTypes {
    release {
        signingConfig signingConfigs.release
        // ...
    }
}
```

## 权限说明

应用请求的权限及用途：

| 权限 | 用途 |
|------|------|
| INTERNET | 加载网页内容 |
| ACCESS_NETWORK_STATE | 检测网络状态 |
| READ_EXTERNAL_STORAGE | 读取文件用于上传 |
| WRITE_EXTERNAL_STORAGE | 下载文件保存 |
| CAMERA | 网页中使用摄像头 |
| RECORD_AUDIO | 网页中录制音频 |
| ACCESS_FINE_LOCATION | 网页中获取位置信息 |
| ACCESS_COARSE_LOCATION | 获取粗略位置 |
| READ_MEDIA_* | Android 13+ 读取媒体文件 |

## 常见问题

### Q1: APK 加载缓慢
A: 检查网络连接，或在 `MainActivity.java` 中设置本地缓存：
```java
settings.setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
```

### Q2: HTTPS 证书错误
A: 在 `network_security_config.xml` 中配置信任的域名。

### Q3: JavaScript 功能不工作
A: 确保在 WebSettings 中启用了 JavaScript：
```java
settings.setJavaScriptEnabled(true);
```

### Q4: 文件上传不工作
A: 检查应用是否有 READ_EXTERNAL_STORAGE 权限，并在 Android 6.0+ 上实现运行时权限请求。

### Q5: 应用在某些设备上崩溃
A: 检查 `minSdk` 和 `targetSdk` 版本兼容性，查看 logcat 错误日志。

## 性能优化

1. **代码混淆**：启用 ProGuard 混淆减小 APK 大小
2. **资源压缩**：启用资源压缩移除未使用资源
3. **缓存管理**：合理配置 WebView 缓存策略
4. **内存管理**：及时销毁 WebView 释放内存

## 安全建议

1. ✅ 使用 HTTPS 协议
2. ✅ 配置网络安全策略
3. ✅ 禁用调试模式
4. ✅ 启用代码混淆
5. ✅ 验证 SSL 证书
6. ✅ 限制 JavaScript 接口权限

## 技术栈

- **最低 API 级别**：24 (Android 7.0)
- **目标 API 级别**：34 (Android 14)
- **构建工具**：Gradle 8.1
- **Android X**：已启用
- **ProGuard**：已启用

## 许可证

MIT License - 详见 LICENSE 文件

## 支持

如有问题或建议，请提交 Issue 或 Pull Request。

## 更新日志

### v1.0 (2024-06-13)
- ✅ 初始版本发布
- ✅ WebView 核心功能
- ✅ 完整的构建配置

---

**最后更新**：2024-06-13  
**维护者**：zrxh2013
