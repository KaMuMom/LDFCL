# LDFCL CLI

CLI 在普通 Node.js 中复用 `@ldfcl/core`，包含当前 P0–P6 已接入命令行的功能。需要 Node.js 22 或更新版本、构建产物和项目生产依赖；它不加载 Electron。普通桌面便携 EXE 不是独立 Node CLI 运行环境。

## 构建与调用

```powershell
npm ci
npm run build
node .\bin\ldfcl-cli.cjs --help
node .\bin\ldfcl-cli.cjs --version --json
```

编译入口为 `dist-electron/cli/main.js`，`bin/ldfcl-cli.cjs` 是启动文件。完成 npm 本地链接或安装相应包后也可使用 npm bin 名 `ldfcl-cli`。下方示例从源码项目根目录执行；含中文和空格的路径加引号。

## 路径、输出与并发边界

| 选项                   | 行为                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `--json`               | 标准输出为 JSON，错误 JSON 写入标准错误；无此选项时列表为表格，高级命令仍输出 JSON |
| `--program-dir <路径>` | 指定桌面启动器所在目录，默认 CLI 项目/包目录                                       |
| `--data-dir <路径>`    | 含 `launcher.json` 的业务配置目录，默认 `<程序目录>/LDFCL-data`                    |
| `--game-root <路径>`   | 指定 `.minecraft` 根目录；列表用于筛选，高级命令会登记并选择此根目录               |
| `--help` / `-h`        | 显示命令帮助                                                                       |
| `--version` / `-v`     | 显示产品版本                                                                       |

路径允许相对路径，按当前工作目录解析，也可使用 `--data-dir=路径`。兼容 `LDFCL_DATA_DIR`、`LDFCL_GAME_ROOT` 环境变量，显式选项优先。只指定配置目录时，沿用 core 的默认规则，默认游戏根为 `<配置目录>/.minecraft`；两项都不指定时默认 `<程序目录>/.minecraft`。

`instance list`、`java list` 使用 `Store.load({ readOnly: true })`。不创建业务数据目录、不备份或覆盖损坏配置、不迁移实例、不扫描新实例、不加载账号服务、不下载游戏或 Java。`java list` 会执行本地 Java 版本探测。缺少配置时实例列表为空；损坏配置报错并保留原件。

其他高级命令除了只比较两个文件的 `instance diff` 外，会初始化完整 core，可能登记游戏根、准备旧版本布局并扫描版本、更新 `launcher.json` 与实例元数据。即使是 `store stats`、`snapshot list` 或 `ai settings` 查询，也不能当成完全无写入的操作。请先关闭 GUI，再运行会初始化 core 的高级 CLI；不同进程的实例存储锁不能代替整个启动器 registry 的并发写入控制。这些命令不提供账号登录、启动游戏或通用任意脚本执行入口。

```powershell
node .\bin\ldfcl-cli.cjs instance list --json --program-dir "D:\游戏\LDFCL"
node .\bin\ldfcl-cli.cjs java list --json --game-root "E:\我的世界\.minecraft"
```

## 实例与 Java 列表

| 命令            | 输出                                                              |
| --------------- | ----------------------------------------------------------------- |
| `instance list` | 所有已登记游戏根中的实例；`--game-root` 仅筛选，不登记未知目录    |
| `java list`     | 当前根或指定根的 runtime、环境变量及常见本地 Java；不调用自动安装 |

实例 JSON 含 `command`、`dataDir`、`gameDirectories`、`instances`；实例仅列出 ID、名称、MC/加载器版本、真实目录、选中状态和 `pendingMigration` 等字段。旧实例仍在 `instances/<ID>` 时显示旧真实目录并标记待迁移，不在列表命令里移动它。不存在的已登记目录仍可显示，列表不等同于健康检查。

Java JSON 含 `command`、`dataDir`、`gameRoot`、`runtimeDataDir`、`java`；Java 项含路径、主版本、完整版本，以及已识别的架构和 Java home。探测仅应针对可信的本地 Java 安装。

## 清单、内容存储与重建

```powershell
node .\bin\ldfcl-cli.cjs instance manifest <实例ID> --json --data-dir "D:\LDFCL\LDFCL-data"
node .\bin\ldfcl-cli.cjs instance manifest <实例ID> --output "D:\导出\instance.manifest.json" --json
node .\bin\ldfcl-cli.cjs instance manifest <实例ID> --bundle "D:\导出\我的整合包" --json
node .\bin\ldfcl-cli.cjs instance diff "D:\导出\before.json" "D:\导出\after.json" --json
node .\bin\ldfcl-cli.cjs store stats --json
```

`instance manifest` 更新并返回实例清单；`--output` 写 JSON，`--bundle` 创建不存在的新目录，导出 `manifest.json + blobs/<前两位>/<SHA256>`。清单含实例元数据、相对文件路径、摘要、可写策略、版本恢复配方与本地共享库引用。常见账号文件、日志、缓存、native、快照和迁移副本被排除。完整清单可包含用户存档。

`instance diff` 只读取两个 JSON 清单，返回 `added`、`removed`、`changed`、`unchanged`，不初始化 core。`store stats` 返回 CAS 对象数、对象字节数、逻辑引用量、重复引用的逻辑节省量及物化统计。逻辑去重量不是总磁盘实际节省量；首次备份和可写副本另占空间。

