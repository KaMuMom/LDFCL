# 构建与部署

## 构建图形版

需要 CMake 3.24+、Qt 6.8+（Qt Quick、Quick Controls、Quick Dialogs）及与 Qt SDK 匹配的 C++ 编译器。可将 Qt SDK 加入 CMake 的标准包搜索路径，或使用 SDK 自带的 `qt-cmake`。首次构建会从 GitHub 获取 nlohmann/json 和 miniz，并验证 SHA-256。

```sh
qt-cmake -S . -B out
cmake --build out --config Release
ctest --test-dir out -C Release --output-on-failure
```

单配置生成器的 Linux 图形程序位于 `out/ui/LDFCL`。Windows 使用 `cmake --install out --config Release --prefix "$PWD/package"` 部署后，运行 `package/bin/LDFCL.exe`。安装脚本会部署所需的 Qt 库、平台插件和 QML 模块。

Windows 安装程序可以创建空游戏目录，或直接使用已有的 PCL／HMCL 游戏目录。选择包含 `versions` 的 `.minecraft`，也可选择它所在的启动器文件夹。安装和卸载都保留已有游戏文件。游戏目录、Java 路径和隔离方式位于「设置」。首页提供版本下拉框和启动按钮。Java 会尝试从 `JAVA_HOME` 或 `PATH` 查找，输出保存在游戏目录中的 `ldfcl-launch.log`。

## 命令行版

命令行与桌面版共用启动核心。只构建命令行时无需安装 Qt。

```sh
cmake -S . -B out-cli -DLDFCL_BUILD_GUI=OFF
cmake --build out-cli
./out-cli/ldfcl-cli list --game-dir "/path/to/.minecraft"
./out-cli/ldfcl-cli launch 1.21.1 --game-dir "/path/to/.minecraft" --java "/path/to/jdk-21/bin/java"
```

原版和具备完整本地依赖的继承版本均可列出，启动时使用离线身份。自动隔离读取 PCL 的实例隔离设置与 HMCL 的实例目录标记，并参考实例中的存档、模组和资源包。隔离实例从自身目录运行，同时共享游戏根下的 `assets` 和 `libraries`。HMCL 配置中的外部自定义运行路径和需要额外安装或修补的加载器不在当前兼容范围。目录说明参见 [HMCL 全局版本隔离](https://docs.hmcl.net/launcher/isolation.html)。
