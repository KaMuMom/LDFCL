# LDFCL 当前功能与实现方式

更新：2026-10-22，当前版本 **0.6.2-beta.1**，源码见 GitHub `beta` 分支，本次未创建新 Release。[微软登录配置及授权码改进](0.6.2_BETA_LOGIN.md)说明本次变化；[启动修复与 AI 暂停](0.6.1_STARTUP_FIX.md)、[P0–P6](P0_P6_IMPLEMENTATION.md)保留已有实现，命令见 [CLI](CLI.md)，成品检查见 [VALIDATION](../VALIDATION.md)。

## 架构

| 层   | 实现                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| UI   | React 19、TypeScript、Vite、liquid-glass-react；保留 Dock、皮肤/账号、版本/启动区及左右实例布局；1120×760 默认、960×640 紧凑窗口 |
| 桌面 | Electron 39；隔离 preload、IPC 来源校验；窗口/浏览器/对话框/回收站/系统密钥适配                                                  |
| 核心 | 无 Electron 依赖的 `@ldfcl/core`；业务编排、账号、内容、下载、Java、安装、启动、皮肤和 P1–P6 服务                                |
| CLI  | 普通 Node 运行；两个只读列表及清单、快照、健康、诊断命令；AI命令已暂停                                                            |
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
| 游戏选项       | 启动前编辑；通用设置可选启用、实例覆盖；保留不受管 options 字段；流畅/均衡/画质/电影四档预设                                                              |
| 皮肤 / 披风    | skinview3d 预览、本地 PNG 试穿、64×64 UV 编辑/擦除/撤销/导出、经典/纤细；正版皮肤上传/恢复、已拥有披风启停                                                |
| 保存皮肤库     | 本地导入、命名、预览、重命名、导出、删除及明确应用正版账号；未登录可管理；PNG 与索引校验、原子持久化                                                      |
| 实例清单 / CAS | SHA-256 内容寻址、归档只读硬链接/复制回退、可写文件隔离、原件备份；清单差异、独立 bundle、干净目录重建                                                    |
| 实例快照       | 修改/启动写选项前自动保存；手动创建/列表；预览差异、过期拒绝、保护快照、事务恢复；保留世界和日志                                                          |
| 健康检查       | 启动前及手动扫描；Java、必需 Mod ID、内存、历史警告；评分JSON、徽标、问题与建议；自动修复有限项目并留日志                                                 |
| 日志 / 诊断    | 每实例最近500行及复制；捕获本次崩溃文件，规则给出原因、置信度、证据、可疑模组和可执行建议；支持导入报告                                                   |
| AI 页面        | 仅保留静态预览，控件与诊断增强入口禁用；后台服务和CLI请求不可用，不加载历史AI分析                                                                         |
| AI 密钥        | 原加密文件保留不动，本版不读取AI设置/密钥、不接收临时AI环境变量、不发AI请求                                                                                |
| 外观           | 浅色、深色、实时跟随系统；沿用现有 liquid-glass-react 组件，新增功能不改变主布局                                                                          |

## 关键源码

| 模块         | 文件                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主/编排    | `electron/main.ts`、`core/launcher.ts`、`core/features.ts`                                                                                               |
| 目录/配置    | `core/store.ts`、`game-directories.ts`、`instance-paths.ts`                                                                                              |
| 安装/Java    | `core/services/game.ts`、`java.ts`、`neoforge.ts`、`optifine.ts`                                                                                         |
| 内容/下载    | `core/services/content.ts`、`downloads.ts`、`download-source.ts`、`download-queue.ts`、`content-packs.ts`                                                |
| CAS/快照     | `core/services/content-store.ts`、`instance-manifest.ts`、`snapshots.ts`                                                                                 |
| 健康/诊断/AI | `core/services/health.ts`、`crash-diagnostics.ts`、`ai.ts`；结构在 `shared/`                                                                             |
| 页面         | `src/App.tsx`、`src/components/Instances.tsx`、`InstanceStorage.tsx`、`HealthPanel.tsx`、`Diagnostics.tsx`、`AISettings.tsx`、`InstanceContentPacks.tsx` |
| CLI          | `cli/main.ts`、`cli/commands.ts`、`bin/ldfcl-cli.cjs`                                                                                                    |

## 仍可改进的范围

- 健康扫描检查必需 Mod ID 存在性，不能代替加载器完整 semver/冲突求解；运行时兼容性依赖实际组合测试。
- CAS 硬链接不是写时复制；外部强制改写共享归档会导致校验失败。独立首次备份额外占盘，当前无GC或备份清理UI。
- JSON清单需要当前CAS；跨机需导出 `manifest.json + blobs` 清单包。运行环境不是完整断网封装；公共资源和Java仍可按需补齐。
- `.part` 可跨进程重请求续传，下载任务列表没有持久队列/自动重新调度；没有启动器自更新。
- 目前以 Modrinth 内容生态为主，尚无完整 CurseForge 支持、可选前置勾选或所有整合包格式。
- 皮肤库还可增加搜索/标签/分组/批量；编辑器可扩展基底/外层、吸管、填充、镜像及重做。
- 桌面IPC仍有集中路由和部分 `any`；UI入口包约963kB并有构建体积提示，可进一步分页面加载与性能测试。
- 需要真实获准 Microsoft 应用/账号验证登录、续期与在线外观操作；本轮未操作真实账号或付费AI。没有进入存档进行长期游玩/性能和联机兼容测试。
- 发布产物未做 Authenticode 签名；Windows以外平台没有完整发行与实机矩阵。

## 验证与来源

完整自动测试 **339/339** 通过。覆盖文件系统、延迟迁移与原件保护、事务故障/中断、下载HTTP/Range、CLI子进程、AI暂停且零配置读取、规则诊断与旧账号/下载/皮肤功能；保留的AI服务单元测试不代表本版接入后台服务。生产包及历史真实游戏结果见 [最终验证](../VALIDATION.md)，不要把受控服务或模拟进程等同于真实登录或客户端运行。

历史与当前上游来源、代码使用范围及许可见 [CREDITS](../CREDITS.md)、[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。本轮使用 NeoForge 官方安装器与配置协议，没有复制上游加载器源码；保留既有 UI 依赖及全部致谢。
