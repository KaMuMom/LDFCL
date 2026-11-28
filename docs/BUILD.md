# 构建与部署

使用 Rustup 安装仓库锁定的 Rust 1.100.1。图形版基于 GPUI，使用 `Cargo.lock` 中的依赖版本。

```sh
cargo test --locked --no-default-features
cargo build --locked --release --bin LDFCL
```

图形程序位于 `target/release/`。Linux 开发环境需要 X11 或 Wayland、Vulkan 驱动、`xdg-desktop-portal` 和 `fontconfig`。Debian 系发行版可安装 `pkg-config`、`libfontconfig1-dev`、`libfreetype-dev`、`libx11-xcb-dev`、`libxcb1-dev`、`libxkbcommon-dev`、`libxkbcommon-x11-dev`、`libwayland-dev`、`libvulkan1` 和 `fonts-noto-cjk`。macOS 使用系统 Metal 和 Xcode 命令行工具。

Windows 使用 `x86_64-pc-windows-msvc` 和 Windows SDK。构建图形版时将 `GPUI_FXC_PATH` 指向 SDK 的 x64 `fxc.exe`。GitHub Actions 使用 Inno Setup 打包并验证 Windows x64 安装程序。

## 安装与迁移

Windows 安装向导提供简体中文和英文。可新建游戏目录，也可选择 PCL 或 HMCL 的 `.minecraft` 或其上级目录。

```text
LDFCL/
├── LDFCL.exe
├── Uninstall.exe
├── config/        用户设置和游戏目录配置
├── cache/         启动器缓存，首次运行时创建
└── runtime/       命令行程序、卸载程序和许可证
```

安装后从根目录运行 `LDFCL.exe`。首次启动会导入已有设置。复制整个安装目录可以带走配置和缓存，安装目录内的 Java 和游戏路径随目录移动。外部路径继续指向原位置。全新安装默认使用 `%LOCALAPPDATA%\LDFCL\game`。升级和卸载保留游戏数据和配置。

启动器在后台扫描本地 Java。自动模式按游戏版本要求匹配 Java，手动模式点击选择栏展开版本和路径。可用「手动添加 Java」添加可执行文件。游戏输出保存在游戏目录的 `ldfcl-launch.log`。

## 命令行版

```sh
cargo build --locked --release --no-default-features --bin ldfcl-cli
./target/release/ldfcl-cli list --game-dir "/path/to/.minecraft"
./target/release/ldfcl-cli launch 1.21.1 --game-dir "/path/to/.minecraft" --java "/path/to/jdk-21/bin/java"
```

桌面版和命令行版都支持启动依赖齐全的本地游戏版本。自动隔离读取 PCL 的版本隔离设置和 HMCL 的实例目录标记。隔离实例使用自己的存档和模组目录，读取游戏根目录下共享的资源和库。需额外安装或修补的加载器及 HMCL 外部自定义运行路径由相应启动器管理。 [HMCL 版本隔离说明](https://docs.hmcl.net/launcher/isolation.html)
