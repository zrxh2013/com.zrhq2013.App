@echo off
REM Android APK 生成脚本 (Windows 版本)
REM 作者：灵光助手
REM 包名：com.zrhq2013.app

setlocal enabledelayedexpansion

echo ==========================================
echo       ^>^> 灵光 WebView APK 生成工具 ^<^<
echo ==========================================
echo.

REM --- 配置区域 ---
set PACKAGE_NAME=com.zrhq2013.app
set LAUNCH_URL=https://www.lingguang.com/share/CHAT-27eb3584-c60f-40ff-a042-ba5a820de81550?sharemedium=others
set APK_OUTPUT_DEBUG=app\build\outputs\apk\debug\app-debug.apk
REM ----------------

REM 检查 gradle 是否可用
if not exist "gradlew.bat" (
    echo 错误: 找不到 gradlew.bat，请确保在 Android 项目根目录运行此脚本！
    exit /b 1
)

echo 清理旧构建文件...
gradlew.bat clean > nul 2>&1

echo.
echo 开始编译 Debug APK (这可能需要 1-2 分钟)...
echo.
gradlew.bat assembleDebug

REM 检查是否成功
if exist "%APK_OUTPUT_DEBUG%" (
    echo.
    echo ✅ ======================================
    echo    APK 编译成功！
    echo    文件路径: %cd%\%APK_OUTPUT_DEBUG%
    echo ======================================
    echo.

    REM 检查 ADB 和设备
    where adb >nul 2>&1
    if errorlevel 1 (
        echo 未检测到 ADB 命令，请手动安装 APK
        exit /b 0
    )

    echo 检测到 ADB，正在查询连接的设备...
    adb devices
    echo.
    echo 准备自动安装...
    echo.

    REM 安装 APK
    adb install -r "%APK_OUTPUT_DEBUG%"
    
    if errorlevel 0 (
        echo.
        echo 正在启动应用...
        adb shell am start -n "%PACKAGE_NAME%/.MainActivity"
        echo.
        echo ✅ 应用已成功安装并打开！
    ) else (
        echo.
        echo 安装失败，可能设备未授权或签名冲突
    )
) else (
    echo.
    echo 错误: APK 编译失败，请检查 Android Studio 中的报错信息
    exit /b 1
)

pause
