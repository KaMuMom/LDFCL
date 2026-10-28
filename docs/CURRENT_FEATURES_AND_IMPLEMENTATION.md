# LDFCL 当前功能与实现方式

更新：2026-10-28，当前版本 **0.6.4**。本版面向入门电脑优化界面：默认流畅模式、按需 3D 皮肤渲染、页面延迟加载、后台事件合并，以及每页 50 项的 Mod/版本列表。保留旧实例自动关联、默认中文、Steve 和 GitHub 更新等功能。见 [性能与发行说明](0.6.4_RELEASE.md)、[0.6.3 说明](0.6.3_RELEASE.md)、[微软登录配置](0.6.2_BETA_LOGIN.md)、[启动修复](0.6.1_STARTUP_FIX.md)、[P0–P6](P0_P6_IMPLEMENTATION.md)、[CLI](CLI.md) 与 [验证记录](../VALIDATION.md)。

## 架构

| 层   | 实现                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| UI   | React 19、TypeScript、Vite、liquid-glass-react；保留 Dock、皮肤/账号、版本/启动区及左右实例布局；1120×760 默认、960×640 紧凑窗口 |
| 桌面 | Electron 39；隔离 preload、IPC 来源校验；窗口/浏览器/对话框/回收站/系统密钥适配                                                  |
| 核心 | 无 Electron 依赖的 `@ldfcl/core`；业务编排、账号、内容、下载、Java、安装、启动、皮肤和 P1–P6 服务                                |
| CLI  | 普通 Node 运行；两个只读列表及清单、快照、健康、诊断命令；本地诊断命令                                                            |
| 数据 | EXE 旁 `LDFCL-data` 与 `.minecraft`，用户可登记任意现有 Minecraft 根；配置兼容旧版                                               |
| 发行 | Windows x64 便携 EXE、完整源码 ZIP；Electron 随程序附带，游戏 Java 按需补齐                                                      |

React 调用 preload → Electron 注入 Host 的核心 → 文件/API/游戏进程 → 事件回到 UI。CLI 使用同一核心；只读列表单独加载 Store 的只读模式，不加载账号或网络。可写 CLI 和 GUI 应分开运行。

## 已实现功能

| 功能           | 实现方式与边界                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正版账号       | 系统浏览器打开 Microsoft 设备代码授权页；按服务端间隔轮询，取消/到期停止；Xbox → XSTS → Minecraft token → 权益和档案；需要用户配置获准 Client ID          |
| 离线账号       | 本地生成稳定身份，快速切换；不提供正版权益                                                                                                                |
| 其他皮肤站     | Yggdrasil 兼容认证；按需下载 authlib-injector 并以 Java agent 启动；不收集 Microsoft 密码                                                                 |
| 账号生命周期   | 启动前刷新所需令牌、持久化和安全脱敏；旧账号/配置首次迁入保留原件；已有新目录不重导入已删除账号                                                           |
| 程序更新       | 启动后检查 GitHub Latest 正式版本；校验大小与 SHA-256 下载；Windows x64 便携版退出替换、保留旧 EXE 和数据；设置内手动检查 |
| 多游戏根       | 注册、选择、重扫、打开和移除登记；移除登记保留文件；已有原版/Fabric/Forge/OptiFine 等版本可发现                                                           |
| 版本隔离       | `.minecraft/assets`、`libraries` 共享；每版本在 `versions/<目录>` 使用独立 `mods/config/saves/resourcepacks/shaderpacks/options/logs`；校验目录与链接边界 |
| Minecraft 安装 | 官方清单与校验和；Vanilla、Fabric、Quilt、Forge、NeoForge、OptiFine；隔离阶段安装避免覆盖既有世界；自动补库、assets、native                               |
| Java / 内存    | 本地 Java 主版本及架构探测，选择匹配版本或下载校验运行时；自动内存及单实例覆盖；受限额外 GC 参数                                                          |
| Mod 下载       | Modrinth 搜索、中文常用名称/简介、目标版本和发行版本选择；递归必需前置；已有兼容文件复用；稳定 artifact 缓存                                              |
| Mod 管理       | ID/提供 ID、哈希检测重复；启停、导入、删除、更新检查及应用；来源元数据与 `.trash` 保留；常用 Mod 收藏                                                     |
| 整合包         | 选择发行版本、MC/加载器筛选、下载 `.mrpack` 或本地导入；校验哈希和路径，完成依赖后注册隔离实例                                                            |
| 资源包 / 光影  | 安装到选定版本；实例页启停/排序资源包；选择 Iris/Oculus/OptiFine 光影；删除进入 `.trash`；缺少渲染器有提示                                                |
| 下载控制       | 有界并发队列；进度、暂停/继续/取消；Range + `.part.meta`；验证器改变/无Range时重新下载，校验后发布                                                        |
| 镜像           | 全局与单任务 official/BMCLAPI；只映射公开游戏资源域名，失败官方回退；单任务切换在下一文件/尝试生效                                                        |
| 游戏选项       | 启动前编辑；缺失语言默认简体中文并保留已有选择；通用设置可选启用、实例覆盖；保留不受管 options 字段；四档预设                                                              |
| 皮肤 / 披风    | skinview3d 预览、本地 PNG 试穿、64×64 UV 编辑/擦除/撤销/导出、经典/纤细；正版皮肤上传/恢复、已拥有披风启停                                                |
| 保存皮肤库     | 本地导入、命名、预览、重命名、导出、删除及明确应用正版账号；未登录可管理；PNG 与索引校验、原子持久化                                                      |
| 实例清单 / CAS | SHA-256 内容寻址、归档只读硬链接/复制回退、可写文件隔离、原件备份；清单差异、独立 bundle、干净目录重建                                                    |
| 实例快照       | 修改/启动写选项前自动保存；手动创建/列表；预览差异、过期拒绝、保护快照、事务恢复；保留世界和日志                                                          |
| 健康检查       | 启动前及手动扫描；Java、必需 Mod ID、内存、历史警告；评分JSON、徽标、问题与建议；自动修复有限项目并留日志                                                 |
| 日志 / 诊断    | 每实例最近500行及复制；捕获本次崩溃文件，规则给出原因、置信度、证据、可疑模组和可执行建议；支持导入报告                                                   |
| 外观           | 浅色、深色、实时跟随系统；默认流畅模式保留渐变/高光/圆角，视觉优先可启用 liquid-glass-react 折射；保持 Dock 与左右实例布局 |
| 界面性能       | 流畅/视觉模式持久化；皮肤静止按需绘制，隐藏/离屏停止，显式旋转上限 60Hz；Mod/版本各 50 项分页与搜索；进度/日志最多每 100ms 合并展示，资源页首次访问才加载 |

