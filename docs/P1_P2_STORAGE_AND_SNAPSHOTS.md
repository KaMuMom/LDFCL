# P1 内容存储与 P2 快照

当前实现位于 `core/services/content-store.ts`、`instance-manifest.ts`、`snapshots.ts`，类型在 `shared/instance-storage.ts`；桌面端和 CLI 复用相同实现。

## 目录和完整性

```text
<程序目录>/LDFCL-data/store/
├── sha256/<前两位>/<SHA256>      # 内容对象
└── manifests/<实例路径摘要>.json # 去重统计索引
<Minecraft根>/versions/<版本目录>/
├── instance.json                # 实例设置与加载器信息
└── .ldfcl/
    ├── manifest.json            # schemaVersion: 1 的实例文件清单
    ├── cas-migration.json       # 首次迁移完成标记
    ├── migration-backups/<ID>/  # 首次迁移的独立原字节副本
    ├── snapshots/<ID>.json      # 快照记录，内容通过 CAS 复用
    └── transactions/<ID>/       # 发布阶段、原件和事务日志
```

`<Minecraft根>` 默认就是 `<程序目录>/.minecraft`。默认游戏根与业务配置根均由宿主指定；内容对象总是在启动器业务数据目录共享，不随当前游戏根切换而另建。

每个对象以本地流式计算的 SHA256 寻址；导入、物化、导出、回滚均验证实际字节，文件路径和摘要不等于下载源签名。拒绝路径越界、Windows 设备名/ADS、大小写别名、符号链接、junction 和特殊文件。目录及其祖先都接受检查。没有自动删除未引用对象的 GC，避免错误回收影响旧快照。

模组 JAR、客户端 JAR、资源包/光影 ZIP 被标记为不可变归档，优先使用只读硬链接；不支持硬链接或跨卷时复制，记录 `materialization` 和 `fallbackReason`。配置、options、实例 JSON、存档和其他可写数据始终复制。调用方需要原地编辑不可变归档时必须先执行 `ensurePrivateFile`；替换文件应使用阶段文件再调用 `replaceStorageFile`，兼容 Windows 只读目标。

硬链接不是 copy-on-write。外部工具强制去除只读属性再原地修改，仍可损坏同一 inode 上的 CAS/实例链接；读取时的 SHA256 校验会发现并拒绝使用。首次迁移的真实副本可用于 `rollbackMigration`，并可由独立原件修复已损坏 CAS；其他实例仍指向旧坏 inode 时需要分别修复。配置与存档没有这个共享写入风险。

统计的 `logicalBytes` 是登记清单中的引用总量，`storedBytes` 是 CAS 对象字节量，`deduplicatedBytes` 是相同摘要重复引用的逻辑节省量；它不是整块磁盘的实际节省量。初次原件备份、可写副本、跨卷副本和已经被共享的库文件均会影响实际磁盘占用。首次迁移备份只创建一次，不纳入后续常规快照或 manifest。

## 清单与离线包

清单记录实例信息、相对目录、每个文件的 SHA256/大小/可写策略、原始版本 JSON 恢复配方及共享依赖。日志、缓存、native、旧快照、迁移副本、私有操作记录和常见账号文件不进入清单。用户实例内的存档会进入完整清单，普通快照则始终排除存档。

递归处理版本继承，收集本地存在的父版本 JSON/JAR 与版本 JSON 声明的库依赖，包括没有公开下载 URL 的 patched JAR。现代 Forge/NeoForge 另有运行时动态发现、未写进 `libraries` 的安装器产物：清单根据继承后的 `--fml.mcVersion`、`neoFormVersion`/`mcpVersion`、`neoForgeVersion`/`forgeVersion` 参数，精确收集对应 Maven 坐标下的 Minecraft `extra/slim/srg` 与加载器 `client/universal` JAR，不复制整个共享缓存、其他版本、installer 或 `.cache` 文件。`exportBundle` 导出 `manifest.json + blobs/<前两位>/<SHA256>` 的独立目录，全部复制，不依赖原程序、原 CAS 或原游戏目录。`rebuildFromBundle` 先校验整个包，再导入内容对象、阶段重建实例并发布，恢复缺失共享库，已有共享文件摘要冲突时拒绝覆盖。

目标版本文件夹必须沿用原目录名称，已存在时拒绝覆盖；可在干净游戏根重建。这样同名版本 JSON、JAR、launch 指针和自定义继承关系保持一致。可靠公共来源的缺失 assets、库、客户端和 Java，仍由现有正常启动准备流程按原游戏配方补齐；这不是将整套运行环境封装为完全断网可玩的发行包。

`rebuildManifest` 更新可重建索引，不删除原件；首次 `migrate` 先完成并验证所有真实副本再切换归档链接，保存恢复标记。迁移中断时下次迁移先恢复原件，再重试。`rollbackMigration` 只恢复当初改变物化方式的不可变归档，保留迁移以后产生的可写配置和世界进度；不会把旧存档覆盖回去。

## 快照与回滚边界

固定包含 `mods`、`config`、`resourcepacks`、`shaderpacks`、`options.txt`、`optionsof.txt`、`optionsshaders.txt`、`servers.dat`、`instance.json`、`.ldfcl-content.json`。保存空目录、disabled 模组和来源元数据；CAS 复用相同字节。固定不回滚 saves、logs、screenshots、crash-reports、运行时、账号和迁移原件。

预览返回新增/删除/变更文件，以及当前内容的 `previewId`。执行前重新计算；若用户指定的预览已过期，拒绝覆盖。每次执行先创建“回滚前保护”快照，再完整物化阶段目录，最后按顶层范围逐项替换。事务日志记录原路径是否存在；中间步骤失败会恢复所有旧路径，旧快照与保护快照继续保留。恢复实例 JSON 后，宿主同步允许的实例字段到启动器 registry，避免下一次启动覆盖恢复的游戏设置。

每个实例的独占锁同时保护不同进程的操作。进程异常退出时，仅在 OS 确认旧 PID 已不存在（ESRCH）后接管锁，再恢复未完成事务。旧 PID 仍存活、已被重用或锁文件无效时保持阻止状态，避免猜测解锁造成并发覆盖。上层宿主仍必须阻止对运行中的游戏执行迁移和回滚。

## 验收

`tests/instance-storage.test.cjs` 使用独立 TEMP 文件夹和真实 Windows 文件系统，覆盖：CAS 摘要与去重、配置可写隔离、硬链接断开、无硬链接回退、迁移幂等与独立原件、全新 CAS 的 bundle 恢复及自定义 patched library、NeoForge 未声明的五种生成 JAR 恢复及其他版本/安装缓存排除、越界/别名/链接拒绝、损坏对象拒绝、快照配置与模组恢复、世界/日志保留、预览过期、发布第二步故障、保护快照、并发锁、真实子进程中断后的日志恢复、坏 CAS 原件修复和迁移中断重试。

这些离线验收不等同于 Microsoft 登录、所有加载器在线安装、真实游戏可玩性或特定第三方模组兼容性测试。
