// Capture the shipped renderer with disposable, explicitly synthetic review data.
// Product files, personal accounts and game folders are never modified.
const { _electron: electron } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const AdmZip = require("adm-zip");

(async () => {
  const project = path.resolve(__dirname, "..");
  const version = require("../package.json").version;
  const capturedAt = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Hong_Kong",
  });
  const output = path.join(
    project,
    "release",
    `ui-review-${version}-${capturedAt.replace(/-/g, "")}`,
  );
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "LDFCL-UI-"));
  const root = path.join(temporary, ".minecraft");
  const groups = [
    { id: "home", title: "01 首页与版本切换", items: [] },
    { id: "instances", title: "02 游戏实例与 Mod 管理", items: [] },
    { id: "resources", title: "03 资源下载", items: [] },
    { id: "wardrobe", title: "04 皮肤、披风与编辑器", items: [] },
    { id: "accounts", title: "05 账号管理与登录", items: [] },
    { id: "system", title: "06 下载任务、设置、日志与致谢", items: [] },
  ];
  await fs.mkdir(path.join(output, "screenshots"), { recursive: true });
  const instances = [
    {
      id: "review-fabric",
      name: "生存世界",
      version: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.10",
      versionDirectory: "1.21.1-fabric",
      gameDirectoryId: "review-root",
      gameSettings: { lang: "zh_cn", renderDistance: 12, maxFps: 120 },
      createdAt: "2026-10-20T08:00:00+08:00",
    },
    {
      id: "review-optifine",
      name: "光影与建筑",
      version: "1.16.5",
      loader: "optifine",
      loaderVersion: "1.16.5_HD_U_G8",
      versionDirectory: "1.16.5-optifine",
      gameDirectoryId: "review-root",
      gameSettings: {},
      createdAt: "2026-10-20T08:00:00+08:00",
    },
    {
      id: "review-forge",
      name: "冒险整合包",
      version: "1.20.1",
      loader: "forge",
      loaderVersion: "47.3.0",
      versionDirectory: "1.20.1-forge",
      gameDirectoryId: "review-root",
      gameSettings: {},
      createdAt: "2026-10-20T08:00:00+08:00",
    },
  ];
  for (const instance of instances) {
    const dir = path.join(root, "versions", instance.versionDirectory);
    await fs.mkdir(path.join(dir, "mods"), { recursive: true });
    await fs.writeFile(
      path.join(dir, `${instance.versionDirectory}.json`),
      JSON.stringify({
        id: instance.versionDirectory,
        minecraftVersion: instance.version,
        type: "release",
        mainClass: "net.minecraft.client.main.Main",
        libraries: [],
      }),
    );
  }
  const modFixtures = [
    ["sodium", "Sodium", "0.6.0", "sodium-0.6.0.jar"],
    ["sodium", "Sodium", "0.5.11", "sodium-0.5.11.jar"],
    ["fabric-api", "Fabric API", "0.110.0", "fabric-api-0.110.0.jar"],
    ["iris", "Iris Shaders", "1.8.0", "iris-1.8.0.jar"],
    ["lithium", "Lithium", "0.14.2", "lithium-0.14.2.jar.disabled"],
  ];
  for (const [id, name, version, file] of modFixtures) {
    const zip = new AdmZip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(JSON.stringify({ schemaVersion: 1, id, name, version })),
    );
    await fs.writeFile(
      path.join(root, "versions", instances[0].versionDirectory, "mods", file),
      zip.toBuffer(),
    );
  }
  await fs.writeFile(
    path.join(temporary, "launcher.json"),
    JSON.stringify({
      instances,
      gameDirectories: [
        {
          id: "review-root",
          name: "默认游戏目录",
          path: root,
          layout: "standard",
        },
        {
          id: "review-custom",
          name: "自定义游戏目录",
          path: path.join(temporary, "我的整合包", ".minecraft"),
          layout: "standard",
        },
      ],
      selectedGameDirectoryId: "review-root",
      selectedInstanceId: instances[0].id,
      settings: { microsoftClientId: "11111111-2222-3333-4444-555555555555" },
    }),
  );
  const env = {
    ...process.env,
    LDFCL_DATA_DIR: temporary,
    LDFCL_GAME_ROOT: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: process.env.LDFCL_TEST_EXE
      ? path.resolve(process.env.LDFCL_TEST_EXE)
      : path.join(project, "release", "win-unpacked", "LDFCL.exe"),
    args: [],
    env,
    timeout: 45000,
  });
  const pageErrors = [];
  let count = 0;
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page
      .getByRole("heading", { name: "开始游戏", exact: true })
      .waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1120, 760),
    );
    const textures = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const c = canvas.getContext("2d");
      c.fillStyle = "#bd9270";
      c.fillRect(0, 0, 32, 16);
      c.fillRect(40, 16, 16, 16);
      c.fillRect(32, 48, 16, 16);
      c.fillStyle = "#302e30";
      c.fillRect(0, 0, 32, 7);
      c.fillRect(0, 7, 8, 9);
      c.fillRect(24, 7, 8, 9);
      c.fillStyle = "#f6f6ea";
      c.fillRect(9, 11, 2, 1);
      c.fillRect(13, 11, 2, 1);
      c.fillStyle = "#1d3436";
      c.fillRect(10, 11, 1, 1);
      c.fillRect(13, 11, 1, 1);
      c.fillStyle = "#986c57";
      c.fillRect(11, 13, 2, 1);
      c.fillStyle = "#5b8d7c";
      c.fillRect(16, 16, 24, 16);
      c.fillRect(40, 16, 16, 6);
      c.fillRect(32, 48, 16, 6);
      c.fillStyle = "#e2e2cc";
      c.fillRect(20, 20, 8, 1);
      c.fillRect(23, 21, 2, 5);
      c.fillStyle = "#293e48";
      c.fillRect(0, 16, 16, 16);
      c.fillRect(16, 48, 16, 16);
      const skin = canvas.toDataURL();
      canvas.width = 64;
      canvas.height = 32;
      c.fillStyle = "#376a9e";
      c.fillRect(0, 0, 64, 32);
      c.fillStyle = "#e7cb79";
      c.fillRect(3, 4, 8, 12);
      const cape = canvas.toDataURL();
      c.fillStyle = "#763e4c";
      c.fillRect(0, 0, 64, 32);
      c.fillStyle = "#f3e8cc";
      c.fillRect(4, 6, 7, 7);
      const cape2 = canvas.toDataURL();
      const icons = [
        "#008cbb",
        "#ed8144",
        "#7d59b7",
        "#468d69",
        "#b49a39",
        "#53647d",
      ].map((color, i) => {
        canvas.width = canvas.height = 96;
        c.fillStyle = color;
        c.fillRect(0, 0, 96, 96);
        c.fillStyle = "#ffffffdd";
        c.fillRect(25, 22, 46, 46);
        c.fillStyle = color;
        c.fillRect(34, 31, 28, 28);
        c.fillStyle = "#ffffffaa";
        c.fillRect(25, 73, 46 - i * 4, 4);
        return canvas.toDataURL();
      });
      return { skin, cape, cape2, icons };
    });
    await app.evaluate(({ ipcMain, BrowserWindow, shell }, textures) => {
      const original = ipcMain._invokeHandlers.get("launcher:call");
      const qa = (globalThis.__uiReview = {
        textures,
        selectedAccountId: "review-offline",
        empty: false,
        previewCalls: 0,
        skinLibrary: [
          {
            id: "review-library-explorer",
            name: "森林旅人",
            variant: "classic",
            createdAt: "2026-10-20T08:00:00+08:00",
            updatedAt: "2026-10-20T08:00:00+08:00",
            dataUrl: textures.skin,
          },
          {
            id: "review-library-builder",
            name: "建筑师",
            variant: "slim",
            createdAt: "2026-10-19T08:00:00+08:00",
            updatedAt: "2026-10-19T08:00:00+08:00",
            dataUrl: textures.skin,
          },
        ],
        favorites: [
          {
            projectId: "demo-mod-0",
            slug: "sodium",
            title: "Sodium",
            displayName: "钠",
            description: "提升渲染性能与帧率的客户端优化模组。",
            iconUrl: textures.icons[0],
            author: "CaffeineMC",
          },
        ],
      });
      qa.send = (event) =>
        BrowserWindow.getAllWindows()[0].webContents.send(
          "launcher:event",
          event,
        );
      const accounts = [
        {
          id: "review-offline",
          type: "offline",
          name: "Explorer",
          uuid: "00000000000000000000000000000001",
        },
        {
          id: "review-microsoft",
          type: "microsoft",
          name: "Alex_Demo",
          uuid: "00000000000000000000000000000002",
        },
        {
          id: "review-yggdrasil",
          type: "yggdrasil",
          name: "Skin_Demo",
          server: "https://skin.example.test/api/yggdrasil",
          uuid: "00000000000000000000000000000003",
        },
      ];
      const catalogue = {
        mod: [
          [
            "sodium",
            "Sodium",
            "钠",
            "提升渲染性能与帧率的客户端优化模组。",
            "A modern rendering engine and client optimization mod for Minecraft.",
          ],
          [
            "fabric-api",
            "Fabric API",
            "Fabric API",
            "Fabric 模组常用的基础接口与兼容组件。",
            "Lightweight and modular API providing common hooks and intercompatibility measures.",
          ],
          [
            "iris",
            "Iris Shaders",
            "Iris 光影",
            "在 Fabric 中加载光影，并与 Sodium 配合使用。",
            "A modern shaders mod for Minecraft intended to be compatible with existing shader packs.",
          ],
          [
            "lithium",
            "Lithium",
            "锂",
            "优化游戏逻辑，减少服务器与单人游戏运算开销。",
            "A general-purpose optimization mod which works to improve a number of systems.",
          ],
          [
            "modmenu",
            "Mod Menu",
            "模组菜单",
            "在游戏内查看已安装模组与配置入口。",
            "Adds a mod menu to view the list of mods you have installed.",
          ],
          [
            "ferrite-core",
            "FerriteCore",
            "铁氧体磁芯",
            "通过减少重复数据降低内存占用。",
            "Memory usage optimizations.",
          ],
        ],
        modpack: [
          [
            "fabulously-optimized",
            "Fabulously Optimized",
            "Fabulously Optimized",
            "A simple and light modpack for performance and graphics enhancements.",
          ],
          [
            "adrenaline",
            "Adrenaline",
            "Adrenaline",
            "A fast performance-focused Minecraft experience.",
          ],
          [
            "vanilla-perfect",
            "Vanilla Perfect",
            "Vanilla Perfect",
            "A carefully selected collection for a familiar survival world.",
          ],
          [
            "adventure-demo",
            "Adventure Collection",
            "Adventure Collection",
            "Explore new worlds with a complete selection of mods.",
          ],
        ],
        resourcepack: [
          [
            "fresh-animations",
            "Fresh Animations",
            "Fresh Animations",
            "Dynamic animations for the entities in Minecraft.",
          ],
          [
            "faithful-32x",
            "Faithful 32x",
            "Faithful 32x",
            "The classic Minecraft style with more detail.",
          ],
          [
            "better-leaves",
            "Better Leaves",
            "Better Leaves",
            "Fuller trees and a softer look for your world.",
          ],
          [
            "default-dark",
            "Default Dark",
            "Default Dark",
            "A clean dark interface with familiar textures.",
          ],
        ],
        shader: [
          [
            "complementary-reimagined",
            "Complementary Reimagined",
            "Complementary Reimagined",
            "High quality visuals with attention to detail.",
          ],
          [
            "bsl-shaders",
            "BSL Shaders",
            "BSL Shaders",
            "Bright lighting, atmospheric skies and realistic reflections.",
          ],
          [
            "makeup-ultra-fast",
            "MakeUp - Ultra Fast",
            "MakeUp - Ultra Fast",
            "A balance between image quality and performance.",
          ],
          [
            "sildurs",
            "Sildur's Vibrant Shaders",
            "Sildur's Vibrant Shaders",
            "Vibrant colors and dynamic shadows for your world.",
          ],
        ],
      };
      ipcMain.removeHandler("launcher:call");
      ipcMain.handle("launcher:call", async (event, method, payload = {}) => {
        if (method === "state") {
          const state = await original(event, method, payload);
          state.accounts = qa.empty ? [] : accounts;
          state.selectedAccountId = qa.empty ? undefined : qa.selectedAccountId;
          if (qa.empty) {
            state.instances = [];
            state.selectedInstanceId = undefined;
          }
          return state;
        }
        if (method === "select" && payload.accountId) {
          qa.selectedAccountId = payload.accountId;
          qa.send({ type: "state" });
          return true;
        }
        if (method === "skin:profile")
          return {
            name: accounts.find((a) => a.id === payload.id)?.name,
            editable: payload.id === "review-microsoft",
            manageUrl:
              payload.id === "review-yggdrasil"
                ? "https://skin.example.test"
                : undefined,
            skins:
              payload.id === "review-offline"
                ? []
                : [
                    {
                      id: "review-skin",
                      state: "ACTIVE",
                      variant: "CLASSIC",
                      url: textures.skin,
                    },
                  ],
            capes:
              payload.id === "review-microsoft"
                ? [
                    {
                      id: "demo-cape-one",
                      alias: "蓝金披风 · 演示",
                      state: "ACTIVE",
                      url: textures.cape,
                    },
                    {
                      id: "demo-cape-two",
                      alias: "红色披风 · 演示",
                      state: "INACTIVE",
                      url: textures.cape2,
                    },
                  ]
                : [],
          };
        if (method === "skin:preview") {
          const skin = qa.previewCalls++ % 2 === 0;
          return {
            url: skin ? textures.skin : textures.cape,
            name: skin ? "我的演示皮肤.png" : "我的演示披风.png",
          };
        }
        if (method === "skin-library:list") return qa.skinLibrary;
        if (method === "skin-library:rename") {
          const entry = qa.skinLibrary.find((item) => item.id === payload.id);
          if (!entry) throw Error("演示皮肤不存在");
          entry.name = String(payload.name).trim();
          entry.updatedAt = "2026-10-21T08:00:00+08:00";
          return entry;
        }
        if (method === "mod-favorites:list") return qa.favorites;
        if (method === "mod-favorites:set") {
          qa.favorites = qa.favorites.filter(
            (item) => item.projectId !== payload.project.projectId,
          );
          if (payload.saved) qa.favorites.unshift(payload.project);
          return qa.favorites;
        }
        if (method === "optifine:versions")
          return payload.version === "1.16.5"
            ? [
                {
                  id: "1.16.5_HD_U_G8",
                  minecraftVersion: "1.16.5",
                  type: "HD_U",
                  patch: "G8",
                  filename: "OptiFine_1.16.5_HD_U_G8.jar",
                  preview: false,
                },
                {
                  id: "1.16.5_HD_U_G8_pre1",
                  minecraftVersion: "1.16.5",
                  type: "HD_U",
                  patch: "G8_pre1",
                  filename: "preview_OptiFine_1.16.5_HD_U_G8_pre1.jar",
                  preview: true,
                },
              ]
            : [];
        if (method === "content:versions") {
          const forge = payload.instanceId === "review-forge";
          return ["0.6.1", "0.6.0"].map((version, index) => ({
            id: `review-${forge ? "forge" : "fabric"}-${index}`,
            project_id: payload.projectId,
            name: `Sodium ${version}`,
            version_number: version,
            version_type: index ? "beta" : "release",
            date_published: index
              ? "2026-10-18T08:00:00Z"
              : "2026-10-20T08:00:00Z",
            game_versions: [forge ? "1.20.1" : "1.21.1"],
            loaders: [forge ? "forge" : "fabric"],
            files: [{ filename: `review-sodium-${version}.jar` }],
            dependencies: [
              { project_id: "review-api", dependency_type: "required" },
            ],
          }));
        }
        if (method === "pack:versions")
          return [
            {
              id: "review-pack-release",
              name: "Fabulously Optimized 1.3.0",
              versionNumber: "1.3.0",
              versionType: "release",
              publishedAt: "2026-10-20T08:00:00Z",
              gameVersions: ["1.21.1"],
              loaders: ["fabric"],
              downloadSize: 5242880,
            },
            {
              id: "review-pack-beta",
              name: "Fabulously Optimized 1.2.0 Beta",
              versionNumber: "1.2.0-beta.1",
              versionType: "beta",
              publishedAt: "2026-10-18T08:00:00Z",
              gameVersions: ["1.20.1"],
              loaders: ["fabric"],
              downloadSize: 4194304,
            },
            {
              id: "review-pack-alpha",
              name: "Fabulously Optimized 1.1.0 Preview",
              versionNumber: "1.1.0-alpha.1",
              versionType: "alpha",
              publishedAt: "2026-10-16T08:00:00Z",
              gameVersions: ["1.20.1"],
              loaders: ["forge"],
              downloadSize: 3145728,
            },
          ];
        if (method === "versions")
          return [
            ...[
              "1.21.1",
              "1.21",
              "1.20.6",
              "1.20.4",
              "1.20.1",
              "1.19.4",
              "1.19.2",
              "1.18.2",
              "1.17.1",
              "1.16.5",
              "1.12.2",
              "1.8.9",
            ].map((id) => ({ id, type: "release" })),
            { id: "24w33a", type: "snapshot" },
            { id: "24w32a", type: "snapshot" },
            { id: "b1.7.3", type: "old_beta" },
          ];
        if (method === "content:search") {
          const source = catalogue[payload.type] || catalogue.mod;
          const hits = source.map(
            (
              [slug, title, displayName, description, originalDescription],
              index,
            ) => ({
              project_id: `demo-${payload.type}-${index}`,
              slug,
              title,
              displayName,
              originalName: title,
              description,
              displayDescription: description,
              originalDescription,
              author: ["CaffeineMC", "FabricMC", "IrisShaders", "Community"][
                index % 4
              ],
              downloads: 34000000 - index * 2600000,
              icon_url: textures.icons[index % textures.icons.length],
              display_categories:
                payload.type === "mod"
                  ? ["optimization", "fabric"]
                  : [payload.type, "decoration"],
              translation:
                payload.type === "mod"
                  ? {
                      status: "translated",
                      source: "LDFCL 原创中文目录",
                      license: "MIT",
                    }
                  : undefined,
            }),
          );
          const q = String(payload.query || "").toLowerCase();
          const filtered = q
            ? hits.filter((hit) =>
                [hit.title, hit.displayName, hit.slug]
                  .join(" ")
                  .toLowerCase()
                  .includes(q),
              )
            : hits;
          return {
            hits: filtered,
            total_hits: filtered.length,
            queryTranslation: {
              originalQuery: q,
              effectiveQuery: q,
              translated: false,
            },
          };
        }
        if (method === "mods:updates")
          return [
            {
              file: "sodium-0.6.0.jar",
              name: "Sodium",
              currentVersion: "0.6.0",
              version: "0.6.1",
              versionId: "review-only",
            },
          ];
        if (method === "account:microsoft") {
          qa.send({
            type: "auth-status",
            flow: "device",
            status: "waiting",
            userCode: "DEMO-CODE",
            verificationUri: "https://microsoft.com/devicelogin",
            expiresIn: 600,
            message: "在已打开的微软页面输入以下授权码：",
          });
          return true;
        }
        if (method === "account:cancel") {
          qa.send({ type: "auth-status", flow: "device", status: "cancelled" });
          return true;
        }
        if (
          [
            "launch",
            "install",
            "pack:install",
            "content:install",
            "mods:apply",
            "account:yggdrasil",
            "account:remove",
            "instance:delete",
            "skin:upload",
            "skin:saveEdited",
            "skin:reset",
            "skin:cape",
            "skin-library:import",
            "skin-library:save",
            "skin-library:remove",
            "skin-library:apply",
            "skin-library:export",
            "external",
          ].includes(method)
        )
          throw Error("截图会话不会执行此操作");
        return original(event, method, payload);
      });
      shell.openExternal = async () => {};
      shell.trashItem = async () => {
        throw Error("Screenshot session cannot delete files");
      };
      qa.send({ type: "state" });
    }, textures);

    const nav = async (name) => {
      await page
        .locator("aside.sidebar")
        .getByRole("button", { name, exact: true })
        .click();
      await page.locator(".main-content").evaluate((el) => {
        el.scrollTop = 0;
      });
    };
    const scroll = async (selector, where) =>
      page.locator(selector).evaluate((el, value) => {
        el.scrollTop = value === "bottom" ? el.scrollHeight : value;
      }, where);
    const dismissToast = async () => {
      const close = page.getByRole("button", { name: "关闭提示", exact: true });
      if (await close.count()) await close.click();
    };
    const shot = async (groupId, id, title, description = "") => {
      await dismissToast();
      await page.mouse.move(600, 28);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      const file = `screenshots/${id}.png`;
      await page.screenshot({
        path: path.join(output, file),
        animations: "disabled",
      });
      groups
        .find((g) => g.id === groupId)
        .items.push({ id, title, file, description });
      console.log(`Captured ${++count}: ${id} ${title}`);
      await fs.writeFile(
        path.join(output, "manifest.json"),
        JSON.stringify(
          {
            version,
            capturedAt,
            window: { width: 1120, height: 760 },
            note: "原始程序截图，演示账号、文件、资源列表、任务与授权码均为受控夹具；未登录真实账号或启动游戏。",
            groups,
          },
          null,
          2,
        ),
      );
    };
    const authEvent = async (data) =>
      app.evaluate(
        (_electron, data) =>
          globalThis.__uiReview.send({
            type: "auth-status",
            flow: "device",
            ...data,
          }),
        data,
      );
    await page
      .getByLabel("首页账号", { exact: true })
      .selectOption("review-offline");
    const homePause = page.getByRole("button", {
      name: "暂停自动旋转",
      exact: true,
    });
    if (await homePause.count()) await homePause.click();
    await shot("home", "01-home", "首页 · 已选择账号和版本");
    await page.getByRole("button", { name: "切换版本", exact: true }).click();
    await shot("home", "02-version-picker", "首页 · 切换游戏版本弹窗");
    await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await nav("游戏实例");
    await page.locator(".mod-row").first().waitFor();
    await shot("instances", "05-mods", "游戏实例 · Mod 管理");
    await page.getByRole("button", { name: "重复检测", exact: true }).click();
    await page.getByText("发现 1 组重复项", { exact: true }).waitFor();
    await shot("instances", "06-duplicate-mods", "Mod 管理 · 重复检测结果");
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByRole("button", { name: "全部更新", exact: true }).waitFor();
    await shot(
      "instances",
      "07-mod-updates",
      "Mod 管理 · 可更新提示",
      "更新结果为演示数据，未下载或替换文件。",
    );
    await page.getByRole("button", { name: "实例概览", exact: true }).click();
    await shot("instances", "08-instance-overview", "游戏实例 · 实例概览");
    await page.getByRole("button", { name: "游戏预设", exact: true }).click();
    await shot("instances", "09-game-options-top", "游戏预设 · 上半部分");
    await scroll(".main-content", "bottom");
    await shot("instances", "10-game-options-bottom", "游戏预设 · 下半部分");
    await page.getByRole("button", { name: "实例设置", exact: true }).click();
    await shot("instances", "11-instance-settings", "游戏实例 · 实例设置");
    await page.getByRole("button", { name: "移除实例", exact: true }).click();
    await shot(
      "instances",
      "12-instance-delete-confirm",
      "实例设置 · 移除确认状态",
      "仅展示确认状态，未执行移除。",
    );

    await nav("资源下载");
    const resources = page.locator(".resource-downloads");
    const game = resources.getByRole("tabpanel", {
      name: "Minecraft 下载",
      exact: true,
    });
    await game.locator(".version-list button").first().waitFor();
    for (const [i, loader, label] of [
      [13, "vanilla", "原版"],
      [14, "fabric", "Fabric"],
      [15, "quilt", "Quilt"],
      [16, "forge", "Forge"],
    ]) {
      await game.getByLabel("模组加载器", { exact: true }).selectOption(loader);
      await shot(
        "resources",
        `${i}-minecraft-${loader}`,
        `Minecraft 下载 · ${label}`,
      );
    }
    await game
      .locator(".version-list button")
      .filter({ hasText: "1.16.5" })
      .click();
    await game
      .getByLabel("模组加载器", { exact: true })
      .selectOption("optifine");
    await game
      .getByLabel("OptiFine 发行版本", { exact: true })
      .getByRole("option", { name: "1.16.5_HD_U_G8 · 正式版", exact: true })
      .waitFor({ state: "attached" });
    await shot(
      "resources",
      "16b-minecraft-optifine",
      "Minecraft 下载 · OptiFine 发行版本",
      "发行版目录为演示夹具，仅展示安装配置，未下载安装器或游戏。",
    );
    await game.getByLabel("模组加载器", { exact: true }).selectOption("forge");
    await game
      .getByRole("checkbox", { name: "快照与旧版", exact: true })
      .check();
    await game.getByLabel("搜索游戏版本", { exact: true }).fill("24w");
    await game.locator(".version-list button").first().click();
    await shot(
      "resources",
      "17-minecraft-snapshots",
      "Minecraft 下载 · 快照与搜索筛选",
    );
    for (const [name, id, title] of [
      ["Mod 模组", "18-mod-downloads", "Mod 模组下载"],
      ["整合包", "20-modpacks", "整合包下载"],
      ["资源包", "21-resourcepacks", "资源包下载"],
      ["光影包", "22-shaders", "光影包下载"],
    ]) {
      await resources.getByRole("tab", { name, exact: true }).click();
      const panel = resources.getByRole("tabpanel", { name, exact: true });
      await panel.locator("article.content-card").first().waitFor();
      await shot(
        "resources",
        id,
        title,
        "列表为用于布局审阅的演示资源，未执行安装。",
      );
      if (name === "Mod 模组") {
        await panel
          .locator("details.project-original > summary")
          .first()
          .click();
        await shot("resources", "19-mod-original-text", "Mod 下载 · 展开原文");
        await panel
          .getByRole("button", { name: "选择安装位置", exact: true })
          .first()
          .click();
        const modDialog = page.getByRole("dialog", {
          name: "选择模组安装位置",
          exact: true,
        });
        await modDialog
          .getByLabel("模组发行版本", { exact: true })
          .getByRole("option", { name: /0\.6\.1/ })
          .waitFor({ state: "attached" });
        await shot(
          "resources",
          "19b-mod-target-version-dependencies",
          "Mod 安装 · 目标版本与必需前置策略",
          "兼容发行版与前置元数据为演示夹具，仅展示选择流程，未安装 Mod。",
        );
        await modDialog
          .getByLabel("目标游戏版本", { exact: true })
          .selectOption("review-forge");
        await modDialog
          .getByLabel("模组发行版本", { exact: true })
          .getByRole("option", { name: /0\.6\.0/ })
          .waitFor({ state: "attached" });
        await modDialog
          .getByLabel("模组发行版本", { exact: true })
          .selectOption("review-forge-1");
        await shot(
          "resources",
          "19c-mod-other-target",
          "Mod 安装 · 切换目标与指定发行版",
          "版本组合为受控布局夹具，不表示该项目实际发布此兼容版本。",
        );
        await modDialog
          .getByLabel("目标游戏版本", { exact: true })
          .selectOption("review-optifine");
        await shot(
          "resources",
          "19d-mod-incompatible-target",
          "Mod 安装 · 不支持的目标提示",
        );
        await modDialog
          .getByRole("button", { name: "关闭模组安装选择", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "只看收藏", exact: true })
          .click();
        await panel
          .getByRole("button", { name: "取消收藏 Sodium", exact: true })
          .waitFor();
        await shot(
          "resources",
          "19e-mod-favorites",
          "Mod 下载 · 收藏列表",
          "收藏条目为演示数据。",
        );
        await panel
          .getByRole("button", { name: "只看收藏", exact: true })
          .click();
      }
      if (name === "整合包") {
        await panel
          .getByRole("button", { name: "选择版本", exact: true })
          .first()
          .click();
        const packDialog = page.getByRole("dialog", {
          name: "选择整合包版本",
          exact: true,
        });
        await packDialog.getByRole("radio").first().check();
        await shot(
          "resources",
          "20b-modpack-versions",
          "整合包 · 选择发行版本",
          "整合包发行版为演示夹具，未下载或导入整合包。",
        );
        await packDialog
          .getByRole("combobox", { name: /^Minecraft 版本/ })
          .selectOption("1.20.1");
        await packDialog
          .getByRole("combobox", { name: /^模组加载器/ })
          .selectOption("forge");
        await packDialog.getByRole("radio").first().check();
        await shot(
          "resources",
          "20c-modpack-version-filters",
          "整合包 · 游戏版本与加载器筛选",
        );
        await packDialog
          .getByRole("button", { name: "关闭版本选择", exact: true })
          .click();
      }
    }

    await nav("皮肤与披风");
    await page.locator(".wardrobe-stage canvas").waitFor();
    const pause = page.getByRole("button", {
      name: "暂停自动旋转",
      exact: true,
    });
    if (await pause.count()) await pause.click();
    await shot("wardrobe", "23-wardrobe-offline", "皮肤与披风 · 离线预览");
    await page.getByRole("button", { name: "图形编辑", exact: true }).click();
    await page
      .getByRole("dialog", { name: "皮肤像素编辑器", exact: true })
      .waitFor();
    await shot("wardrobe", "28-skin-editor-local", "皮肤像素编辑器 · 本地模式");
    await page.getByRole("button", { name: "关闭编辑器", exact: true }).click();
    await page
      .getByLabel("正在管理的账号", { exact: true })
      .selectOption("review-microsoft");
    await page
      .getByRole("button", { name: "上传皮肤至正版账号", exact: true })
      .waitFor();
    await scroll(".main-content", 0);
    await shot(
      "wardrobe",
      "24-wardrobe-microsoft-top",
      "皮肤与披风 · 正版账号",
      "正版账号和披风收藏均为演示数据，无真实账号操作。",
    );
    await page
      .getByRole("heading", { name: "披风收藏", exact: true })
      .evaluate((element) =>
        element.closest("section").scrollIntoView({ block: "end" }),
      );
    await shot(
      "wardrobe",
      "25-wardrobe-capes",
      "正版衣柜 · 披风收藏与页面下半部分",
    );
    await page.getByRole("button", { name: "图形编辑", exact: true }).click();
    await shot(
      "wardrobe",
      "29-skin-editor-microsoft",
      "皮肤像素编辑器 · 正版同步入口",
    );
    await page.getByRole("button", { name: "关闭编辑器", exact: true }).click();
    await page
      .getByLabel("正在管理的账号", { exact: true })
      .selectOption("review-yggdrasil");
    await page.getByRole("button", { name: /前往皮肤站管理/ }).waitFor();
    await scroll(".main-content", 0);
    await shot("wardrobe", "26-wardrobe-skin-site", "皮肤与披风 · 其他皮肤站");
    await page
      .getByLabel("正在管理的账号", { exact: true })
      .selectOption("review-offline");
    await page.getByRole("button", { name: "导入预览", exact: true }).click();
    await page
      .getByRole("button", { name: "预览本地披风", exact: true })
      .click();
    await dismissToast();
    await page
      .getByRole("heading", { name: "披风收藏", exact: true })
      .evaluate((element) =>
        element.closest("section").scrollIntoView({ block: "end" }),
      );
    await shot(
      "wardrobe",
      "27-wardrobe-local-textures",
      "皮肤与披风 · 本地纹理预览",
    );
    const library = page.getByLabel("本地皮肤库", { exact: true });
    await library.locator("article.skin-library-card").first().waitFor();
    await library.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await shot(
      "wardrobe",
      "27b-skin-library",
      "本地皮肤库 · 收藏与经典、纤细模型",
      "收藏的 PNG 和名称为演示数据，不读取个人皮肤库。",
    );
    await library
      .getByRole("button", { name: "重命名皮肤 森林旅人", exact: true })
      .click();
    const rename = page.getByRole("dialog", {
      name: "重命名皮肤",
      exact: true,
    });
    await rename
      .getByLabel("皮肤名称", { exact: true })
      .fill("森林旅人 · 周末搭配");
    await shot("wardrobe", "27c-skin-library-rename", "本地皮肤库 · 重命名");
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    await rename.waitFor({ state: "hidden" });
    await library
      .getByRole("heading", { name: "森林旅人 · 周末搭配", exact: true })
      .waitFor();
    await shot(
      "wardrobe",
      "27d-skin-library-renamed",
      "本地皮肤库 · 重命名后的收藏",
      "仅更新截图会话的内存夹具，未修改皮肤文件。",
    );
    await library
      .getByRole("button", {
        name: "删除皮肤 森林旅人 · 周末搭配",
        exact: true,
      })
      .click();
    const removeSkin = page.getByRole("dialog", {
      name: "删除收藏皮肤",
      exact: true,
    });
    await shot(
      "wardrobe",
      "27e-skin-library-delete-confirm",
      "本地皮肤库 · 删除确认",
      "仅展示确认窗口，未执行删除。",
    );
    await removeSkin.getByRole("button", { name: "取消", exact: true }).click();

    await nav("开始游戏");
    await page
      .locator("aside.sidebar")
      .getByRole("button", { name: "账号管理", exact: true })
      .click();
    const accountDialog = page.getByRole("dialog", {
      name: "你的冒险身份",
      exact: true,
    });
    await accountDialog.waitFor();
    await shot("accounts", "30-account-microsoft", "账号管理 · 正版登录");
    await accountDialog.locator("details.auth-config > summary").click();
    await shot(
      "accounts",
      "30b-account-microsoft-config",
      "正版登录 · 展开应用授权配置",
    );
    await accountDialog.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await shot(
      "accounts",
      "30c-account-microsoft-config-bottom",
      "正版登录 · 配置与登录按钮",
      "同一弹窗滚动至底部。",
    );
    await accountDialog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await accountDialog
      .getByRole("button", { name: "离线账号", exact: true })
      .click();
    await accountDialog.getByPlaceholder("Steve").fill("New_Explorer");
    await shot("accounts", "31-account-offline", "账号管理 · 添加离线账号");
    await accountDialog
      .getByRole("button", { name: "其他皮肤站", exact: true })
      .click();
    await accountDialog
      .getByPlaceholder("https://皮肤站/api/yggdrasil")
      .fill("https://skin.example.test/api/yggdrasil");
    await shot("accounts", "32-account-skin-site", "账号管理 · 其他皮肤站登录");
    await accountDialog
      .getByRole("button", { name: "正版登录", exact: true })
      .click();
    await accountDialog
      .getByRole("button", { name: "开始微软登录", exact: true })
      .click();
    await accountDialog.getByLabel("微软授权码", { exact: true }).waitFor();
    await shot(
      "accounts",
      "33-account-device-code",
      "正版登录 · 等待设备代码授权",
      "DEMO-CODE 为演示授权码，不会连接或登录 Microsoft。",
    );
    await authEvent({
      status: "authenticating",
      message: "正在验证游戏权益并读取玩家档案…",
    });
    await shot(
      "accounts",
      "34-account-authenticating",
      "正版登录 · 正在获取玩家档案",
    );
    await authEvent({
      status: "error",
      message: "授权已取消或失效，请重新开始微软登录。",
    });
    await shot("accounts", "35-account-error", "正版登录 · 错误与重试状态");
    await accountDialog
      .getByRole("button", { name: "关闭弹窗", exact: true })
      .click();

    await nav("下载任务");
    await shot("system", "37-downloads-empty", "下载任务 · 空列表");
    await app.evaluate(() => {
      for (const task of [
        {
          id: "review-task-1",
          title: "Minecraft 1.21.1 · Fabric",
          progress: 68,
          status: "downloading",
          detail: "下载游戏资源 · 824 / 1,208",
        },
        {
          id: "review-task-2",
          title: "Sodium · Mod 更新",
          progress: 100,
          status: "completed",
          detail: "已完成 · 旧文件已备份",
        },
        {
          id: "review-task-3",
          title: "Complementary Reimagined",
          progress: 34,
          status: "error",
          detail: "网络连接中断，请重试",
        },
      ])
        globalThis.__uiReview.send({ type: "task", task });
    });
    await shot(
      "system",
      "36-downloads-active",
      "下载任务 · 进行中、完成与失败",
      "任务和进度为演示事件，未实际下载。",
    );
    await nav("启动器设置");
    await page
      .getByRole("heading", { name: "游戏目录", exact: true })
      .evaluate((element) =>
        element.closest("section").scrollIntoView({ block: "start" }),
      );
    await shot("system", "38-settings-directories", "启动器设置 · 游戏目录");
    const gameDefaults = page.getByLabel("通用游戏设置", { exact: true });
    await page
      .getByRole("button", { name: "启用通用游戏设置", exact: true })
      .click();
    await gameDefaults.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await shot(
      "system",
      "38b-settings-game-defaults",
      "启动器设置 · 通用游戏预设",
      "只切换表单状态，未点击保存设置。",
    );
    await gameDefaults
      .getByRole("button", { name: "视角摇晃", exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "end" }));
    await shot(
      "system",
      "38c-settings-game-defaults-bottom",
      "通用游戏预设 · 语言与开关选项",
    );
    await page.getByRole("button", { name: "手动调整", exact: true }).click();
    await page
      .getByText("内存分配", { exact: true })
      .evaluate((el) =>
        el.closest("section").scrollIntoView({ block: "start" }),
      );
    await shot(
      "system",
      "39-settings-memory-downloads",
      "启动器设置 · 内存与下载线程",
    );
    await scroll(".main-content", "bottom");
    await shot(
      "system",
      "40-settings-java-workspace",
      "启动器设置 · Java 与工作空间",
    );
    await nav("运行日志");
    await app.evaluate(() => {
      for (const line of [
        "[LDFCL] 界面审阅演示日志，未启动 Minecraft。",
        "[INFO] Selected instance: 1.21.1-fabric",
        "[INFO] Java requirement: 21 · automatic selection",
        "[INFO] Shared assets and libraries ready",
        "[INFO] Isolated gameDir: .minecraft/versions/1.21.1-fabric",
        "[INFO] Waiting for user to launch the game…",
      ])
        globalThis.__uiReview.send({ type: "log", line });
    });
    await shot("system", "41-runtime-logs", "运行日志");
    await nav("关于与致谢");
    await shot("system", "42-about-top", "关于与致谢 · 项目信息");
    await scroll(".main-content", 530);
    await shot("system", "43-about-middle", "关于与致谢 · 项目参考与贡献");
    await scroll(".main-content", "bottom");
    await shot("system", "44-about-bottom", "关于与致谢 · 开源依赖与官方文档");

    await app.evaluate(() => {
      globalThis.__uiReview.empty = true;
      globalThis.__uiReview.send({ type: "state" });
    });
    await nav("开始游戏");
    await page.getByRole("button", { name: "安装游戏", exact: true }).waitFor();
    await shot("home", "03-home-first-run", "首页 · 首次启动空状态");
    await nav("游戏实例");
    await page.getByText("还没有安装游戏版本", { exact: true }).waitFor();
    await shot("home", "04-instances-empty", "游戏实例 · 无版本空状态");
    for (const group of groups)
      group.items.sort((a, b) => a.id.localeCompare(b.id));
    const normalized = path.join(output, "normalized-screenshots");
    await fs.mkdir(normalized, { recursive: true });
    let number = 0;
    for (const group of groups)
      for (const item of group.items) {
        const name = `${String(++number).padStart(2, "0")}-${item.id.slice(item.id.indexOf("-") + 1)}.png`;
        await fs.copyFile(
          path.join(output, item.file),
          path.join(normalized, name),
        );
        item.id = name.slice(0, -4);
        item.file = `screenshots/${name}`;
      }
    await fs.rm(path.join(output, "screenshots"), {
      recursive: true,
      force: true,
    });
    await fs.rename(normalized, path.join(output, "screenshots"));
    if (pageErrors.length)
      throw Error(`Renderer errors: ${pageErrors.join("; ")}`);
    const manifest = {
      version,
      capturedAt,
      window: { width: 1120, height: 760 },
      note: `原始程序截图，演示账号、文件、资源列表、任务与授权码均为受控夹具；未登录真实账号或启动游戏。所有产品布局均来自当前 ${version} 发行版。`,
      pageErrors,
      groups,
    };
    await fs.writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    console.log(JSON.stringify({ passed: true, count, pageErrors, output }));
  } finally {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