## 关键源码

| 模块         | 文件                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主/编排    | `electron/main.ts`、`core/launcher.ts`、`core/features.ts`                                                                                               |
| 目录/配置    | `core/store.ts`、`game-directories.ts`、`instance-paths.ts`                                                                                              |
| 安装/Java    | `core/services/game.ts`、`java.ts`、`neoforge.ts`、`optifine.ts`                                                                                         |
| 内容/下载    | `core/services/content.ts`、`downloads.ts`、`download-source.ts`、`download-queue.ts`、`content-packs.ts`                                                |
| CAS/快照     | `core/services/content-store.ts`、`instance-manifest.ts`、`snapshots.ts`                                                                                 |
| 健康/诊断 | `core/services/health.ts`、`crash-diagnostics.ts`；结构在 `shared/`                                                                             |
| 页面         | `src/App.tsx`、`src/components/Instances.tsx`、`InstanceStorage.tsx`、`HealthPanel.tsx`、`Diagnostics.tsx`、`InstanceContentPacks.tsx` |
| CLI          | `cli/main.ts`、`cli/commands.ts`、`bin/ldfcl-cli.cjs`                                                                                                    |

## 仍可改进的范围

- 健康扫描检查必需 Mod ID 存在性，不能代替加载器完整 semver/冲突求解；运行时兼容性依赖实际组合测试。
- CAS 硬链接不是写时复制；外部强制改写共享归档会导致校验失败。独立首次备份额外占盘，当前无GC或备份清理UI。
- JSON清单需要当前CAS；跨机需导出 `manifest.json + blobs` 清单包。运行环境不是完整断网封装；公共资源和Java仍可按需补齐。
- `.part` 可跨进程重请求续传，下载任务列表没有持久队列/自动重新调度。
- 目前以 Modrinth 内容生态为主，尚无完整 CurseForge 支持、可选前置勾选或所有整合包格式。
- 皮肤库还可增加搜索/标签/分组/批量；编辑器可扩展基底/外层、吸管、填充、镜像及重做。
- 桌面 IPC 仍有集中路由和部分 `any`；资源、实例、衣橱、日志和关于已拆分加载，首页仍包含 React 与 skinview3d，入口构建仍有大于 500kB 的体积提示。
- 界面以 60 FPS 为优化目标。CPU 降速压力测试不能模拟 4GB 内存、老款核显、驱动及系统换页，尚未完成该硬件组合的真机验收；不承诺所有电脑或瞬时最低帧率。
- 需要真实获准 Microsoft 应用/账号验证登录、续期与在线外观操作；本轮未操作真实账号或在线外观服务。没有进入存档进行长期游玩/性能和联机兼容测试。
- 发布产物未做 Authenticode 签名；Windows以外平台没有完整发行与实机矩阵。

## 验证与来源

当前自动测试与成品验证结果见 [最终验证](../VALIDATION.md)。覆盖文件系统、延迟迁移与原件保护、事务故障/中断、下载HTTP/Range、CLI子进程、本地诊断与配置边界、规则诊断与旧账号/下载/皮肤功能；本地规则诊断测试覆盖当前功能。生产包及历史真实游戏结果见 [最终验证](../VALIDATION.md)，不要把受控服务或模拟进程等同于真实登录或客户端运行。

历史与当前上游来源、代码使用范围及许可见 [CREDITS](../CREDITS.md)、[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。本轮使用 NeoForge 官方安装器与配置协议，没有复制上游加载器源码；保留既有 UI 依赖及全部致谢。
