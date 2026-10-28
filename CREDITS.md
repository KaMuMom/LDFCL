# LDFCL 0.5.0 · 来源、贡献与致谢

0.5.0 按用户指定的 [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) 文档重构 UI，实际使用 npm 运行依赖 **liquid-glass-react@1.1.1**。感谢 **Max Rovensky** 开发并以 MIT 公开这一组件；上游完整版权声明为 **Copyright 2025 MAX ROVENSKY**。文档及许可证阅读固定在 [提交 ac48eab18d1f7f444ae30002d240cae29c863a21](https://github.com/rdev/liquid-glass-react/tree/ac48eab18d1f7f444ae30002d240cae29c863a21)，运行包的精确版本记录于 package-lock.json。

本项目独立编写 GlassBackdrop / GlassSurface 适配层和应用布局，在真实上游玻璃装饰之后保留语义 HTML、可选择正文与原有功能。适配使用 standard 折射模式；范围与旧样式清理见 [UI 重构说明](docs/UI_REFACTOR.md)，完整上游 MIT 文本见 [第三方通知](THIRD_PARTY_NOTICES.md#liquid-glass-react-111--mit)。以下旧版功能和来源记录保留原版本语境。

0.4.0 的 Mod 目标与发行版本选择、必需前置解析、Mod 收藏、本地皮肤库、OptiFine 独立安装及通用游戏设置由本项目独立实现，没有新增外部依赖。感谢 **sp614x** 开发 [OptiFine](https://optifine.net/)；感谢 **bangbang93 与 BMCLAPI 维护者** 提供 [BMCLAPI](https://github.com/bangbang93/BMCLAPI) 的 OptiFine 版本元数据与安装器镜像服务。

OptiFine 安装器仅在用户请求安装时通过 HTTPS 从镜像下载，并在临时游戏目录中执行官方 `optifine.Installer` 安装与补丁流程，再检查生成的启动配置与运行库。LDFCL 自行编写了 [Java 8 反射适配器](docs/OptiFineBridge.java)，以便使用 JRE 在无图形界面的安装流程中指定目标目录和核对版本；随包的适配器字节码由这份独立源码编译。应用与源码发行包不包含 OptiFine 安装器、上游 Java 实现、游戏补丁或反编译代码。OptiFine 保留其原有版权与许可，不受 LDFCL 的 MIT 许可覆盖。

0.3.2 的整合包版本选择、Minecraft/加载器筛选和精确发行版下载由本项目独立实现；发行元数据和文件来自 Modrinth API，感谢 Modrinth 与整合包作者。没有新增外部依赖。

0.3.1 的程序旁配置目录解析、旧配置安全复制与便携目录持久化由本项目独立实现，没有新增外部依赖。

## KAMUCL 功能架构参考

感谢 **YUN-SAN3、kamubaba-i 与 KAMUCL 项目贡献者** 公开 [KAMUCL](https://github.com/YUN-SAN3/KAMUCL)。2026-10-21 阅读了 [提交 30874ab871c8ee00c1edab275bb3aeb25704330b](https://github.com/YUN-SAN3/KAMUCL/tree/30874ab871c8ee00c1edab275bb3aeb25704330b) 的下载、Java、启动准备、账号及内容管理模块，作为 0.3.0 重构现有功能的架构与行为参考。

本次实现包括统一下载队列和校验发布、Java 属性与架构探测、启动参数与本地库准备、账号异步生命周期、Mod 元数据和重复分组。代码由本项目独立编写，保留原有 Electron / React 界面与 versions 目录隔离。没有复制上游源码、图片、可执行文件、第三方组件或 OAuth 应用身份。模块对应及具体范围见 [重构说明](docs/KAMUCL_REFERENCE.md)。

上游根 LICENSE 标为 MIT，版权声明为 **Copyright (c) 2026 kamubaba-i**，且明确限定为 **original KAMUCL contributions only**；第三方部分保留各自许可，部分历史来源仍有待上游核对。本页不把该 MIT 扩展到其整个依赖树，也不声称上游维护者直接为 LDFCL 提交了代码。

## 历史版本

0.2.4 的标准 versions 目录隔离、已有版本原地管理与旧实例兼容由本项目独立实现，没有引入新的上游源码或依赖。

0.2.3 的实例左右布局、版本搜索、Mod 页面状态隔离及启动目录约束由本项目独立实现，没有引入新的上游源码或依赖。

0.2.2 的多游戏目录登记、程序旁默认目录解析、旧布局兼容、版本扫描与设置页由本项目独立实现，没有为该功能引入新的上游源码或依赖。既有来源及贡献说明如下。

感谢开源维护者、汉化贡献者和每位 Minecraft 内容作者。本页将实际使用的组件、阅读的公开实现和视觉参考分别记录，保留各项目本来的作者与许可。

## 本仓库的实现与贡献

- 功能范围与交互方向由本次需求提出者确定。
- LDFCL 的 Electron 主进程、React 界面、Minecraft 安装与启动服务、账号服务、内容管理、测试和文档由本次任务中的 Codex 协作编写。
- 本次检查时仓库尚无提交历史，因此不编造个人提交者名单。后续实际贡献者应按可核实的 Git 提交和作者意愿补充署名。
- 下列上游作者拥有其各自项目的贡献与版权；将他们列在这里致谢，不代表他们直接参与 LDFCL 开发、审核本项目或向本仓提交过代码。

本仓独立实现采用 [MIT License](LICENSE)。其他组件、协议、翻译数据和下载内容仍遵循各自的许可或服务条款。

## 界面与系统集成

当前 0.5.0 的玻璃界面采用 liquid-glass-react@1.1.1，包含卡片、导航、按钮及安装对话框的统一视觉。上游负责玻璃折射与高光渲染，本项目负责不参与形变的内容层、交互、尺寸适配和业务状态；Max Rovensky 保留其组件的 MIT 版权。以下 Mica / WinUI 阅读记录属于早期界面历史。

感谢 **SuGar0218** 发布 [TryLiquidGlass-WinUI3](https://github.com/SuGar0218/TryLiquidGlass-WinUI3)，为早期界面提供了视觉参考。2026-10-20 检查的 `main` 目录中未见公开许可证；本项目没有据此推定可以复制其代码或素材，也未移植它的 WinUI 控件、着色器或图片。

LDFCL 0.2.1 当时采用 Electron / React / CSS 实现的紧凑布局，在系统支持时通过 Electron `backgroundMaterial: "mica"` 使用 Windows 原生背景材质，并以约 94% 不透明的中性灰内容层保持文字可读性。Windows 10 或不支持材质的环境使用实色背景。这是历史实现说明，当前 0.5.0 renderer 的视觉由上述玻璃组件与新样式负责。

## Microsoft 设备代码授权与官方协议

0.2.1 的正版登录界面默认使用 Microsoft 设备代码授权：打开官方验证页面、显示可复制的代码、按服务端间隔查询结果，并支持取消和到期。应用必须支持个人 Microsoft 账号、启用公用客户端流程并具备所需 Minecraft API 访问资格；设备代码流程不需要本机回调 URI 或客户端密钥。相关协议由本项目独立实现。

感谢 **Microsoft Corporation 及 MSAL.js 贡献者** 公开 [microsoft-authentication-library-for-js](https://github.com/AzureAD/microsoft-authentication-library-for-js)。0.2.0 的浏览器授权码 + PKCE 实现阶段阅读了 `dev` 分支的 [LoopbackClient.ts](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/src/network/LoopbackClient.ts) 和根目录 [MIT 许可证](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/LICENSE)，用于理解本机回调监听、浏览器响应和关闭生命周期。LDFCL 未复制该文件，也未引入 MSAL 依赖。这一阅读记录及旧回归测试作为历史资料保留，不表示 0.2.1 的默认登录界面仍使用本机回调。

官方文档依据：

- [Microsoft Identity 设备代码协议](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)：请求字段、代码展示、服务端有效期、轮询间隔及错误处理。
- [桌面应用注册与公用客户端配置](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)：允许公用客户端流程，设备代码不需要重定向 URI。
- [应用注册与支持的账号类型](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)：选择支持个人 Microsoft 账号的注册类型。
- [Microsoft Identity 授权码与 PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) 和 [重定向 URI 规则](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)：此前 0.2.0 的实现依据。
- 用户指定的 [Xbox Live 身份验证与 XSTS 背景](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-xbox-live-authentication?view=gdk-2510)。

最后一篇主要解释 GDK 客户端/标题服务场景、XSTS 用户哈希与调用签名，不能替代 OAuth 应用注册或 Minecraft API 访问资格。LDFCL 使用 Java Minecraft 的 OAuth → Xbox Live → XSTS → Minecraft HTTP 令牌交换，没有引入 GDK / XSAPI 代码或声明实现标题服务调用签名。XBL/XSTS 中间令牌仅在内存中用于交换。

Microsoft、Xbox 和 Minecraft 账号连接保留 HTTPS 服务器证书验证；0.2.1 会阻断设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0` 的账号请求。Microsoft 密码由系统浏览器中的官方页面接收，LDFCL 仅接收授权结果与令牌。本轮设备代码自动测试及桌面专项已通过，使用受控服务响应；真实账号授权尚未验证。实际验证范围以 [VALIDATION.md](VALIDATION.md) 为准，不能将 0.2.0 的 PKCE 回归结果当作设备代码流程的验证证据。

## 启动器社区阅读

感谢 **Prism Launcher 维护者与贡献者** 的 [PrismLauncher](https://github.com/PrismLauncher/PrismLauncher)。本轮阅读了 `develop` 分支的 README、LICENSE 和 [MSAStep.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/develop/launcher/minecraft/auth/steps/MSAStep.cpp)，了解社区启动器的账号流程与许可边界。其 README 声明启动器代码为 **GPL-3.0-only**，标志与相关素材为 **CC BY-SA 4.0**；所阅源文件还保留来自 MultiMC 的 Apache-2.0 工作声明。LDFCL 未复制这些代码、图标、品牌或 OAuth 应用身份。

感谢 **huangyuhui 与 HMCL 贡献者** 的 [HMCL](https://github.com/HMCL-dev/HMCL)。本轮阅读了 `main` 分支的 LICENSE 和 [MicrosoftAccount.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/auth/microsoft/MicrosoftAccount.java)。所阅账号文件声明为 **GPL-3.0-or-later**，版权属于 huangyuhui 和贡献者。LDFCL 未导入其 Java 实现或借用其应用 Client ID；各 HMCL 文件以自身许可声明为准。

这里的阅读与致谢不是对上述项目源码的再许可。LDFCL 的 MIT 声明只覆盖本仓独立实现和明确采用兼容许可的实际依赖。

## 中文与 Minecraft 内容

感谢 **CFPAOrg 与 Minecraft Mod Language Package 贡献者** 对模组汉化的长期工作：[项目](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package)、[许可证](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/LICENSE)。本轮实际核对到的许可为 **CC BY-NC-SA 4.0**。该项目主要提供游戏内语言文件，LDFCL 本版没有复制、打包或转换其翻译数据。

本版内置的常用 Mod 中文名称、简介由本项目独立编写，以 MIT 提供；原项目名称、作者与 Modrinth 原文仍保留。未收录项目明确回退原文；用户自行导入的扩展翻译遵循其原有授权。

感谢 **Modrinth** 的 API 与平台维护者、各 **Mod / 整合包 / 资源包 / 光影包作者**。下载内容的授权由各项目作者决定，不因通过 LDFCL 安装而改变。

## 实际使用的开源代码组件

以下代码确实作为依赖用于 LDFCL；精确版本见 `package-lock.json`，完整许可文本及通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

| 组件                                                                      | 作者或版权声明                                          | 许可                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| [Electron](https://github.com/electron/electron)                          | Electron contributors；GitHub Inc.                      | MIT，另含 Chromium / Node.js 及其依赖通知 |
| [React / React DOM](https://github.com/facebook/react)                    | Meta Platforms, Inc. and affiliates                     | MIT                                       |
| [liquid-glass-react@1.1.1](https://github.com/rdev/liquid-glass-react)    | Max Rovensky；Copyright 2025 MAX ROVENSKY               | MIT                                       |
| [adm-zip](https://github.com/cthackers/adm-zip)                           | Another-D-Mention Software and other contributors       | MIT                                       |
| [skinview3d / skinview-utils](https://github.com/bs-community/skinview3d) | Kent Rasmussen；Haowei Wen、Sean Boult and contributors | MIT                                       |
| [Three.js](https://github.com/mrdoob/three.js)                            | three.js authors                                        | MIT                                       |
| [Lucide React](https://github.com/lucide-icons/lucide)                    | Lucide Contributors；Feather 部分为 Cole Bemis          | ISC / MIT                                 |

也感谢 TypeScript、Vite、electron-builder、Playwright、Prettier 及其依赖的开发者提供开发、打包与验证工具。

## 按需获取的运行库与服务

感谢 **Mojang / Microsoft** 提供游戏清单、资源和账号服务；**Fabric、Quilt、Forge、[NeoForged](https://neoforged.net/)** 维护加载器；**sp614x / OptiFine** 提供画面优化组件；**BMCLAPI** 提供 OptiFine 元数据、安装器及公开游戏资源镜像；**Eclipse Adoptium / Temurin、Azul / Zulu** 提供 OpenJDK 运行库；**yushijinhun 与 authlib-injector 贡献者** 提供第三方 Yggdrasil 兼容组件。

0.6.0 的 NeoForge 集成使用官方 Maven 元数据和安装器及其 SHA-1 校验文件，在独立阶段目录运行官方客户端安装流程；没有复制或内嵌 NeoForge 上游源码。资源包启停遵循 Minecraft options 格式，光影配置适配 Iris、Oculus、OptiFine；这些项目的作者及贡献者保留各自作品的版权。诊断功能仅使用本地规则，不依赖外部模型或第三方服务。

这些组件在用户请求相关操作时按需获取。Java 发行版及各加载器保留原有法律声明；authlib-injector 遵循其 GPL-3.0 许可。LDFCL 不重新授权这些软件，也不附送 Minecraft 游戏权益、正版皮肤或披风资格。

## 来源核对范围

liquid-glass-react 的固定提交 README / LICENSE 及本地安装的 1.1.1 包于 2026-10-21 核对；两处 LICENSE 的完整文本一致，版权行为 Copyright 2025 MAX ROVENSKY。该库是本版实际运行依赖，保留完整 MIT 通知；依赖集成不表示上游作者参与本项目开发或审核。

KAMUCL 的固定提交与许可证于 2026-10-21 直接读取；OptiFine / BMCLAPI 集成于同日读取公开版本 API，并实际下载、运行 Minecraft 1.12.2 HD_U_G5 官方安装器验证接口。其余既有来源于 2026-10-20 按所列公共分支及本地安装包 LICENSE 核对。GitHub 直连接口返回网关错误时，通过 jsDelivr 的 GitHub 镜像读取了对应 README、LICENSE 与源文件。分支链接可能随上游更新移动，本页不声称锁定了所有上游提交。若未来实际复制或改编上游源码，应另行记录具体文件、提交、改动及适用许可，更新本页和第三方通知。
