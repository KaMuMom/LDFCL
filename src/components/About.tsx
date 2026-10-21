import { ArrowUpRight, BookOpen, Code2, Heart, Scale } from "lucide-react";
import { GlassSurface } from "../ui/Glass";
import "./about.css";

type Props = {
  call: (method: string, payload?: any) => Promise<any>;
  notify: (message: string) => void;
  version: string;
};

const references = [
  {
    name: "OptiFine / BMCLAPI",
    author: "sp614x；bangbang93 与 BMCLAPI 贡献者",
    license: "OptiFine 保留其原有授权；镜像服务条款另见上游",
    relation:
      "OptiFine 版本目录与安装器通过 BMCLAPI 按需获取，由官方安装器生成独立游戏版本。本程序不附带 OptiFine JAR；Java 调用桥由本项目独立实现。",
    url: "https://optifine.net/",
  },
  {
    name: "KAMUCL",
    author: "YUN-SAN3 / kamubaba-i 与项目贡献者",
    license: "原创贡献 MIT；其他部分见上游说明",
    relation:
      "0.3.0 参考其下载、Java、启动准备、账号和 Mod 管理的模块划分，独立重构现有功能。参考提交 30874ab；未导入上游源码或应用身份。",
    url: "https://github.com/YUN-SAN3/KAMUCL/tree/30874ab871c8ee00c1edab275bb3aeb25704330b",
  },
  {
    name: "TryLiquidGlass-WinUI3",
    author: "SuGar0218",
    license: "未见公开许可证",
    relation:
      "早期界面的视觉参考，未移植其 WinUI 控件。当前玻璃界面使用 liquid-glass-react，按其公开文档重新构建。",
    url: "https://github.com/SuGar0218/TryLiquidGlass-WinUI3",
  },
  {
    name: "MSAL.js / LoopbackClient",
    author: "Microsoft Corporation 与贡献者",
    license: "MIT",
    relation:
      "此前浏览器授权的本地回调生命周期参考；本版使用设备代码，未引入 MSAL 源码。",
    url: "https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/src/network/LoopbackClient.ts",
  },
  {
    name: "Prism Launcher",
    author: "Prism Launcher 维护者与贡献者",
    license: "GPL-3.0-only",
    relation:
      "阅读其公开账号流程与许可，作为启动器生态参考；未导入其代码、图标或应用身份。",
    url: "https://github.com/PrismLauncher/PrismLauncher",
  },
  {
    name: "HMCL",
    author: "huangyuhui 与 HMCL 贡献者",
    license: "GPL-3.0-or-later（所阅账号文件）",
    relation:
      "公开账号实现与启动器生态参考；未导入其 Java 源码或借用其 OAuth Client ID。",
    url: "https://github.com/HMCL-dev/HMCL",
  },
  {
    name: "Minecraft Mod Language Package",
    author: "CFPAOrg 与汉化贡献者",
    license: "CC BY-NC-SA 4.0",
    relation:
      "感谢社区汉化工作。本版常用 Mod 中文目录自行编写，未收录该项目的翻译文件。",
    url: "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package",
  },
];

const libraries = [
  [
    "liquid-glass-react",
    "Max Rovensky",
    "MIT",
    "https://github.com/rdev/liquid-glass-react",
  ],
  [
    "Electron",
    "Electron contributors",
    "MIT",
    "https://github.com/electron/electron",
  ],
  [
    "React / React DOM",
    "Meta 与贡献者",
    "MIT",
    "https://github.com/facebook/react",
  ],
  [
    "adm-zip",
    "Another-D-Mention Software 与贡献者",
    "MIT",
    "https://github.com/cthackers/adm-zip",
  ],
  [
    "skinview3d / skinview-utils",
    "Kent Rasmussen、Haowei Wen、Sean Boult 与贡献者",
    "MIT",
    "https://github.com/bs-community/skinview3d",
  ],
  ["Three.js", "three.js authors", "MIT", "https://github.com/mrdoob/three.js"],
  [
    "Lucide React",
    "Lucide Contributors / Cole Bemis（Feather）",
    "ISC / MIT",
    "https://github.com/lucide-icons/lucide",
  ],
];

