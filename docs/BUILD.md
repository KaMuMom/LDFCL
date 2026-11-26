# 构建与部署

## 构建图形版

需要 CMake 3.24+、Qt 6.8+（Qt Quick、Quick Controls、Quick Dialogs）及与 Qt SDK 匹配的 C++ 编译器。可将 Qt SDK 加入 CMake 的标准包搜索路径，或使用 SDK 自带的 `qt-cmake`。首次构建会从 GitHub 获取 nlohmann/json 和 miniz，并验证 SHA-256。

```sh
qt-cmake -S . -B out
cmake --build out --config Release
ctest --test-dir out -C Release --output-on-failure
```

单配置生成器的 Linux 图形程序位于 `out/ui/LDFCL`。Windows 使用 `cmake --install out --config Release --prefix "$PWD/package"` 部署后，运行 `package/bin/LDFCL.exe`。安装脚本会部署所需的 Qt 库、平台插件和 QML 模块。

首次启动时，从「游戏目录」选择已安装 Minecraft 的目录。然后选择版本和兼容的 `java`、`java.exe` 或 `javaw.exe`，点击「启动游戏」。默认目录随系统选择，Java 会尝试从 `JAVA_HOME` 或 `PATH` 查找。Java 的输出保存在游戏目录中的 `ldfcl-launch.log`。

## 命令行版

命令行与桌面版共用启动核心。只构建命令行时无需安装 Qt。

```sh
cmake -S . -B out-cli -DLDFCL_BUILD_GUI=OFF
cmake --build out-cli
./out-cli/ldfcl-cli list --game-dir "/path/to/.minecraft"
./out-cli/ldfcl-cli launch 1.21.1 --game-dir "/path/to/.minecraft" --java "/path/to/jdk-21/bin/java"
```

游戏客户端、资源及依赖需由官方启动器预先安装。当前支持独立原版版本的离线启动。正版登录、下载安装和需要继承版本元数据的模组加载器留待后续开发。
