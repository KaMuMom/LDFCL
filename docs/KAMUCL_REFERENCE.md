# 0.3.0 现有功能重构说明

参考项目：[YUN-SAN3/KAMUCL](https://github.com/YUN-SAN3/KAMUCL)。读取日期：2026-10-21。固定提交：`30874ab871c8ee00c1edab275bb3aeb25704330b`（package.json 1.1.9）。

本次以现有 LDFCL 为基础，阅读上游模块职责和边界后独立实现。保留紧凑 Win11 / Mica 界面、设备代码授权、任意游戏根和 `.minecraft/versions/<版本>` 隔离。首页右上角「安装新版本」移除，游戏安装仍在资源下载中。

| 参考模块                                                 | LDFCL 重构                                | 具体行为                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| core/download.ts、downloadLimits.ts、fileJobs.ts         | services/downloads.ts、download-queue.ts  | 游戏、Java、内容资源共用并发队列；同一目标串行校验与发布；支持 SHA-1 / SHA-256 / SHA-512 和大小校验；失败保留原文件，404 不重复请求 |
| shared/taskProgress.ts、downloadProgress.ts              | shared/task-progress.ts 与下载事件        | 批量下载可展示已收到的字节；只有校验发布完成的任务显示 100%，错误状态保留                                                           |
| core/java.ts、javaArchitecture.ts、javaScanUtils.ts      | services/java.ts、java-runtime.ts         | 解析 Java 属性、真实目录和架构，处理 javaw 与带引号路径；扩展本机发现，避免选择不兼容架构；自动补齐使用全新临时目录验证             |
| core/launchPreparation.ts、launchIntegrity.ts、launch.ts | services/launch-preparation.ts、game.ts   | 补齐并去重 classpath 参数；兼容旧版 Maven native classifier，尊重原生库排除规则，清理历史 DLL 残留                                  |
| core/accounts.ts                                         | services/accountLifecycle.ts、accounts.ts | 账号删除和同 ID 重新登录使旧请求失效，异步续期及档案响应不能恢复已删除账号；档案更新保留并发刷新后的令牌                            |
| core/community.ts 和 Mod 管理辅助模块                    | services/content.ts、mod-metadata.ts      | 分开解析所属 Mod 和依赖；统一禁用后缀、重复分组及扫描规则，避免把多个 Forge Mod 共同依赖的 minecraft / forge 当成重复项             |

Java 自动选择仍要求游戏所需主版本精确匹配，防止旧 Forge / Mod 被更高 Java 主版本破坏。本次没有把参考项目的全部功能加入 LDFCL；参考项目功能树用于理解架构，不作为本启动器已实现功能清单。

感谢 YUN-SAN3、kamubaba-i 和上游贡献者。上游 LICENSE 的 MIT 声明仅覆盖其原创贡献（Copyright (c) 2026 kamubaba-i），第三方部分各有授权与来源说明。本次未导入其代码、素材、二进制或应用身份；实际依赖及其他参考见根目录 CREDITS.md 和 THIRD_PARTY_NOTICES.md。测试与实机验证以 VALIDATION.md 为准。