export default function About({ call, notify, version }: Props) {
  const open = (url: string) => {
    void call("external", { url }).catch((error: any) =>
      notify(String(error.message || error)),
    );
  };
  return (
    <div className="about-page">
      <div className="page-heading about-page-heading">
        <div>
          <div className="eyebrow">LDFCL · OPEN SOURCE</div>
          <h1>关于与致谢</h1>
          <p>版本 {version} · Windows 桌面启动器 · Minecraft Java Edition</p>
        </div>
        <span className="badge">MIT License</span>
      </div>
      <GlassSurface className="about-source about-section">
        <header className="about-section-heading">
          <span className="about-section-icon">
            <Code2 size={20} />
          </span>
          <div>
            <span className="about-section-caption">BUILT IN THE OPEN</span>
            <h3>源码与代码贡献</h3>
          </div>
        </header>
        <p className="about-prose">
          LDFCL 源码随发行版提供，采用 MIT
          许可。本仓的功能与交互方向由需求提出者确定， Codex
          协作完成界面、启动服务、测试与文档。个人贡献署名以可核实的 Git
          提交为准。
        </p>
        <p className="about-prose muted">
          感谢下面项目的作者与维护者。实际依赖、协议参考和视觉灵感分别注明；
          致谢不表示上游作者向 LDFCL
          提交过代码，也不表示项目之间存在隶属或背书关系。
        </p>
        <div className="about-interface-credit">
          <div>
            <strong>liquid-glass-react</strong>
            <p>当前界面使用的玻璃折射组件 · Max Rovensky · MIT</p>
          </div>
          <button
            className="btn subtle"
            onClick={() => open("https://github.com/rdev/liquid-glass-react")}
          >
            组件来源 <ArrowUpRight size={14} />
          </button>
        </div>
      </GlassSurface>
      <GlassSurface className="about-section about-community">
        <header className="about-section-heading">
          <span className="about-section-icon lavender">
            <Heart size={20} />
          </span>
          <div>
            <span className="about-section-caption">WITH THE COMMUNITY</span>
            <h3>开源参考与社区致谢</h3>
          </div>
        </header>
        <div className="about-reference-list">
          {references.map((project) => (
            <article key={project.name} className="about-reference">
              <div className="about-reference-heading">
                <div className="about-reference-title">
                  <strong>{project.name}</strong>
                  <span className="badge">{project.license}</span>
                </div>
                <button
                  className="btn subtle"
                  aria-label={`查看 ${project.name} 来源`}
                  onClick={() => open(project.url)}
                >
                  查看来源 <ArrowUpRight size={14} />
                </button>
              </div>
              <p className="about-reference-author">{project.author}</p>
              <p className="about-prose">{project.relation}</p>
            </article>
          ))}
        </div>
      </GlassSurface>
      <GlassSurface className="about-section about-services">
        <header className="about-section-heading">
          <span className="about-section-icon">
            <BookOpen size={20} />
          </span>
          <div>
            <span className="about-section-caption">PROTOCOLS & SERVICES</span>
            <h3>官方协议与服务</h3>
          </div>
        </header>
        <p className="about-prose">
          Microsoft Identity 的设备代码授权与 Xbox Live / XSTS
          文档用于协议背景。 本程序使用公开 HTTP 接口，未引入 GDK / XSAPI 代码。
          正版登录仍需自有且具备相应访问资格的应用 Client ID。
        </p>
        <div className="about-service-links">
          <button
            className="btn subtle"
            onClick={() =>
              open(
                "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code",
              )
            }
          >
            微软设备代码文档 <ArrowUpRight size={14} />
          </button>
          <button
            className="btn subtle"
            onClick={() =>
              open(
                "https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-xbox-live-authentication?view=gdk-2510",
              )
            }
          >
            Xbox Live / XSTS 文档 <ArrowUpRight size={14} />
          </button>
        </div>
        <p className="about-prose muted">
          同时感谢 Mojang /
          Microsoft、Modrinth、Fabric、Quilt、Forge、Adoptium、Azul 与
          authlib-injector 的维护者，以及每个
          Mod、整合包、资源包和光影包的作者。
        </p>
      </GlassSurface>
      <GlassSurface className="about-section about-dependencies">
        <header className="about-section-heading">
          <span className="about-section-icon lavender">
            <Scale size={20} />
          </span>
          <div>
            <span className="about-section-caption">
              OPEN SOURCE COMPONENTS
            </span>
            <h3>实际使用的开源组件</h3>
          </div>
        </header>
        <div className="about-library-grid">
          {libraries.map(([name, author, license, url]) => (
            <article key={name} className="about-library">
              <div className="about-library-copy">
                <strong>{name}</strong>
                <p>
                  {author} · {license}
                </p>
              </div>
              <button
                className="btn subtle"
                aria-label={`查看 ${name} 来源`}
                onClick={() => open(url)}
              >
                <ArrowUpRight size={14} />
              </button>
            </article>
          ))}
        </div>
        <p className="about-notices muted">
          完整来源、许可及本仓贡献说明见发行版 CREDITS.md 和
          THIRD_PARTY_NOTICES.md。 Minecraft
          游戏内容与各下载项目遵循其自身许可。
        </p>
      </GlassSurface>
    </div>
  );
}
