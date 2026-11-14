#!/usr/bin/env python3
"""把腾讯云镜像下载的裸 SDK 包按 package path 还原目录，并生成 package.xml 元数据。"""
import os, shutil, subprocess, sys, datetime

SDK = "/opt/android-sdk"
ZIPDIR = "/tmp/sdk-zips"
STAGE = "/tmp/sdk-stage2"
MARK = "/workspace/.android-bootstrap/fast-stage"

def stage(msg):
    with open(MARK, "w") as f:
        f.write(f"STAGE:{msg} {datetime.datetime.now():%H:%M:%S}\n")
def fatal(msg):
    with open(MARK, "w") as f:
        f.write(f"FATAL:{msg} {datetime.datetime.now():%H:%M:%S}\n")
    sys.exit(1)

# zip 文件名 -> (包 path, 解压后顶层目录)
MAP = {
    "platform-tools_r37.0.3-linux.zip": ("platform-tools", "platform-tools"),
    "build-tools_r34-linux.zip": ("build-tools;34.0.0", "android-14"),
    "platform-34-ext12_r01.zip": ("platforms;android-34", "android-34-ext12"),
    "emulator-linux_x64-16863232.zip": ("emulator", "emulator"),
    "x86_64-30_r11.zip": ("system-images;android-30;default;x86_64", "x86_64"),
}

# 每个包的 package.xml 主体（localPackage），type-details 按缓存远程 XML 1:1 还原
NS = 'xmlns="http://schemas.android.com/repository/android/common/02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/03"'
PKGXML = {
"platform-tools": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<repository {NS}>
  <localPackage path="platform-tools" obsolete="false">
    <type-details xsi:type="genericDetailsType"/>
    <revision><major>37</major><minor>0</minor><micro>3</micro></revision>
    <display-name>Android SDK Platform-Tools</display-name>
    <uses-license ref="android-sdk-preview-license"/>
  </localPackage>
</repository>
''',
"build-tools;34.0.0": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<repository {NS}>
  <localPackage path="build-tools;34.0.0" obsolete="false">
    <type-details xsi:type="genericDetailsType"/>
    <revision><major>34</major><minor>0</minor><micro>0</micro></revision>
    <display-name>Android SDK Build-Tools 34</display-name>
    <uses-license ref="android-sdk-license"/>
  </localPackage>
</repository>
''',
"platforms;android-34": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<repository {NS}>
  <localPackage path="platforms;android-34" obsolete="false">
    <type-details xsi:type="platformDetailsType">
      <api-level>34</api-level>
      <layoutlib api="15"/>
    </type-details>
    <revision><major>1</major></revision>
    <display-name>Android SDK Platform 34-ext12</display-name>
    <uses-license ref="android-sdk-license"/>
  </localPackage>
</repository>
''',
"emulator": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<repository {NS}>
  <localPackage path="emulator" obsolete="false">
    <type-details xsi:type="genericDetailsType"/>
    <revision><major>37</major><minor>3</minor><micro>9</micro></revision>
    <display-name>Android Emulator</display-name>
    <uses-license ref="android-sdk-license"/>
  </localPackage>
</repository>
''',
"system-images;android-30;default;x86_64": f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<repository {NS}>
  <localPackage path="system-images;android-30;default;x86_64" obsolete="false">
    <type-details xsi:type="sys-img:sysImgDetailsType">
      <api-level>30</api-level>
      <base-extension>true</base-extension>
      <tag><id>default</id><display>Default Android System Image</display></tag>
      <abi>x86_64</abi>
    </type-details>
    <revision><major>11</major></revision>
    <display-name>Intel x86_64 Atom System Image</display-name>
    <uses-license ref="android-sdk-license"/>
  </localPackage>
</repository>
''',
}

def main():
    stage("py_extract")
    if os.path.exists(STAGE): shutil.rmtree(STAGE)
    os.makedirs(STAGE)
    for zname, (ppath, top) in MAP.items():
        zpath = os.path.join(ZIPDIR, zname)
        if not os.path.exists(zpath): fatal(f"missing_zip_{zname}")
        sd = os.path.join(STAGE, zname[:-4])
        os.makedirs(sd)
        r = subprocess.run(["unzip", "-q", zpath, "-d", sd], capture_output=True)
        if r.returncode != 0: fatal(f"unzip_{zname}")
        src = os.path.join(sd, top)
        if not os.path.isdir(src):
            # 容错：自动找含二进制的顶层目录
            subs = [d for d in os.listdir(sd) if os.path.isdir(os.path.join(sd, d))]
            if len(subs) == 1: src = os.path.join(sd, subs[0])
            else: fatal(f"toplevel_{zname} got={subs}")
        reltgt = ppath.replace(";", "/")
        tgt = os.path.join(SDK, reltgt)
        os.makedirs(os.path.dirname(tgt), exist_ok=True)
        if os.path.exists(tgt): shutil.rmtree(tgt)
        shutil.move(src, tgt)
        with open(os.path.join(tgt, "package.xml"), "w") as f:
            f.write(PKGXML[ppath])
        print(f"{zname} -> {tgt} (+package.xml)")
    stage("py_verify_layout")
    # 校验关键产物
    checks = [
        "platform-tools/adb", "build-tools/34.0.0/aapt2",
        "platforms/android-34/android.jar", "emulator/emulator",
        "system-images/android-30/default/x86_64/system.img",
        "system-images/android-30/default/x86_64/source.properties",
    ]
    for c in checks:
        p = os.path.join(SDK, c)
        if not os.path.exists(p): fatal(f"missing_{c}")
    stage("py_done")

if __name__ == "__main__":
    main()
