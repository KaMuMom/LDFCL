# LDFCL 0.6.3

本版自动恢复有明确原始版本记录的旧实例关联，缺失游戏语言时默认简体中文，未登录预览使用内置 Steve，并新增 GitHub Latest 检查、校验下载与便携版重启更新。保留原始游戏文件、玩家已选语言、账号配置和透明像素图标。发布内容与验证边界见 [0.6.3 发行说明](docs/0.6.3_RELEASE.md)，本地构建位于 `release/0.6.3/`。

[下载最新版本](https://github.com/KaMuMom/LDFCL/releases/latest) · [0.6.3 发行页](https://github.com/KaMuMom/LDFCL/releases/tag/v0.6.3)

---

# LDFCL 0.6.1

0.6.1 修复“进程存在但主窗口不显示”：窗口先显示加载状态，核心准备及界面加载失败可见并可重试；启动和切换游戏根不再完整迁移所有实例。本地规则诊断、日志、健康扫描和快照继续可用。详见 [启动修复说明](docs/0.6.1_STARTUP_FIX.md)。新 EXE、源码与验证记录在 `release/0.6.1/`，没有上传 GitHub。

以下 0.6.0 的 P0–P6 记录作为上一版功能说明。

0.6.0 已实现 P0–P6：独立 `@ldfcl/core` / CLI、SHA-256 内容存储和实例清单重建、自动快照回滚、健康扫描修复、规则崩溃诊断、NeoForge、镜像与下载续传控制、资源包/光影启停、四档预设和主题。实现与验证范围见 [P0–P6 说明](docs/P0_P6_IMPLEMENTATION.md)、[当前功能总结](docs/CURRENT_FEATURES_AND_IMPLEMENTATION.md) 与 [CLI 使用说明](docs/CLI.md)。

0.6.0 的历史本地发行文件保留在 `release/p0-p6/`；下面的下载入口指向当前 0.6.3。

现代 Minecraft Java 版桌面启动器。面向 Windows x64，使用 Electron、React、TypeScript 开发。0.5.0 按 [liquid-glass-react](https://github.com/rdev/liquid-glass-react/tree/ac48eab18d1f7f444ae30002d240cae29c863a21) 的公开文档重构整个界面，实际引入 `liquid-glass-react@1.1.1`，采用浅冰蓝与淡紫背景、折射玻璃表面及清晰的文字内容层。设计与适配范围见 [UI 重构说明](docs/UI_REFACTOR.md)。

0.5.0 仅调整 UI、共享视觉组件与依赖署名，保留账号、启动、隔离实例、资源安装、Mod 管理、皮肤库和设置的现有功能。早期 [TryLiquidGlass-WinUI3](https://github.com/SuGar0218/TryLiquidGlass-WinUI3) 视觉参考与历史验证记录继续保留。

0.4.0 新增 Mod 目标实例与发行版本选择、递归补齐必需前置、常用 Mod 收藏、本地皮肤库、OptiFine 独立安装和通用游戏设置；保留整合包发行版本选择与版本隔离。

0.3.1 将账号与启动器配置统一放到外部启动器 EXE 旁的 `LDFCL-data` 文件夹。首次迁入旧配置时保留原件，新位置已有数据时不覆盖；程序旁 `.minecraft` 的规则保持不变。

0.3.0 移除首页右上角「安装新版本」，安装入口统一从「资源下载」进入，空实例首页仍可点击「安装游戏」。参考 [KAMUCL](https://github.com/YUN-SAN3/KAMUCL) 的模块划分，独立重构统一下载队列、Java 探测与启动准备、账号异步更新、Mod 元数据和重复检测；来源、具体范围和差异见 [重构说明](docs/KAMUCL_REFERENCE.md)。

Minecraft 版本、Mod、整合包、资源包和光影包统一放入「资源下载」，窗口默认约 1120 × 760 并随工作区缩小。首页保留左侧图标 Dock、中部 3D 角色与账号选择，以及右侧版本和启动操作区；0.5.0 统一为蓝色强调色与玻璃卡片。0.2.1 将正版登录改为 Microsoft 设备代码授权，另有常用 Mod 中文名称/简介和「关于与致谢」页。完整来源、实际使用方式和贡献说明见 [CREDITS.md](CREDITS.md)。

## 使用发行版

源码仓库：[KaMuMom/LDFCL](https://github.com/KaMuMom/LDFCL)。GitHub 下载入口为 [最新发行版](https://github.com/KaMuMom/LDFCL/releases/latest)，本地编译产物保存在 `release/0.6.3/`。

- [Windows x64 便携版 EXE](https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/LDFCL-0.6.3-Windows-x64.exe)：运行环境随程序打包，无需安装 Node.js 或 .NET。
- [完整源码 ZIP](https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/LDFCL-0.6.3-source.zip)：开发依赖不随源码归档附带，使用 `npm ci` 安装。
- [SHA-256 校验值](https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/SHA256SUMS-0.6.3.txt)；[最终测试记录](https://github.com/KaMuMom/LDFCL/releases/download/v0.6.3/VALIDATION-0.6.3.md)。
- 默认游戏目录是 **启动器 EXE 所在文件夹中的 `.minecraft`**，首次运行自动创建。账号与启动器配置保存在旁边的 **`LDFCL-data`**；「启动器设置 → 工作空间」可以查看和打开该目录。

发行文件的打包及最终成品验证状态见 [VALIDATION.md](VALIDATION.md)。

第一次使用：添加账号 →「资源下载 → Minecraft」选择游戏版本和加载器 → 下载并安装 →「开始游戏」启动。首次安装需要联网下载游戏、资源、依赖以及所需 Java，速度取决于下载源连接情况。

```text
启动器所在文件夹/
├── LDFCL-0.6.3-Windows-x64.exe
├── LDFCL-data/
│   ├── launcher.json       # 启动器设置、目录与版本记录
│   ├── accounts.json       # 账号资料和受系统保护的加密凭据
│   ├── mod-favorites.json # 常用 Mod 收藏
│   ├── skins/             # 皮肤库索引及 PNG
│   ├── store/             # SHA-256 内容对象与清单索引
│   ├── diagnostics/       # 脱敏崩溃报告
│   └── translations/mods/ # 自定义 Mod 中文扩展
└── .minecraft/            # 默认游戏目录
```

首次升级会从原 Electron 用户目录（Windows 默认 `%APPDATA%\LDFCL`）复制账号、配置和自定义 Mod 中文扩展，以完整临时目录发布，不搬动游戏文件；已存在的 `LDFCL-data` 会直接使用，避免覆盖新配置或重新导入已删除账号。旧版本游戏目录和存档继续按原路径管理。源码模式默认使用项目根目录的 `LDFCL-data`。加密凭据仍由当前 Windows 用户和原 Electron 系统密钥保护；换系统用户或设备时可能需要重新登录。

## 游戏目录

在「启动器设置 → 游戏目录」点击「添加游戏目录」，可选择任意磁盘位置的 `.minecraft` 或其他名称的文件夹，也可在选择窗口新建文件夹。添加后自动切换并扫描 `versions` 中兼容的本地版本；「使用目录」切换已登记目录，「重新扫描版本」识别后来添加的版本。

- 默认目录位于 EXE 旁；便携版使用外部 EXE 的目录，不使用临时自解压目录。从源码运行时默认位于项目文件夹。
- 每个游戏目录分别保存版本、资源、依赖与 Java 缓存。各版本的运行目录为 `<游戏目录>/versions/<版本文件夹>`，`assets` 和 `libraries` 位于游戏根目录共享；Mod、存档、日志及 `options.txt` 按版本隔离。
- 添加已有目录会直接管理 `versions/<版本文件夹>` 中已有的 Mod、存档和设置；根目录的公共 Mod、存档不自动合并。缺失游戏资源可在启动时联网补全。
- 旧版 LDFCL 的 `instances/<实例ID>` 数据会复制到独立的 `versions/<版本文件夹>`，原文件保留；遇到已有同名版本时使用唯一后缀，避免覆盖或混合已有内容。0.2.1 及之前的游戏资源根仍保留在「原有游戏目录」中。账号和自定义 Mod 中文扩展由所有目录共享。
- 「移除目录」仅取消登记，游戏文件和实例记录保留；重新添加可恢复。程序旁的默认目录不能移除。
- 游戏运行、安装、Mod 更新或文件操作期间会阻止目录切换。无写入权限时会显示提示，可改选可读写的文件夹。

```text
.minecraft/
├── assets/
├── libraries/
└── versions/
    └── 1.16.5-optifine/
        ├── 1.16.5-optifine.json
        ├── 1.16.5-optifine.jar
        ├── mods/
        ├── config/
        ├── saves/
        ├── resourcepacks/
        ├── shaderpacks/
        ├── logs/
        └── options.txt
```

## 首页操作

左侧 Dock 提供开始游戏、实例、资源下载、皮肤与披风、下载任务、设置、日志和关于入口。鼠标悬停或键盘聚焦图标可查看名称，账号管理位于下方。

首页中部显示当前角色的 3D 预览，可拖动旋转并开关自动旋转；下方账号下拉框直接切换当前游戏身份。没有可用远程皮肤时使用内置经典 Steve，预览无需联网获取默认纹理。需要编辑、导出或上传纹理时，从 Dock 进入「皮肤与披风」。

右侧版本卡展示当前已安装实例：

- 「切换版本」打开已安装实例选择窗口，选择后保存当前实例。
- 「版本设置」直接进入该实例的游戏预设。
- 「Mod 管理」直接进入该实例的模组列表。
- 右下方「启动游戏」使用当前账号与实例启动；尚无账号时先打开账号管理，尚无实例时显示「安装游戏」并进入资源下载。

## 功能与操作

「游戏实例」采用左右布局：左侧搜索和选择已安装版本，右侧默认管理该版本的 Mod。导入、启用/禁用、重复检测、更新和移除均作用于当前选择的实例；切换版本后加载对应的 Mod 列表。右侧还保留「实例概览」「游戏预设」和「实例设置」，首页的版本设置和 Mod 管理入口继续直达对应页面。

版本隔离始终开启，采用标准 `.minecraft/versions/<版本文件夹>` 结构。右侧显示实际版本目录，`mods`、`config`、`saves`、`resourcepacks`、`shaderpacks` 与 `options.txt` 分别保存在该实例下；游戏资源和运行库按游戏根共享缓存。导入版本中的 `--gameDir` 即使写有旧路径，启动时也会统一指向当前独立目录。例如 `versions/1.16.5-optifine/mods` 和 `versions/1.16.5-optifine/saves` 都直接用于该版本。新增重复版本使用唯一文件夹；删除仍被其他版本继承或引用的基础版本时会拒绝操作。

| 功能       | 当前实现                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 登录       | Microsoft 设备代码授权，自动打开官方页面并轮询结果；离线玩家、支持 Yggdrasil 的第三方皮肤站                                                            |
| 版本隔离   | 每个实例使用独立的 `mods`、存档、配置、资源包和光影目录；游戏依赖及资源可共享缓存                                                                      |
| 游戏目录   | 程序旁自动创建 `.minecraft`，可添加任意位置的已有目录、扫描版本并持久保存各目录的选择                                                                  |
| 游戏安装   | Mojang 版本列表，Vanilla、Fabric、Quilt、Forge、OptiFine；启动时补全缺失资源                                                                           |
| 启动前设置 | 在设置页配置通用游戏设置，实例游戏预设可覆盖；支持距离、帧率、视野、音量、亮度、缩放、语言、全屏等                                                     |
| 皮肤/披风  | 可旋转的 3D 预览、经典/纤细模型、本地 PNG、像素编辑、PNG 导出、本地皮肤库与命名/重命名、正版皮肤上传/恢复、切换已拥有的正版披风                        |
| Mod 管理   | 导入 `.jar`、启用/禁用、移除、检测重复模组 ID 和相同文件、检查兼容更新、保留旧文件备份                                                                 |
| 资源下载   | 在统一页面下载 Minecraft，或从 Modrinth 搜索并安装 Mod、整合包、资源包、光影包；Mod 可选择目标实例及兼容发行版本，递归补齐必需前置，收藏跨游戏目录共享 |
| Mod 中文   | 内置常用 Mod 的自编中文名称和简介，保留原名与原文；可扩展本地中文目录，未收录项目明确显示暂无中文                                                      |
| 整合包     | 导入和下载 Modrinth `.mrpack`，可选择发行版本、筛选 MC 与加载器，按选定版本创建独立实例并应用客户端 overrides                                          |
| 下载       | 可调并发、多文件并行、失败重试、按清单校验 SHA-1/SHA-512/SHA-256；临时下载通过校验后再落盘                                                             |
| Java/内存  | 优先选择匹配的本地 Java；缺失时下载 Eclipse Temurin，源不可用时尝试 Azul Zulu；自动或手动分配堆内存                                                    |

「游戏实例 → Mod 管理」中的移除和更新会将旧文件保留在实例的 `.trash` 子目录，可从「打开目录」找回。禁用模组会将 `.jar` 改名为 `.jar.disabled`。仅对启用的模组提示重复，避免把保留的禁用旧版本误判为冲突。

资源包和光影包下载到对应实例目录后，在游戏内启用。光影通常还需要 Iris 或 OptiFine 等兼容组件；下载光影包不会自动替换你的渲染组件。不同版本支持的 `options.txt` 设置有所不同，较旧游戏可能忽略较新选项。

## Mod 下载与收藏

在「资源下载 → Mod」搜索后点击「选择安装位置」，先选择要安装到的游戏实例，再选择该 Minecraft / 加载器可用的发行版本。确认后只写入所选实例的 mods 目录；切换当前游戏版本不会改变已打开窗口中的安装目标。需要 Fabric、Quilt 或 Forge 实例，原版和独立 OptiFine 实例不可安装普通 Mod。

安装前递归解析 Modrinth 标记为 required 的前置依赖，校验项目、发行版本和兼容性后再下载；optional 前置不自动安装。已存在的匹配依赖会复用，禁用的匹配前置会启用。依赖信息冲突或无法满足时提示失败；传输中断前已成功安装的依赖会保留，重试可复用。

点击星标加入常用 Mod，再使用「只看收藏」快速查找。收藏保存在程序旁 LDFCL-data/mod-favorites.json，与账号、游戏目录和重启独立；收藏条目在安装时仍需选择合适实例及发行版。

## OptiFine 安装

「资源下载 → Minecraft」选择游戏版本和 OptiFine，加载该游戏版本可用的具体发行版后安装。未提供对应 OptiFine 时显示空列表，可改选其他游戏版本或原版；不会替换为其他发行版。安装生成新的隔离实例，不与 Forge/Fabric 组合。

版本信息和安装器通过 [BMCLAPI](https://bmclapidoc.bangbang93.com/) 按需获取，使用 [OptiFine](https://optifine.net/) 官方安装器生成补丁库；独立 Java 调用桥源码保存在 docs/OptiFineBridge.java，发行版不包含 OptiFine JAR。BMCLAPI 此接口未提供公开预期摘要，程序验证 JAR 结构、大小上限及安装器自报版本；Mojang 原版客户端按官方清单校验。

## 皮肤库

「皮肤与披风 → 皮肤库」可以导入 PNG，或保存当前预览/像素编辑结果，记录名称和经典/纤细模型；支持预览、重命名、导出、删除。即使没有账号也可以管理本地皮肤，文件与索引保存在程序旁 LDFCL-data/skins。选择库中皮肤只改变预览，点击「应用到正版账号」才向当前 Microsoft 账号上传。披风仍只能使用账号已拥有的款式。

## 通用游戏设置

「启动器设置 → 通用游戏设置」启用后可调整渲染/模拟距离、帧率、视野、亮度、界面缩放、画质、垂直同步、全屏、音量和语言。点击页面顶部「保存设置」，下次启动写入该实例的 options.txt，正在运行的游戏需要退出后重启。

优先级为游戏自己的设置、通用设置、实例单独预设。通用设置默认关闭，升级不会主动覆盖已有 options.txt；关闭后停止应用通用值，不回滚此前已写入的值。「游戏实例 → 游戏预设 → 恢复通用设置」清除该实例的单独预设。旧版游戏可能忽略较新的选项。

## 选择整合包版本

进入「资源下载 → 整合包」，搜索后点击卡片上的「选择版本」。弹窗按发布时间列出可下载的发行版，显示包版本号、Minecraft 版本、加载器、正式/测试/预览状态、发布日期和 `.mrpack` 文件大小。可分别筛选 Minecraft 与加载器，再勾选需要的发行版本，点击「安装所选版本」。文件大小仅指整合包归档，不包含之后下载的游戏和模组依赖。

版本列表独立于当前游戏实例，可在没有实例时使用；若要查找适用于其他 Minecraft 的整合包项目，可取消搜索栏的「匹配」筛选。下载严格使用所选发行版，失效或不属于该项目时会报错，不会换成最新版。每次安装在当前游戏目录下创建新的隔离实例，已安装同一整合包后仍可选择其他发行版。安装时可以关闭选择窗口，在「下载任务」查看进度。

当前支持原版、Fabric、Quilt、Forge。仅支持 NeoForge 等其他加载器的发行版会显示为不可选择；列表加载或安装失败可直接重试。

## 账号说明

### Microsoft 正版

此源码不借用其他启动器的 OAuth 应用身份，也不内置可直接使用的 Minecraft OAuth Client ID。首次使用需要填写你自己的 Microsoft 应用 Client ID：

1. 在 Microsoft Entra 应用注册中创建支持个人 Microsoft 账号的应用，选择「仅个人 Microsoft 账号」或同时支持组织账号和个人账号的类型。
2. 在「Authentication → Advanced settings」将「Allow public client flows」设为「Yes」。设备代码流程不需要本机回调地址或重定向 URI，也不使用客户端密钥。
3. 确认该应用获准访问 Minecraft Services 所需 API。**仅注册应用不代表自动获得 Minecraft API 访问权限**；若 Xbox/Minecraft 阶段返回 401/403，应检查该应用的授权资格。
4. 在 LDFCL 账号窗口填写 Client ID，点击「开始微软登录」。启动器会打开 Microsoft 官方验证页面并显示本次设备代码；复制代码，在该页面输入并完成登录授权。
5. 启动器按服务端要求的间隔自动查询授权结果，随后验证 Xbox 和 Minecraft 游戏授权并获取角色档案。可以随时取消；代码到期后停止查询，需要重新发起登录。有效期以当次服务端返回值为准。

账号需要拥有有效的 Minecraft Java 版权并已建立玩家档案。Microsoft 密码仅在系统浏览器的 Microsoft 页面输入，LDFCL 不会接收该密码；启动器会接收用于游戏认证的授权令牌。0.2.1 默认使用设备代码流程，无需开放本机回调端口。完整的正版登录、上传皮肤及切换披风仍需要使用真实、获准的应用和账号验证。

Microsoft、Xbox 和 Minecraft 账号服务通过 HTTPS 连接并保留服务器证书校验。若运行环境设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0`，账号请求会被阻止；请恢复证书校验或正确配置可信根证书后重试。程序不提供跳过证书错误的账号登录开关。此说明针对账号服务，不将本机调试用 HTTP 地址描述为 HTTPS。

官方依据为 [Microsoft 设备代码协议](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)、[桌面应用注册与公用客户端配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)、[应用注册及账号类型](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)，以及用户指定的 [Xbox Live / XSTS 背景文档](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-xbox-live-authentication?view=gdk-2510)。LDFCL 使用 Minecraft Java 的 OAuth → Xbox Live → XSTS → Minecraft 令牌交换；没有直接集成 GDK / XSAPI 或实现标题服务调用签名。GDK 文档不替代应用注册、Minecraft API 访问资格或游戏权益检查。XBL/XSTS 中间令牌仅在交换期间保留在内存中。

0.2.0 曾使用系统浏览器授权码 + PKCE 与本机回调；相关官方文档、MSAL.js 阅读记录和回归测试作为历史实现资料保留，不代表 0.2.1 界面的默认登录流程。

### 离线与其他皮肤站

离线名称使用 3–16 个英文字母、数字或下划线。适用于本地游戏及允许离线身份的服务器，不提供正版服务器认证。游戏文件、所需 Java 已下载完成后，离线身份仍可用于本地启动；缺少资源时仍需联网补全。

第三方皮肤站填写其 **Yggdrasil API 完整地址**，例如 `https://skin.example.com/api/yggdrasil`，而非任意网站首页。启动时下载并加载 authlib-injector。密码仅用于本次认证，不保存。皮肤站账号的远程皮肤管理使用该站提供的管理页面，本地预览与像素编辑仍可使用。

Microsoft/Yggdrasil 令牌通过 Electron `safeStorage` 加密后保存；系统加密不可用时仅在当前会话保存令牌。令牌不返回给网页界面。更换 Windows 用户或加密状态变化后，可能需要重新登录。

## Mod 中文与扩展

内置 **47 条**中文目录由本项目独立编写，项目 ID/slug 经实际 Modrinth API 核对；原始名称、作者和原文仍保留供核对。输入「钠」等常用中文名可映射至原项目关键词检索。没有中文条目的项目显示原文与「暂无中文」，不将自动翻译或推测名称冒充作者官方介绍；它也不修改模组的游戏内语言。

默认本地扩展目录为 `启动器所在文件夹\LDFCL-data\translations\mods\*.json`，按项目 ID、slug 或 JAR 模组 ID 匹配。格式、优先级和重新载入行为见 [Mod 中文目录说明](docs/MOD_TRANSLATIONS.md) 与 [示例 JSON](docs/mod-translations.example.json)。

感谢 [CFPAOrg/Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package) 及贡献者的社区汉化工作。该项目采用 CC BY-NC-SA 4.0；本版未复制或打包其翻译数据，内置中文目录不取自该项目。用户自行导入的扩展数据保留其原有授权。

## 范围与当前限制

- Windows x64 发行版；未提供 macOS/Linux 安装包。
- 玻璃视觉由 renderer 中的 `liquid-glass-react` 提供，使用 `standard` 折射模式与独立正文层；本项目仍为 Electron 应用。上游说明 Safari/Firefox 对折射效果支持不完整，当前发行目标为 Electron/Chromium。
- 整合包支持 Modrinth `.mrpack`，当前不解析 CurseForge `manifest.json` ZIP。导入会包含标记为可选的客户端文件；不支持的服务器专用文件跳过。
- 当前安装入口为 Vanilla、Fabric、Quilt、Forge、OptiFine；OptiFine 独立安装，不与 Forge/Fabric 组合；NeoForge 未作为受支持安装入口。
- Mod 更新根据 Modrinth 可识别的文件哈希、游戏版本和加载器筛选。未在该服务登记的本地 Mod 可能无法识别更新；版本标签并不保证不同作者模组之间绝对兼容。
- 正版披风只能切换账号已拥有的款式。本地披风文件用于预览，不能据此创建正版披风资格。
- 下载内容遵循各作者授权；启动器不附送 Minecraft 游戏版权。
- 已实际启动 Vanilla 26.3 和 Fabric 1.21.1，看到客户端图形与音频初始化后正常停止；尚未进入存档测试游玩。Quilt/Forge 未完成整套实机安装测试，详见 [验证记录](VALIDATION.md)。

## 从源码开发与构建

建议 Windows 10/11 x64、Node.js 22.19+ 或 24 LTS。

```powershell
npm ci
npm run build
npm test
npm start
```

`npm start` 运行已经构建的桌面界面。开发时可在一个终端启动前端：

```powershell
npm run dev
```

另一个终端在完成一次 `npm run build` 后连接开发服务器：

```powershell
$env:LDFCL_DEV_URL = "http://127.0.0.1:5173"
npm start
```

编译便携发行版：

```powershell
npm run dist
```

输出位于 `release/`。Electron 下载和打包需要网络；游戏 Java 由程序按需补全。若企业网络的可信根证书只在 Windows 系统证书库中，可在支持此参数的 Node.js 版本中设置 `$env:NODE_OPTIONS = "--use-system-ca"` 后重试 `npm ci`。请勿关闭 TLS 验证。

测试使用独立临时目录；可设置 `LDFCL_DATA_DIR` 指向单独配置目录，此时测试默认游戏根为其 `.minecraft` 子目录；`LDFCL_GAME_ROOT` 可进一步覆盖默认游戏根。不要将账号数据或完整个人游戏目录放进源码归档。

桌面界面的自动烟测使用 Playwright/Electron，需先完成构建：

```powershell
npm run build
node tests/electron-smoke.cjs
node tests/home-layout-smoke.cjs
node tests/directories-smoke.cjs
node tests/instances-layout-smoke.cjs
node tests/legacy-layout-smoke.cjs
node tests/pack-versions-smoke.cjs
node tests/mod-download-smoke.cjs
node tests/skin-library-smoke.cjs
node tests/optifine-download-smoke.cjs
node tests/general-settings-smoke.cjs
```

脚本创建独立临时数据目录及测试夹具，不会改动默认个人工作空间；截图输出到 `test-results/`。夹具账号是离线测试身份，不能据此证明实账号授权成功。

编译便携发行版后，可运行 `node tests/config-migration-smoke.cjs` 和 `node tests/portable-directories-smoke.cjs`，验证程序旁配置目录、首次旧数据导入、重启及整体移动后的读取；这两份脚本会复制 EXE 到独立临时目录，不操作个人配置。

## 验证说明

0.6.0 的生产构建与 **337/337 自动测试**已通过；本轮最终桌面、便携包和真实 NeoForge 验证结果以 [VALIDATION.md](VALIDATION.md) 顶部记录为准。以下为历史版本结果。

0.5.0 的生产构建与 **255/255 自动测试**通过；打包程序的 UI/功能专项 **63 组**通过，ASAR 4,102 个文件及运行代码核验一致。实际便携 EXE 21 组、59 张界面截图均完成。最终成品结果以 [VALIDATION.md](VALIDATION.md) 的本版记录为准。

0.4.0 历史验证：生产构建与 **255/255 自动测试**通过；实际下载并安装 Minecraft 1.12.2 + OptiFine HD_U_G5，验证补丁库、启动配置、36 个运行库及官方资源，未进入游戏或使用真实 Microsoft 账号上传皮肤。最终打包程序的新功能及整合包专项 **35 组**、实际便携 EXE 自解压烟测及目录/收藏/皮肤重启移动专项 **8 组**通过；4,094 个 ASAR 文件与 31 个运行文件核对一致。这些历史结果不替代 0.5.0 的验证。
