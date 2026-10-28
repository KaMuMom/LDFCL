# P0：核心层解耦与 CLI

> 历史阶段记录：本文记录 2026-10-22 基于 0.5.0 完成 P0 时的架构与边界。当前 0.6.0 已继续实现 P1–P6，并新增会迁移和写配置的高级 CLI。完整当前命令以 [CLI 使用说明](CLI.md) 为准；manifest/CAS 与快照边界见 [P1/P2 实现说明](P1_P2_STORAGE_AND_SNAPSHOTS.md)。本文所述“两种只读 CLI”专指 `instance list`、`java list`。

日期：2026-10-22。基于 0.5.0，保持原有界面、IPC 方法和业务数据格式。

## 结构与职责

```text
React 页面 → preload → Electron IPC → @ldfcl/core
CLI（Node.js）                     → @ldfcl/core
                                      ↓
                           游戏 / 账号 / 下载 / 本地文件
```

- `core/` 是独立的 npm workspace 包 `@ldfcl/core`，运行依赖仅 `adm-zip`，不导入 Electron、preload 或 React。根目录的 `shared/` 继续存放纯类型和共享规则，构建时一起编入核心包。
- `core/launcher.ts` 接管原主进程中的业务调度：实例、目录切换事务、并发锁、账号选择、安装、启动、Mod 和皮肤操作。
- `core/services/` 保留现有服务实现；目录扫描、版本隔离、存储和迁移工具也移入核心包。旧 `electron/services/` 与业务工具文件已移除。
- `electron/main.ts` 只负责桌面生命周期、窗口、IPC 来源检查及错误脱敏，并把原生能力传给核心。
- `core/host.ts` 定义文件选择、保存、回收站、打开目录/浏览器、图像解码和窗口操作接口，不引用 Electron 类型。
- `core/ports.ts` 定义 `SecretStorage`。桌面宿主注入原来的 `safeStorage`；无加密适配器时不持久保存令牌。
- `cli/main.ts` 使用相同的 Store、目录规则和 Java 探测服务，提供两个只读命令。

核心包可单独检查/编译：

```powershell
npm ci
npm run build --workspace @ldfcl/core
```

完整构建会先清理旧 `dist-electron`，避免已经迁走的业务代码残留在发行包内。

## CLI

需要 Node.js 22 或更新版本。源码目录执行：

```powershell
npm run build:main
node .\bin\ldfcl-cli.cjs instance list
node .\bin\ldfcl-cli.cjs java list --json
```

指定已有便携启动器的位置：

```powershell
node .\bin\ldfcl-cli.cjs instance list --program-dir "D:\游戏\LDFCL" --json
```

实例列表不扫描、迁移或写入游戏目录；Java 列表只执行本地探测，不下载运行库。两个命令不加载账号服务、不解密凭据、不改写配置。损坏配置会明确报错。

参数、JSON 字段和退出码见 [CLI 使用说明](CLI.md)。

## 兼容约束

- `launcher.json`、`accounts.json` 及加密字段格式不变；桌面仍使用原 Electron 用户配置中的系统密钥。
- 默认 `.minecraft` 和 `LDFCL-data` 仍位于外部便携 EXE 旁；实例目录规则不变。
- 目录选择器和文件选择器等待期间的操作锁保留，目录失败回滚、实例删除引用检查和系统回收站保留。
- Microsoft 设备授权的取消世代、迟到响应保护和浏览器打开失败处理保留。
- 原有进度事件、账号公开数据过滤、皮肤库校验、导入/导出和上传边界保留。
- `Store.load({ readOnly: true })` 是新增的读取选项；桌面默认 `load()` 的行为不变。旧格式在 CLI 中只进行内存映射，不写回迁移。

## 本次范围

P0 交付时提供后续扩展所需的核心包与两个只读 CLI 入口，尚未包含 P1–P6。这是当时的阶段范围，不是当前版本的功能清单。后续 manifest、内容寻址存储、快照、健康扫描、崩溃诊断及下载体验扩展现已继续落地，具体可用入口与限制见上方当前文档链接。

本次验证结果会补充到 [VALIDATION.md](../VALIDATION.md)。真实 Microsoft 授权、外观变更和 Minecraft 游戏内兼容性仍需单独验证。