```powershell
# 同一 CAS 存储内，用轻量 JSON 清单重建；目标游戏根必须没有同名版本。
node .\bin\ldfcl-cli.cjs instance rebuild --file "D:\导出\instance.manifest.json" --game-root "E:\干净游戏根" --json

# 跨机或新配置目录，用包含真实 blobs 的独立清单包。
node .\bin\ldfcl-cli.cjs instance rebuild --bundle "D:\导出\我的整合包" --data-dir "E:\新启动器\LDFCL-data" --game-root "E:\新启动器\.minecraft" --json
```

单个 manifest JSON 只有索引，必须能从当前 `<data-dir>/store` 找到所引用的全部对象；不能把它当成跨机完整备份。Bundle 含实例内容和已存在的共享库、父版本 JSON/JAR，可在没有旧 CAS 的目录恢复，包括没有公开下载地址的 patched libraries。选择清单包内的 `manifest.json` 时，也能自动识别同级 `blobs`。

重建保留原版本目录名称和 JSON/JAR 引用，创建新的启动器实例 ID；目标已存在时明确拒绝覆盖。可用 `--name <名称>` 修改显示名称。外来 Java 可执行路径会被清空，实例游戏设置和 JVM 参数经过允许范围校验。缺失的公共 assets、库、客户端与 Java 仍由正常启动准备流程补齐，因此清单包不承诺完全断网即可运行。

存储、迁移、硬链接和恢复边界详见 [P1/P2 实现说明](P1_P2_STORAGE_AND_SNAPSHOTS.md)。

## 快照、差异和回滚

```powershell
node .\bin\ldfcl-cli.cjs snapshot create <实例ID> --name "更新 Mod 前" --json
node .\bin\ldfcl-cli.cjs snapshot list <实例ID> --json
node .\bin\ldfcl-cli.cjs snapshot diff <实例ID> --snapshot <快照ID> --json
node .\bin\ldfcl-cli.cjs snapshot restore <实例ID> --snapshot <快照ID> --json
node .\bin\ldfcl-cli.cjs snapshot restore <实例ID> --snapshot <快照ID> --apply --json
```

`restore` 默认只预览；只有 `--apply` 才执行。预览含文件差异、`previewId` 和保留范围。CLI 的独立 `--apply` 调用会重新读取当前状态；当前 CLI 没有跨进程传入 `previewId` 的选项。需要绑定同一次预览再执行的交互可在 GUI 完成。

快照固定包含 mods、config、resourcepacks、shaderpacks、options 系列、servers.dat、instance.json、`.ldfcl-content.json`。回滚保留 saves、logs、截图、崩溃报告、账号、运行时和迁移原件。执行前自动创建“回滚前保护”快照，阶段发布失败会恢复旧路径。恢复后的实例允许字段同步回 registry，避免下一次启动覆盖已恢复设置。不要对运行中的游戏执行此操作。

## 健康扫描与自动修复

```powershell
node .\bin\ldfcl-cli.cjs health scan <实例ID> --json
node .\bin\ldfcl-cli.cjs health fix <实例ID> --auto --json
```

扫描返回分数、问题、严重性、依据、建议和可自动修复类型，检查本地版本/文件、Java、内存、重复 Mod 与必需前置存在性。扫描算法不联网或自动修复，但 CLI 初始化及报告保存仍会写业务数据。

`health fix` 必须显式 `--auto`；执行前创建保护快照，记录修复结果并重新扫描。当前自动处理包括恢复自动内存、清除不合适的自定义 Java 路径、启用已存在但 disabled 的必需前置；不会随意删除模组，不代替加载器的依赖版本范围/冲突判定，也不在此命令中自动下载安装缺失游戏文件。未支持的问题继续显示。

## 崩溃诊断

```powershell
node .\bin\ldfcl-cli.cjs diagnose <实例ID> --json
node .\bin\ldfcl-cli.cjs diagnose <实例ID> --file "D:\日志\crash-report.txt" --json
```

不带 `--file` 时列出该实例已保存的诊断；带文件时导入本地日志并使用规则诊断，保存脱敏报告。诊断含分类、规则依据、建议、疑似 Mod 与置信度；没有证据时保留未知结论。规则诊断本身不需要 AI 或网络。CLI 没有单独的日志分享上传命令。

## AI 命令（0.6.1 暂停）

AI 仅保留桌面禁用界面。ai settings / diagnose / configure 均在初始化核心之前明确拒绝，不读取 AI 配置、密钥或 LDFCL_AI_API_KEY，不发送请求，也不修改账号或游戏设置。上一版接口与实现保留在历史 P0–P6 文档中。

## 当前 CLI 范围和退出码

命令行覆盖 P0 列表、P1 清单/CAS、P2 快照、P3 健康、P4 本地诊断、P5 静态占位（AI 命令暂停）。P6 的资源包/光影管理、NeoForge 安装、分片下载控制、预设与主题由桌面端提供；CLI 没有对应下载、安装、启动或主题修改命令。

成功退出 `0`；未知命令、未知选项、缺少选项值等参数错误退出 `2`；文件/业务错误（含高级命令缺少所需业务参数）退出 `1`。使用 `--json` 时错误形如 `{"error":{"code":"…","message":"…"}}`，写入 stderr；以退出码判断成功，不要只检查 stdout 是否存在。

自动化示例保留账号、真实世界和网络授权边界：离线测试使用独立 TEMP 数据根和合成实例，不代表已验证 Microsoft 登录、第三方模型连通性或所有整合包的游戏可玩性。
