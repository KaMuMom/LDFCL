# 启动器内 Mod 中文目录

本功能翻译启动器中的 Mod 名称和简介，**不自动修改模组的游戏内语言文件**。内置 47 条常用模组目录，包含钠、锂、Fabric API、Iris、机械动力及其 Fabric 移植版、JEI/REI/EMI、玉、铁氧体磁芯、地图和常见工业/存储模组。

中文名采用社区通用名称或保留品牌名的说明性名称。简介由 LDFCL 项目重新编写，以 MIT 许可提供；不是从第三方百科或模组介绍页面整段抓取。模组自身的软件许可不随中文简介而改变。项目 ID/slug 在 2026-10-20 通过 Modrinth 公开 API 核对。

## 显示和搜索

- 浏览卡片、本地 Mod 列表和安装结果按稳定项目 ID、slug 或 JAR 的模组 ID 匹配，保留原始名字与说明。
- 输入常用中文名或目录别名（如「钠」「机械动力」「农夫乐事」）时，转换为原项目关键词检索；界面显示实际检索词。直接输入英文名、slug 和未知关键词时仍使用原搜索行为。
- 未命中目录的项目显示原名和原文，并明确标注「暂无中文 · 显示原文」，不会自动生成含义不明的译名。
- 卡片的「查看原文」可展开作者原始简介。中文数据的来源与许可可从标签提示中查看。

## 本地扩展

在启动器数据目录（默认 `启动器所在文件夹\LDFCL-data`）创建 `translations\mods\`，将 [示例 JSON](mod-translations.example.json) 复制为其中任意 `.json` 文件并修改。建议填写 Modrinth `projectId` 或 `slug`；本地 JAR 识别还可填写其 `modIds`。必须同时填写 `nameZh` 和 `descriptionZh`，无稳定标识的条目会忽略。

```text
启动器所在文件夹\LDFCL-data\translations\mods\my-translations.json
```

`schemaVersion` 当前为 `1`。本地条目优先于内置条目，多个文件按文件名读取，后读入的同标识条目优先。修改后等待约 3 秒，再搜索或刷新本地模组列表即可重新载入；也可重启启动器。单文件上限 1 MiB，最多读取 50 个文件、每文件 2,000 条。损坏 JSON 和不合格条目不会使内置目录失效。

`source`、`sourceUrl`、`license` 描述你提供的中文内容出处；应保留第三方翻译要求的署名和许可。只填写自己编写或获准使用的内容。

## 社区参考与许可核实

参考并感谢 [CFPAOrg/Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package) 的作者与社区贡献者。该项目主要维护游戏内语言资源。2026-10-20 实际查阅其 [`LICENSE`](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/blob/main/LICENSE)，为 **CC BY-NC-SA 4.0**（署名、非商业性使用、相同方式共享）。本次 GitHub API/raw 连接不稳定，通过 [jsDelivr 对该 GitHub 文件的镜像](https://cdn.jsdelivr.net/gh/CFPAOrg/Minecraft-Mod-Language-Package@main/LICENSE) 核实正文。

LDFCL **未复制、下载打包或重新许可 CFPA 的语言数据**，也不将该社区列为本项目中文简介的作者。用户若单独使用其资源，应遵守其许可。内置目录源码见 `electron/services/mod-translations.ts`。

项目身份和作者信息来自 [Modrinth API](https://docs.modrinth.com/api/)。卡片保留 Modrinth 返回的作者名，并链接原项目页面；这不等于相关模组作者参与了本启动器开发。
