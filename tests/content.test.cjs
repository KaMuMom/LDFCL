const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const Zip = require("adm-zip");
const {
  ContentService,
  contentSafety,
} = require("../dist-electron/electron/services/content.js");
const {
  ModTranslationCatalog,
  BUILTIN_MOD_TRANSLATIONS,
} = require("../dist-electron/electron/services/mod-translations.js");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ldfcl-content-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instance = {
    id: "isolated",
    name: "Fixture",
    version: "1.20.1",
    loader: "fabric",
    loaderVersion: "0.16.10",
    createdAt: new Date().toISOString(),
    gameSettings: {},
  };
  const minecraftRoot = path.join(root, "minecraft");
  const gameDir = path.join(minecraftRoot, "versions", instance.id);
  const modsDir = path.join(gameDir, "mods");
  await fs.mkdir(modsDir, { recursive: true });
  return {
    root,
    instance,
    minecraftRoot,
    gameDir,
    modsDir,
    service: new ContentService(root, () => {}),
  };
}

function modArchive(id, name, version = "1.0.0") {
  const zip = new Zip();
  zip.addFile(
    "fabric.mod.json",
    Buffer.from(JSON.stringify({ id, name, version })),
  );
  return zip.toBuffer();
}

function packArchive(instance, entries = [], files = []) {
  const zip = new Zip();
  zip.addFile(
    "modrinth.index.json",
    Buffer.from(
      JSON.stringify({
        game: "minecraft",
        formatVersion: 1,
        name: "Version Directory Pack",
        dependencies: {
          minecraft: instance.version,
          "fabric-loader": instance.loaderVersion,
        },
        files,
      }),
    ),
  );
  for (const [entry, bytes] of entries) zip.addFile(entry, Buffer.from(bytes));
  return zip.toBuffer();
}

function packRelease(id, extra = {}) {
  return {
    id,
    project_id: "pack-project",
    name: `Pack ${id}`,
    version_number: id,
    version_type: "release",
    date_published: "2026-01-01T00:00:00Z",
    game_versions: ["1.20.1"],
    loaders: ["fabric"],
    files: [
      {
        filename: `${id}.mrpack`,
        url: `https://cdn.modrinth.com/${id}.mrpack`,
        primary: true,
        size: 1234,
        hashes: { sha1: "a".repeat(40), sha512: "b".repeat(128) },
      },
    ],
    ...extra,
  };
}

test("pack version lists include all Minecraft versions and loaders, sort by publication and expose selected archive metadata", async (t) => {
  const { service } = await fixture(t);
  const requested = [];
  const releases = [
    packRelease("old", {
      name: "旧版",
      version_number: "1.0",
      date_published: "2024-01-01T00:00:00Z",
      game_versions: ["1.18.2"],
      loaders: ["forge"],
    }),
    packRelease("alpha", {
      version_type: "alpha",
      date_published: "2026-08-01T00:00:00Z",
      game_versions: ["1.21.1", "1.21.2"],
      loaders: ["neoforge"],
    }),
    packRelease("beta", {
      version_type: "beta",
      date_published: "2025-09-01T00:00:00Z",
      loaders: ["quilt"],
      files: [
        {
          filename: "readme.zip",
          url: "https://cdn.modrinth.com/readme.zip",
          primary: true,
          size: 999,
        },
        {
          filename: "secondary.mrpack",
          url: "https://cdn.modrinth.com/secondary.mrpack",
          size: 10,
        },
        {
          filename: "selected.MRPACK",
          url: "https://cdn.modrinth.com/selected.MRPACK",
          primary: true,
          size: 5678,
        },
      ],
    }),
    packRelease("no-archive", {
      files: [
        {
          filename: "installer.zip",
          url: "https://cdn.modrinth.com/installer.zip",
        },
      ],
    }),
    packRelease("other-project", { project_id: "unrelated" }),
    packRelease("bad-url", {
      files: [
        { filename: "bad.mrpack", url: "http://cdn.modrinth.com/bad.mrpack" },
      ],
    }),
    packRelease("unsafe", {
      files: [
        {
          filename: "../bad.mrpack",
          url: "https://cdn.modrinth.com/bad.mrpack",
        },
      ],
    }),
  ];
  service.request = async (route) => {
    requested.push(route);
    if (route === "/project/pack-slug")
      return { id: "pack-project", project_type: "modpack" };
    if (route === "/project/pack-slug/version?") return releases;
    throw new Error(`unexpected route ${route}`);
  };
  const versions = await service.packVersions("pack-slug");
  assert.deepEqual(
    versions.map((version) => version.id),
    ["alpha", "beta", "old"],
  );
  assert.deepEqual(versions[2], {
    id: "old",
    name: "旧版",
    versionNumber: "1.0",
    versionType: "release",
    publishedAt: "2024-01-01T00:00:00Z",
    gameVersions: ["1.18.2"],
    loaders: ["forge"],
    downloadSize: 1234,
  });
  assert.equal(versions[0].versionType, "alpha");
  assert.deepEqual(versions[0].gameVersions, ["1.21.1", "1.21.2"]);
  assert.deepEqual(versions[0].loaders, ["neoforge"]);
  assert.equal(versions[1].versionType, "beta");
  assert.equal(versions[1].downloadSize, 5678);
  assert.deepEqual(requested, [
    "/project/pack-slug",
    "/project/pack-slug/version?",
  ]);
});

test("pack versions reject other project types and return an empty list when no usable mrpack exists", async (t) => {
  const { service } = await fixture(t);
  let listRequests = 0;
  service.request = async () => ({ id: "pack-project", project_type: "mod" });
  service.projectVersions = async () => {
    listRequests++;
    return [];
  };
  await assert.rejects(service.packVersions("pack-project"), /不是整合包/);
  assert.equal(listRequests, 0);
  service.request = async () => ({
    id: "pack-project",
    project_type: "modpack",
  });
  service.projectVersions = async () => [
    packRelease("zip-only", {
      files: [
        { filename: "pack.zip", url: "https://cdn.modrinth.com/pack.zip" },
      ],
    }),
  ];
  assert.deepEqual(await service.packVersions("pack-project"), []);
});

test("choosing an old pack release downloads that exact archive and inspects its own Minecraft requirements", async (t) => {
  const { root, service } = await fixture(t);
  const old = packRelease("old-release", { game_versions: ["1.18.2"] });
  const zip = new Zip();
  zip.addFile(
    "modrinth.index.json",
    Buffer.from(
      JSON.stringify({
        game: "minecraft",
        formatVersion: 1,
        name: "Old Release",
        dependencies: { minecraft: "1.18.2", forge: "40.2.0" },
        files: [],
      }),
    ),
  );
  const requests = [];
  service.request = async (route) => {
    requests.push(route);
    if (route === "/project/pack-slug")
      return { id: "pack-project", project_type: "modpack", title: "Pack" };
    if (route === "/version/old-release") return old;
    throw new Error("an explicit old release must never query latest releases");
  };
  const downloaded = [];
  service.download = async (url, destination, hashes, size) => {
    downloaded.push({ url, hashes, size });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, zip.toBuffer());
  };
  const result = await service.downloadPack("pack-slug", "old-release");
  assert.equal(
    result.path,
    path.join(root, "cache", "packs", "old-release-old-release.mrpack"),
  );
  assert.equal(result.meta.name, "Old Release");
  assert.equal(result.meta.minecraftVersion, "1.18.2");
  assert.equal(result.meta.loader, "forge");
  assert.equal(result.meta.loaderVersion, "40.2.0");
  assert.deepEqual(downloaded, [
    {
      url: old.files[0].url,
      hashes: old.files[0].hashes,
      size: old.files[0].size,
    },
  ]);
  assert.deepEqual(requests, ["/project/pack-slug", "/version/old-release"]);
});

test("explicit pack selection rejects another project's release, a mismatched version ID or missing mrpack without fallback", async (t) => {
  const { service } = await fixture(t);
  let downloads = 0;
  service.download = async () => {
    downloads++;
  };
  for (const [version, message] of [
    [packRelease("chosen", { project_id: "other-project" }), /不属于/],
    [packRelease("different-id"), /所选版本不一致/],
    [
      packRelease("chosen", {
        files: [
          { filename: "pack.zip", url: "https://cdn.modrinth.com/pack.zip" },
        ],
      }),
      /没有可用/,
    ],
  ]) {
    const requests = [];
    service.request = async (route) => {
      requests.push(route);
      if (route === "/project/pack-project")
        return { id: "pack-project", project_type: "modpack" };
      if (route === "/version/chosen") return version;
      throw new Error("fallback must not occur");
    };
    await assert.rejects(
      service.downloadPack("pack-project", "chosen"),
      message,
    );
    assert.deepEqual(requests, ["/project/pack-project", "/version/chosen"]);
  }
  assert.equal(downloads, 0);
});

test("omitting the pack version preserves latest usable release selection", async (t) => {
  const { service } = await fixture(t);
  service.request = async () => ({
    id: "pack-project",
    project_type: "modpack",
    title: "Pack",
  });
  service.projectVersions = async (input) => {
    assert.deepEqual(input, { projectId: "pack-project" });
    return [
      packRelease("older", { date_published: "2024-01-01T00:00:00Z" }),
      packRelease("latest", { date_published: "2026-10-01T00:00:00Z" }),
      packRelease("no-mrpack", {
        date_published: "2026-10-02T00:00:00Z",
        files: [],
      }),
    ];
  };
  const urls = [];
  service.download = async (url) => {
    urls.push(url);
  };
  service.inspectPack = async () => ({ name: "Latest" });
  await service.downloadPack("pack-project");
  assert.deepEqual(urls, ["https://cdn.modrinth.com/latest.mrpack"]);
});

function modRelease(projectId, id, dependencies = [], extra = {}) {
  return {
    id,
    project_id: projectId,
    version_number: id,
    game_versions: ["1.20.1"],
    loaders: ["fabric"],
    dependencies,
    files: [
      {
        filename: `${projectId}.jar`,
        url: `https://cdn.modrinth.com/${id}.jar`,
        hashes: {},
      },
    ],
    ...extra,
  };
}
function mockModProjects(service, releases) {
  const requests = [];
  service.request = async (route) => {
    requests.push(route);
    if (route.startsWith("/version/"))
      return releases.find((release) => release.id === route.slice(9));
    const projectId = route.slice("/project/".length);
    if (!releases.some((release) => release.project_id === projectId))
      throw new Error(`unknown project ${projectId}`);
    return {
      id: projectId,
      project_type: "mod",
      title: projectId,
      slug: projectId,
    };
  };
  service.projectVersions = async ({ projectId }) =>
    releases.filter((release) => release.project_id === projectId);
  return requests;
}

test("mod installation resolves recursive required dependencies once, honors pinned releases and ignores optional mods", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  const releases = [
    modRelease("main", "main-v1", [
      {
        project_id: "dependency",
        version_id: "dep-v1",
        dependency_type: "required",
      },
      { project_id: "optional", dependency_type: "optional" },
    ]),
    modRelease("dependency", "dep-v1", [
      { version_id: "leaf-v1", dependency_type: "required" },
    ]),
    modRelease("leaf", "leaf-v1", [
      {
        project_id: "main",
        version_id: "main-v1",
        dependency_type: "required",
      },
    ]),
  ];
  const requests = mockModProjects(service, releases);
  const downloads = [];
  service.download = async (url, dest) => {
    downloads.push(url);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(
      dest,
      modArchive(path.basename(dest, ".jar"), "Fixture"),
    );
  };
  const report = await service.install({
    projectId: "main",
    instance,
    versionId: "main-v1",
  });
  assert.deepEqual(downloads, [
    "https://cdn.modrinth.com/leaf-v1.jar",
    "https://cdn.modrinth.com/dep-v1.jar",
    "https://cdn.modrinth.com/main-v1.jar",
  ]);
  assert.deepEqual((await fs.readdir(modsDir)).sort(), [
    "dependency.jar",
    "leaf.jar",
    "main.jar",
  ]);
  assert.deepEqual(
    report.dependencies.map((item) => [item.projectId, item.versionId]),
    [
      ["leaf", "leaf-v1"],
      ["dependency", "dep-v1"],
    ],
  );
  assert.equal(report.files.length, 3);
  assert(!requests.some((request) => request.includes("optional")));
});

test("conflicting exact required releases are rejected before any target file is changed", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  mockModProjects(service, [
    modRelease("main", "main-v1", [
      {
        project_id: "dependency",
        version_id: "dep-v1",
        dependency_type: "required",
      },
      {
        project_id: "dependency",
        version_id: "dep-v2",
        dependency_type: "required",
      },
    ]),
    modRelease("dependency", "dep-v1"),
    modRelease("dependency", "dep-v2"),
  ]);
  let downloads = 0;
  service.download = async () => {
    downloads++;
  };
  await assert.rejects(
    service.install({ projectId: "main", instance }),
    /版本要求冲突/,
  );
  assert.equal(downloads, 0);
  assert.deepEqual(await fs.readdir(modsDir), []);
});

test("a later exact dependency pin replaces an automatic choice and discards the old release graph", async (t) => {
  for (const reverse of [false, true])
    await t.test(
      `dependency order ${reverse ? "pinned first" : "automatic first"}`,
      async (t) => {
        const { service, instance, modsDir } = await fixture(t);
        const dependencies = [
          { project_id: "dependency", dependency_type: "required" },
          { project_id: "bridge", dependency_type: "required" },
        ];
        if (reverse) dependencies.reverse();
        mockModProjects(service, [
          modRelease("main", "main-v1", dependencies),
          modRelease("dependency", "dep-v2", [
            { project_id: "discarded", dependency_type: "required" },
            {
              project_id: "shared",
              version_id: "shared-v2",
              dependency_type: "required",
            },
          ]),
          modRelease("dependency", "dep-v1", [
            {
              project_id: "shared",
              version_id: "shared-v1",
              dependency_type: "required",
            },
          ]),
          modRelease("bridge", "bridge-v1", [
            {
              project_id: "dependency",
              version_id: "dep-v1",
              dependency_type: "required",
            },
            {
              project_id: "shared",
              version_id: "shared-v1",
              dependency_type: "required",
            },
          ]),
          // This incompatible edge belongs only to the discarded automatic release.
          modRelease("discarded", "discarded-v1", [], { loaders: ["forge"] }),
          modRelease("shared", "shared-v2"),
          modRelease("shared", "shared-v1"),
        ]);
        const downloaded = [];
        service.download = async (url, destination) => {
          downloaded.push(url);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, "fixture");
        };
        const report = await service.install({ projectId: "main", instance });
        assert.equal(
          report.dependencies.find((item) => item.projectId === "dependency")
            .versionId,
          "dep-v1",
        );
        assert.equal(
          report.dependencies.find((item) => item.projectId === "shared")
            .versionId,
          "shared-v1",
        );
        assert(
          !downloaded.some((url) => /dep-v2|shared-v2|discarded/.test(url)),
        );
        assert.deepEqual((await fs.readdir(modsDir)).sort(), [
          "bridge.jar",
          "dependency.jar",
          "main.jar",
          "shared.jar",
        ]);
      },
    );
});

test("cyclic changing exact requirements stop bounded preflight without writing mod files", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  const requests = mockModProjects(service, [
    modRelease("main", "main-v1", [
      { project_id: "dependency", dependency_type: "required" },
    ]),
    modRelease("dependency", "dep-v1", [
      {
        project_id: "bridge",
        version_id: "bridge-v1",
        dependency_type: "required",
      },
    ]),
    modRelease("dependency", "dep-v2", [
      {
        project_id: "bridge",
        version_id: "bridge-v2",
        dependency_type: "required",
      },
    ]),
    modRelease("bridge", "bridge-v1", [
      {
        project_id: "dependency",
        version_id: "dep-v2",
        dependency_type: "required",
      },
    ]),
    modRelease("bridge", "bridge-v2", [
      {
        project_id: "dependency",
        version_id: "dep-v1",
        dependency_type: "required",
      },
    ]),
  ]);
  service.download = async () =>
    assert.fail("preflight must finish before downloading");
  await assert.rejects(
    service.install({ projectId: "main", instance }),
    /循环冲突|无法收敛/,
  );
  assert(
    requests.length < 20,
    "project and release lookups must be cached across rounds",
  );
  assert.deepEqual(await fs.readdir(modsDir), []);
});

test("resource packs and shaders retain required resource-pack installation while mod graphs reject non-mod dependencies", async (t) => {
  for (const type of ["resourcepack", "shader", "mod"])
    await t.test(type, async (t) => {
      const { service, instance, gameDir, modsDir } = await fixture(t);
      const releases = [
        modRelease("main", "main-v1", [
          { project_id: "required-pack", dependency_type: "required" },
        ]),
        modRelease("required-pack", "pack-v1"),
      ];
      for (const release of releases)
        release.files[0].filename = `${release.project_id}.${release.project_id === "main" && type === "mod" ? "jar" : "zip"}`;
      service.request = async (route) => {
        if (route.startsWith("/version/"))
          return releases.find((release) => release.id === route.slice(9));
        const id = route.slice("/project/".length);
        return {
          id,
          title: id,
          project_type: id === "main" ? type : "resourcepack",
        };
      };
      service.projectVersions = async ({ projectId }) =>
        releases.filter((release) => release.project_id === projectId);
      service.download = async (_url, destination) => {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, "fixture");
      };
      if (type === "mod") {
        await assert.rejects(
          service.install({ projectId: "main", instance }),
          /必需前置项目不是模组/,
        );
        assert.deepEqual(await fs.readdir(modsDir), []);
        await assert.rejects(
          fs.access(path.join(gameDir, "resourcepacks", "required-pack.zip")),
          /ENOENT/,
        );
      } else {
        await service.install({ projectId: "main", instance });
        await fs.access(
          path.join(gameDir, "resourcepacks", "required-pack.zip"),
        );
        await fs.access(
          path.join(
            gameDir,
            type === "shader" ? "shaderpacks" : "resourcepacks",
            "main.zip",
          ),
        );
      }
    });
});

test("hash-confirmed renamed required mods are reused and enabled without another dependency download", async (t) => {
  for (const algorithm of ["sha512", "sha1"])
    for (const enabled of [true, false])
      await t.test(
        `${algorithm} ${enabled ? "enabled" : "disabled"}`,
        async (t) => {
          const { service, instance, modsDir, gameDir } = await fixture(t);
          const bytes = modArchive("dependency", "Dependency");
          const renamed =
            "my-renamed.jar" +
            (enabled ? "" : algorithm === "sha1" ? ".DISABLED" : ".disabled");
          await fs.writeFile(path.join(modsDir, renamed), bytes);
          const dependency = modRelease("dependency", "dep-v1");
          dependency.files[0].hashes[algorithm] = createHash(algorithm)
            .update(bytes)
            .digest("hex");
          mockModProjects(service, [
            modRelease("main", "main-v1", [
              { project_id: "dependency", dependency_type: "required" },
            ]),
            dependency,
          ]);
          const downloads = [];
          service.download = async (url, destination) => {
            downloads.push(url);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, modArchive("main", "Main"));
          };
          const report = await service.install({ projectId: "main", instance });
          assert.deepEqual(downloads, ["https://cdn.modrinth.com/main-v1.jar"]);
          assert.deepEqual((await fs.readdir(modsDir)).sort(), [
            "main.jar",
            "my-renamed.jar",
          ]);
          assert(
            (await fs.readFile(path.join(modsDir, "my-renamed.jar"))).equals(
              bytes,
            ),
          );
          assert(report.files.includes("mods/my-renamed.jar"));
          assert.deepEqual(await service.scanDuplicates(instance), []);
          const metadata = JSON.parse(
            await fs.readFile(
              path.join(gameDir, ".ldfcl-content.json"),
              "utf8",
            ),
          );
          assert.equal(metadata["mods/my-renamed.jar"].projectId, "dependency");
          assert.equal(metadata["mods/my-renamed.jar"].versionId, "dep-v1");
        },
      );
});

test("a renamed older dependency is replaced only after both mod ID and remote file hash confirm ownership", async (t) => {
  const { service, instance, modsDir, gameDir } = await fixture(t);
  const old = modArchive("dependency", "Dependency", "0.9.0");
  const replacement = modArchive("dependency", "Dependency", "1.0.0");
  const oldHash = createHash("sha512").update(old).digest("hex");
  await fs.writeFile(path.join(modsDir, "manually-renamed.jar"), old);
  await fs.writeFile(path.join(modsDir, "another-copy.jar.disabled"), old);
  mockModProjects(service, [
    modRelease("main", "main-v1", [
      { project_id: "dependency", dependency_type: "required" },
    ]),
    modRelease("dependency", "dep-v1"),
  ]);
  const request = service.request.bind(service);
  let checkedHash = false;
  service.request = async (route, init) => {
    if (route !== "/version_files") return request(route, init);
    assert(JSON.parse(init.body).hashes.every((hash) => hash === oldHash));
    checkedHash = true;
    return {
      [oldHash]: {
        project_id: "dependency",
        files: [{ hashes: { sha512: oldHash } }],
      },
    };
  };
  service.download = async (url, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(
      destination,
      url.includes("dep-v1") ? replacement : modArchive("main", "Main"),
    );
  };
  await service.install({ projectId: "main", instance });
  assert(checkedHash);
  assert.deepEqual((await fs.readdir(modsDir)).sort(), [
    "dependency.jar",
    "main.jar",
  ]);
  assert(
    (await fs.readFile(path.join(modsDir, "dependency.jar"))).equals(
      replacement,
    ),
  );
  const backups = await fs.readdir(path.join(gameDir, ".trash"));
  assert(
    (
      await fs.readFile(
        path.join(
          gameDir,
          ".trash",
          backups[0],
          "mods",
          "manually-renamed.jar",
        ),
      )
    ).equals(old),
  );
  assert(
    (
      await fs.readFile(
        path.join(
          gameDir,
          ".trash",
          backups[0],
          "mods",
          "another-copy.jar.disabled",
        ),
      )
    ).equals(old),
  );
  assert.deepEqual(await service.scanDuplicates(instance), []);
});

test("an unconfirmed imported mod sharing a required mod ID is preserved and blocks a duplicate install", async (t) => {
  for (const identity of ["unknown", "other-project", "wrong-hash"])
    await t.test(identity, async (t) => {
      const { service, instance, modsDir } = await fixture(t);
      const original = modArchive("dependency", "User mod", "0.5.0");
      const originalHash = createHash("sha512").update(original).digest("hex");
      await fs.writeFile(path.join(modsDir, "user-mod.jar"), original);
      mockModProjects(service, [
        modRelease("main", "main-v1", [
          { project_id: "dependency", dependency_type: "required" },
        ]),
        modRelease("dependency", "dep-v1"),
      ]);
      const request = service.request.bind(service);
      service.request = async (route, init) => {
        if (route !== "/version_files") return request(route, init);
        if (identity === "unknown") return {};
        return {
          [originalHash]: {
            project_id:
              identity === "other-project" ? "unrelated" : "dependency",
            files: [{ hashes: { sha512: "f".repeat(128) } }],
          },
        };
      };
      service.download = async (_url, destination) => {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, modArchive("dependency", "Dependency"));
      };
      await assert.rejects(
        service.install({ projectId: "main", instance }),
        /无法确认项目身份/,
      );
      assert.deepEqual(await fs.readdir(modsDir), ["user-mod.jar"]);
      assert(
        (await fs.readFile(path.join(modsDir, "user-mod.jar"))).equals(
          original,
        ),
      );
    });
});

test("an installed but disabled required mod is enabled when resolving the main mod", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  mockModProjects(service, [
    modRelease("main", "main-v1", [
      {
        project_id: "dependency",
        version_id: "dep-v1",
        dependency_type: "required",
      },
    ]),
    modRelease("dependency", "dep-v1"),
  ]);
  service.download = async (_url, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "fixture mod bytes");
  };
  await service.install({
    projectId: "dependency",
    instance,
    versionId: "dep-v1",
  });
  await service.enableMod(instance, "dependency.jar", false);
  await fs.access(path.join(modsDir, "dependency.jar.disabled"));
  const report = await service.install({
    projectId: "main",
    instance,
    versionId: "main-v1",
  });
  await fs.access(path.join(modsDir, "dependency.jar"));
  await assert.rejects(
    fs.access(path.join(modsDir, "dependency.jar.disabled")),
    /ENOENT/,
  );
  assert.equal(report.dependencies[0].projectId, "dependency");
});

test("incompatible or unresolved required mods stop preflight instead of silently installing the main mod", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  let downloads = 0;
  service.download = async () => {
    downloads++;
  };
  mockModProjects(service, [
    modRelease("main", "main-v1", [
      { project_id: "dependency", dependency_type: "required" },
    ]),
    modRelease("dependency", "dep-v1", [], { loaders: ["forge"] }),
  ]);
  await assert.rejects(
    service.install({ projectId: "main", instance }),
    /没有适用于/,
  );
  mockModProjects(service, [
    modRelease("main", "main-v1", [{ dependency_type: "required" }]),
  ]);
  await assert.rejects(
    service.install({ projectId: "main", instance }),
    /缺少可解析/,
  );
  assert.equal(downloads, 0);
  assert.deepEqual(await fs.readdir(modsDir), []);
});

test("an explicit mod release must match both the requested ID and owning project", async (t) => {
  const { service, instance } = await fixture(t);
  let downloads = 0;
  service.download = async () => {
    downloads++;
  };
  for (const [release, expected] of [
    [modRelease("main", "wrong-id"), /所选版本不一致/],
    [modRelease("other", "chosen"), /不属于/],
  ]) {
    service.request = async (route) =>
      route.startsWith("/project/")
        ? { id: "main", title: "Main", project_type: "mod" }
        : release;
    await assert.rejects(
      service.install({ projectId: "main", versionId: "chosen", instance }),
      expected,
    );
  }
  assert.equal(downloads, 0);
});

test("duplicate mod IDs are detected across different versions; disabled mods are excluded", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  for (const [file, version] of [
    ["sodium-old.jar", "0.5.1"],
    ["sodium-new.jar", "0.5.2"],
  ]) {
    const zip = new Zip();
    zip.addFile(
      "fabric.mod.json",
      Buffer.from(JSON.stringify({ id: "sodium", name: "Sodium", version })),
    );
    zip.writeZip(path.join(modsDir, file));
  }
  assert.equal((await service.scanDuplicates(instance)).length, 1);
  assert.equal(
    (await service.listMods(instance)).filter((mod) => mod.duplicate).length,
    2,
  );
  await service.enableMod(instance, "sodium-old.jar", false);
  assert.equal((await service.scanDuplicates(instance)).length, 0);
  await service.removeMod(instance, "sodium-old.jar.disabled");
  assert.equal((await service.listMods(instance)).length, 1);
  const trashed = await fs.readdir(path.join(path.dirname(modsDir), ".trash"), {
    recursive: true,
  });
  assert(
    trashed.includes(path.join(trashed[0], "sodium-old.jar.disabled")) ||
      trashed.some((file) => file.endsWith("sodium-old.jar.disabled")),
  );
});

test("identical unknown jars still produce a duplicate group", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  const zip = new Zip();
  zip.addFile("README.txt", Buffer.from("no mod metadata"));
  zip.writeZip(path.join(modsDir, "one.jar"));
  await fs.copyFile(
    path.join(modsDir, "one.jar"),
    path.join(modsDir, "two.jar"),
  );
  const groups = await service.scanDuplicates(instance);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, "完全相同的文件");
});

test("Forge dependency IDs never make unrelated mods appear to be duplicates", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  for (const id of ["alpha", "beta"]) {
    const zip = new Zip();
    zip.addFile(
      "META-INF/mods.toml",
      Buffer.from(
        [
          'modLoader="javafml"',
          'loaderVersion="[47,)"',
          "[[mods]]",
          `modId="${id}"`,
          `displayName="${id} Mod"`,
          'version="1.0.0"',
          `[[dependencies.${id}]]`,
          'modId="forge"',
          'versionRange="[47,)"',
          `[[dependencies.${id}]]`,
          'modId="minecraft"',
          'versionRange="[1.20.1,1.21)"',
        ].join("\n"),
      ),
    );
    await fs.writeFile(path.join(modsDir, `${id}.jar`), zip.toBuffer());
  }
  const mods = await service.listMods(instance);
  assert.deepEqual(
    mods.map((mod) => mod.ids),
    [["alpha"], ["beta"]],
  );
  assert(mods.every((mod) => !mod.duplicate));
  assert.deepEqual(await service.scanDuplicates(instance), []);
});

test("uppercase disabled suffixes stay excluded from duplicates and can be enabled again", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  const bytes = modArchive("same_mod", "Same Mod");
  await fs.writeFile(path.join(modsDir, "active.jar"), bytes);
  await fs.writeFile(path.join(modsDir, "inactive.JAR.DiSaBlEd"), bytes);
  let mods = await service.listMods(instance);
  assert.equal(
    mods.find((mod) => mod.file === "inactive.JAR.DiSaBlEd").enabled,
    false,
  );
  assert.deepEqual(await service.scanDuplicates(instance), []);
  await service.enableMod(instance, "inactive.JAR.DiSaBlEd", true);
  await fs.access(path.join(modsDir, "inactive.JAR"));
  mods = await service.listMods(instance);
  assert(mods.every((mod) => mod.enabled && mod.duplicate));
});

test("directories whose names end in jar are ignored without hiding valid mods", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  await fs.mkdir(path.join(modsDir, "not-a-file.jar"));
  await fs.writeFile(
    path.join(modsDir, "valid.jar"),
    modArchive("valid", "Valid Mod"),
  );
  assert.deepEqual(
    (await service.listMods(instance)).map((mod) => mod.name),
    ["Valid Mod"],
  );
});

test("NeoForge scans every provided mod but ignores table syntax inside multiline descriptions", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  const zip = new Zip();
  zip.addFile(
    "META-INF/neoforge.mods.toml",
    Buffer.from(
      [
        'modLoader="javafml"',
        "[[mods]] # the first real entry",
        'modId="bundle_main"',
        'displayName="Bundle \\"Main\\""',
        'version="${file.jarVersion}"',
        "description='''",
        "[[mods]]",
        'modId="description_only"',
        "'''",
        "[[dependencies.bundle_main]]",
        'modId="minecraft"',
        "[[mods]]",
        "modId='bundle_extra'",
        "version='2.0.0'",
      ].join("\n"),
    ),
  );
  zip.addFile(
    "META-INF/MANIFEST.MF",
    Buffer.from(
      "Manifest-Version: 1.0\r\nImplementation-Version: 1.2.\r\n 3\r\n",
    ),
  );
  await fs.writeFile(path.join(modsDir, "bundle.jar"), zip.toBuffer());
  await fs.writeFile(
    path.join(modsDir, "extra.jar"),
    modArchive("bundle_extra", "Extra"),
  );
  const mods = await service.listMods(instance);
  const bundle = mods.find((mod) => mod.file === "bundle.jar");
  assert.deepEqual(bundle.ids, ["bundle_main", "bundle_extra"]);
  assert.equal(bundle.name, 'Bundle "Main"');
  assert.equal(bundle.version, "1.2.3");
  assert.match(bundle.description, /description_only/);
  const groups = await service.scanDuplicates(instance);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "bundle_extra");
  assert(mods.every((mod) => mod.duplicate));
});

test("malformed metadata fields cannot break sorting or manufacture character-by-character mod IDs", async (t) => {
  const { service, instance, modsDir } = await fixture(t);
  const fabric = new Zip();
  fabric.addFile(
    "fabric.mod.json",
    Buffer.from(
      JSON.stringify({
        id: "safe_fabric",
        name: { invalid: true },
        description: ["invalid"],
        provides: "minecraft",
        version: 4,
      }),
    ),
  );
  await fs.writeFile(path.join(modsDir, "fabric.jar"), fabric.toBuffer());
  const quilt = new Zip();
  quilt.addFile(
    "quilt.mod.json",
    Buffer.from(
      JSON.stringify({
        quilt_loader: {
          id: "safe_quilt",
          provides: [null, { id: "safe_alias" }, { id: ["invalid"] }],
          metadata: { name: 42, description: { invalid: true } },
        },
      }),
    ),
  );
  await fs.writeFile(path.join(modsDir, "quilt.jar"), quilt.toBuffer());
  const mods = await service.listMods(instance);
  assert.deepEqual(
    mods.map((mod) => mod.name),
    ["fabric", "quilt"],
  );
  assert.deepEqual(
    mods.map((mod) => mod.ids),
    [["safe_fabric"], ["safe_quilt", "safe_alias"]],
  );
  assert.equal(mods[0].version, "4");
  assert(mods.every((mod) => mod.description === "" && !mod.duplicate));
});

test("mrpack imports verified staged overrides and rejects incompatible instances", async (t) => {
  const { service, instance, root, gameDir } = await fixture(t);
  const zip = new Zip();
  zip.addFile(
    "modrinth.index.json",
    Buffer.from(
      JSON.stringify({
        game: "minecraft",
        formatVersion: 1,
        name: "Test Pack",
        dependencies: { minecraft: "1.20.1", "fabric-loader": "0.16.10" },
        files: [],
      }),
    ),
  );
  zip.addFile("overrides/config/example.txt", Buffer.from("fixture config"));
  zip.addFile(
    "client-overrides/config/client.txt",
    Buffer.from("client config"),
  );
  const archive = path.join(root, "test.mrpack");
  zip.writeZip(archive);
  assert.equal((await service.inspectPack(archive)).loader, "fabric");
  const result = await service.importPack(archive, instance);
  assert(result.files.includes("config/example.txt"));
  assert(result.files.includes("config/client.txt"));
  assert.equal(
    await fs.readFile(path.join(gameDir, "config/example.txt"), "utf8"),
    "fixture config",
  );
  await assert.rejects(
    service.importPack(archive, { ...instance, version: "1.21" }),
    /1.20.1/,
  );
});

test("archive paths reject traversal, absolute paths, Windows device names and alternate data streams", () => {
  const root = path.resolve(os.tmpdir(), "ldfcl-path-safety");
  for (const relative of [
    "../outside.jar",
    "mods/../../outside",
    "mods/bad:stream.jar",
    "CON.jar",
    "mods/NUL",
    "mods/file.",
  ])
    assert.throws(() => contentSafety.inside(root, relative));
  assert.equal(
    contentSafety.inside(root, "mods/safe-mod.jar"),
    path.join(root, "mods", "safe-mod.jar"),
  );
});

test("a corrupt download never publishes an installable file and cleans partial downloads", async (t) => {
  const { service, root } = await fixture(t);
  const target = path.join(root, "downloads", "mod.jar");
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let requests = 0;
  global.fetch = async () => {
    requests++;
    const response = new Response(Buffer.from("corrupt bytes"), {
      status: 200,
    });
    Object.defineProperty(response, "url", {
      value: "https://cdn.modrinth.com/test.jar",
    });
    return response;
  };
  const expected = createHash("sha512")
    .update("expected original file")
    .digest("hex");
  await assert.rejects(
    service.download("https://cdn.modrinth.com/test.jar", target, {
      sha512: expected,
    }),
    /校验失败/,
  );
  assert.equal(requests, 3);
  await assert.rejects(fs.access(target));
  assert.deepEqual(await fs.readdir(path.dirname(target)), []);
});

test("cached content validates every supplied hash and size while failed replacements preserve the original", async (t) => {
  const { service, root } = await fixture(t);
  const target = path.join(root, "cached.jar");
  const original = Buffer.from("original cached mod");
  await fs.writeFile(target, original);
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let requests = 0;
  global.fetch = async () => {
    requests++;
    const response = new Response(Buffer.from("corrupt replacement"));
    Object.defineProperty(response, "url", {
      value: "https://cdn.modrinth.com/test.jar",
    });
    return response;
  };
  const sha512 = createHash("sha512").update(original).digest("hex");
  const sha1 = createHash("sha1").update(original).digest("hex");
  await assert.rejects(
    service.download("https://cdn.modrinth.com/test.jar", target, {
      sha512,
      sha1: "0".repeat(40),
    }),
    /校验失败/,
  );
  assert.equal(requests, 3);
  await assert.rejects(
    service.download(
      "https://cdn.modrinth.com/test.jar",
      target,
      {
        sha512,
        sha1,
      },
      original.length + 1,
    ),
  );
  assert(requests > 3);
  assert.deepEqual(await fs.readFile(target), original);
  assert.deepEqual(
    (await fs.readdir(root)).filter((file) => file.endsWith(".part")),
    [],
  );
});

test("content downloads enforce HTTPS and the archive limit before making a request", async (t) => {
  const { service, root } = await fixture(t);
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => {
    throw new Error("network must not be reached");
  };
  await assert.rejects(
    service.download(
      "http://cdn.modrinth.com/test.jar",
      path.join(root, "plain.jar"),
    ),
    /HTTPS/,
  );
  await assert.rejects(
    service.download(
      "https://cdn.modrinth.com/test.jar",
      path.join(root, "huge.jar"),
      {},
      1024 ** 3 + 1,
    ),
    /大小/,
  );
});

test("Chinese catalogue matches stable identifiers while preserving original metadata", async (t) => {
  const { root, service, instance, modsDir } = await fixture(t);
  const catalog = new ModTranslationCatalog(root);
  await catalog.load();
  const known = catalog.localize({
    projectId: "AANobbMI",
    name: "Sodium",
    description: "Original author description",
  });
  assert.equal(known.displayName, "钠");
  assert.equal(known.originalName, "Sodium");
  assert.equal(known.originalDescription, "Original author description");
  assert.equal(known.translation.matchedBy, "projectId");
  assert(BUILTIN_MOD_TRANSLATIONS.length >= 40);
  const zip = new Zip();
  zip.addFile(
    "fabric.mod.json",
    Buffer.from(
      JSON.stringify({ id: "sodium", name: "Sodium", version: "test" }),
    ),
  );
  zip.writeZip(path.join(modsDir, "sodium.jar"));
  const [mod] = await service.listMods(instance);
  assert.equal(mod.name, "Sodium");
  assert.equal(mod.displayName, "钠");
  assert.equal(mod.translation.matchedBy, "modId");
});

test("unknown projects retain original text; English title resemblance never fabricates a translation", async (t) => {
  const { root } = await fixture(t);
  const catalog = new ModTranslationCatalog(root);
  await catalog.load();
  const unknown = catalog.localize({
    projectId: "unknown-project",
    slug: "some-other-project",
    name: "Sodium",
    description: "Untranslated description",
  });
  assert.equal(unknown.displayName, "Sodium");
  assert.equal(unknown.displayDescription, "Untranslated description");
  assert.equal(unknown.translation.status, "unavailable");
  assert.match(unknown.translation.notice, /原文/);
  assert.equal(unknown.nameZh, undefined);
  const mismatched = catalog.localize({
    projectId: "not-the-sodium-project",
    slug: "sodium",
    name: "A different project",
  });
  assert.equal(mismatched.translation.status, "unavailable");
});

test("Chinese aliases search original Modrinth keywords and keep English search intact", async (t) => {
  const { service } = await fixture(t);
  let requested;
  service.request = async (route) => {
    requested = new URL("https://api.modrinth.com/v2" + route);
    return {
      total_hits: 1,
      hits: [
        {
          project_id: "AANobbMI",
          slug: "sodium",
          title: "Sodium",
          description: "Original rendering description",
        },
      ],
    };
  };
  const chinese = await service.search({
    query: "钠",
    type: "mod",
    version: "1.20.1",
    loader: "fabric",
  });
  assert.equal(requested.searchParams.get("query"), "sodium");
  assert.equal(chinese.queryTranslation.originalQuery, "钠");
  assert.equal(chinese.hits[0].displayName, "钠");
  assert.equal(chinese.hits[0].title, "Sodium");
  await service.search({ query: "Sodium", type: "mod" });
  assert.equal(requested.searchParams.get("query"), "Sodium");
  await service.search({ query: "完全未知关键词", type: "mod" });
  assert.equal(requested.searchParams.get("query"), "完全未知关键词");
});

test("local Chinese JSON entries extend and override the catalogue; malformed entries are ignored", async (t) => {
  const { root } = await fixture(t);
  const dir = path.join(root, "translations", "mods");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "local.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          slug: "fixture-mod",
          modIds: ["fixture_mod"],
          originalName: "Fixture Mod",
          nameZh: "测试扩展",
          descriptionZh: "用户编写的中文说明。",
          source: "测试目录",
          license: "CC0-1.0",
        },
        {
          slug: "sodium",
          originalName: "Sodium",
          nameZh: "本地钠译名",
          descriptionZh: "此说明来自本地覆盖。",
        },
        {
          originalName: "No identifier",
          nameZh: "无效项目",
          descriptionZh: "缺少稳定标识，应忽略",
        },
      ],
    }),
  );
  await fs.writeFile(path.join(dir, "broken.json"), "not valid JSON");
  const catalog = new ModTranslationCatalog(root);
  await catalog.load();
  const custom = catalog.localize({
    modIds: ["fixture_mod"],
    name: "Fixture Mod",
  });
  assert.equal(custom.displayName, "测试扩展");
  assert.equal(custom.translation.source, "测试目录");
  assert.equal(catalog.resolveSearch("测试扩展").effectiveQuery, "fixture-mod");
  assert.equal(
    catalog.localize({ projectId: "AANobbMI", slug: "sodium", name: "Sodium" })
      .displayName,
    "本地钠译名",
  );
  assert.equal(
    catalog.localize({ name: "No identifier" }).translation.status,
    "unavailable",
  );
});

test("installed content returns Chinese detail fields while retaining the authoritative original name", async (t) => {
  const { service, instance } = await fixture(t);
  service.request = async (route) =>
    route.includes("/version?")
      ? [
          {
            id: "version-1",
            project_id: "AANobbMI",
            version_number: "test",
            game_versions: ["1.20.1"],
            loaders: ["fabric"],
            dependencies: [],
            files: [
              {
                filename: "sodium.jar",
                url: "https://cdn.modrinth.com/sodium.jar",
                primary: true,
                hashes: {},
              },
            ],
          },
        ]
      : {
          id: "AANobbMI",
          slug: "sodium",
          title: "Sodium",
          description: "Original rendering description",
          project_type: "mod",
        };
  service.download = async (_url, target) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "fixture");
  };
  const installed = await service.install({ projectId: "AANobbMI", instance });
  assert.equal(installed.project, "Sodium");
  assert.equal(installed.displayName, "钠");
  assert.equal(installed.originalDescription, "Original rendering description");
  assert.match(installed.descriptionZh, /渲染/);
});

test("active content roots isolate instance files and pack caches while sharing global translations", async (t) => {
  const { root, instance } = await fixture(t);
  const globalProfile = path.join(root, "全局配置");
  const gameA = path.join(root, "游戏目录 A", ".minecraft");
  const gameB = path.join(root, "游戏目录 B", ".minecraft");
  const translations = path.join(globalProfile, "translations", "mods");
  await fs.mkdir(translations, { recursive: true });
  await fs.writeFile(
    path.join(translations, "fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          modIds: ["shared_fixture"],
          originalName: "Shared Fixture",
          nameZh: "全局中文扩展",
          descriptionZh: "两个游戏目录共用全局翻译配置。",
        },
      ],
    }),
  );
  const serviceA = new ContentService(
    gameA,
    () => {},
    () => 2,
    globalProfile,
    { minecraftRoot: gameA },
  );
  const serviceB = new ContentService(
    gameB,
    () => {},
    () => 2,
    globalProfile,
    { minecraftRoot: gameB },
  );
  const jar = new Zip();
  jar.addFile(
    "fabric.mod.json",
    Buffer.from(
      JSON.stringify({
        id: "shared_fixture",
        name: "Shared Fixture",
        version: "1.0.0",
      }),
    ),
  );
  const source = path.join(root, "shared-fixture.jar");
  jar.writeZip(source);
  await serviceA.importMods([source], instance);
  assert.equal(
    (await serviceA.listMods(instance))[0].displayName,
    "全局中文扩展",
  );
  assert.deepEqual(await serviceB.listMods(instance), []);
  await serviceB.importMods([source], instance);
  assert.equal(
    (await serviceB.listMods(instance))[0].displayName,
    "全局中文扩展",
  );
  await serviceA.removeMod(instance, "shared-fixture.jar");
  assert.deepEqual(await serviceA.listMods(instance), []);
  assert.equal((await serviceB.listMods(instance)).length, 1);
  await fs.access(
    path.join(gameB, "versions", instance.id, "mods", "shared-fixture.jar"),
  );

  const pack = new Zip();
  pack.addFile(
    "modrinth.index.json",
    Buffer.from(
      JSON.stringify({
        game: "minecraft",
        formatVersion: 1,
        name: "Isolated Pack",
        dependencies: { minecraft: "1.20.1" },
        files: [],
      }),
    ),
  );
  serviceA.request = async (route) =>
    route.includes("/version?")
      ? [
          {
            id: "fixture-version",
            project_id: "fixture-pack",
            files: [
              {
                filename: "fixture.mrpack",
                url: "https://cdn.modrinth.com/fixture.mrpack",
                primary: true,
                hashes: {},
              },
            ],
          },
        ]
      : { id: "fixture-pack", title: "Isolated Pack", project_type: "modpack" };
  serviceA.download = async (_url, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, pack.toBuffer());
  };
  const downloaded = await serviceA.downloadPack("fixture-pack");
  assert.equal(
    downloaded.path,
    path.join(gameA, "cache", "packs", "fixture-version-fixture.mrpack"),
  );
  assert.equal(downloaded.meta.name, "Isolated Pack");
  await assert.rejects(fs.access(path.join(gameB, "cache", "packs")));
  await assert.rejects(fs.access(path.join(globalProfile, "instances")));
  await assert.rejects(fs.access(path.join(globalProfile, "cache")));
});

test("existing standard version folders supply mods and receive local and downloaded content beside their untouched json/jar", async (t) => {
  const { root, instance } = await fixture(t);
  const minecraftRoot = path.join(root, "用户 原有目录", ".minecraft");
  const selected = {
    ...instance,
    id: "launcher-synthetic-id",
    importedVersionId: "old-import-id",
    versionDirectory: "1.20.1 Fabric 世界",
  };
  const versionDir = path.join(
    minecraftRoot,
    "versions",
    selected.versionDirectory,
  );
  const mods = path.join(versionDir, "mods");
  await fs.mkdir(mods, { recursive: true });
  const profileFile = path.join(
    versionDir,
    `${selected.versionDirectory}.json`,
  );
  const gameJar = path.join(versionDir, `${selected.versionDirectory}.jar`);
  const originalProfile = JSON.stringify({
    id: selected.versionDirectory,
    inheritsFrom: "1.20.1",
  });
  const originalJar = Buffer.from("Existing version jar fixture");
  await fs.writeFile(profileFile, originalProfile);
  await fs.writeFile(gameJar, originalJar);
  await fs.writeFile(
    path.join(mods, "existing.jar"),
    modArchive("existing", "Existing Third Party Mod"),
  );
  const service = new ContentService(
    root,
    () => {},
    () => 2,
    root,
    { minecraftRoot },
  );
  assert.deepEqual(
    (await service.listMods(selected)).map((mod) => mod.name),
    ["Existing Third Party Mod"],
  );

  const localZip = path.join(root, "local-content.zip");
  const archive = new Zip();
  archive.addFile("fixture.txt", Buffer.from("Local content"));
  await fs.writeFile(localZip, archive.toBuffer());
  for (const kind of ["resourcepack", "shader"]) {
    await service.importFiles([localZip], selected, kind);
    assert.deepEqual(
      (await service.listFiles(selected, kind)).map((file) => file.file),
      ["local-content.zip"],
    );
    service.request = async (route) =>
      route.includes("/version?")
        ? [
            {
              id: `${kind}-version`,
              project_id: kind,
              version_number: "1",
              game_versions: [selected.version],
              loaders: [],
              dependencies: [],
              files: [
                {
                  filename: `downloaded-${kind}.zip`,
                  primary: true,
                  url: `https://cdn.modrinth.com/${kind}.zip`,
                  hashes: {},
                },
              ],
            },
          ]
        : { id: kind, title: kind, project_type: kind };
    service.download = async (_url, target) => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, archive.toBuffer());
    };
    await service.install({ projectId: kind, instance: selected });
    await fs.access(
      path.join(
        versionDir,
        kind === "shader" ? "shaderpacks" : "resourcepacks",
        `downloaded-${kind}.zip`,
      ),
    );
  }
  assert.equal(await fs.readFile(profileFile, "utf8"), originalProfile);
  assert.deepEqual(await fs.readFile(gameJar), originalJar);
  await assert.rejects(fs.access(path.join(minecraftRoot, "instances")));
  await assert.rejects(
    fs.access(path.join(minecraftRoot, "versions", selected.id)),
  );
  await assert.rejects(
    fs.access(path.join(minecraftRoot, "versions", selected.importedVersionId)),
  );
});

test("same-named jars in different version folders stay isolated during import, disable, remove and update", async (t) => {
  const { service, root, minecraftRoot, instance } = await fixture(t);
  const a = { ...instance, id: "state-a", versionDirectory: "Fabric A" };
  const b = { ...instance, id: "state-b", versionDirectory: "Fabric B" };
  const modsA = path.join(
    minecraftRoot,
    "versions",
    a.versionDirectory,
    "mods",
  );
  const modsB = path.join(
    minecraftRoot,
    "versions",
    b.versionDirectory,
    "mods",
  );
  const sourceDir = path.join(root, "第三方下载 文件夹");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(modsB, { recursive: true });
  const source = path.join(sourceDir, "shared.jar");
  const bytesB = modArchive("shared", "B Mod", "B-1");
  await fs.writeFile(source, modArchive("shared", "A Mod", "A-1"));
  await fs.writeFile(path.join(modsB, "shared.jar"), bytesB);
  await service.importMods([source], a);
  assert.equal((await service.listMods(a))[0].name, "A Mod");
  assert.equal((await service.listMods(b))[0].name, "B Mod");
  await service.enableMod(a, "shared.jar", false);
  assert.equal((await service.listMods(a))[0].enabled, false);
  assert.equal((await service.listMods(b))[0].enabled, true);
  await service.removeMod(a, "shared.jar.disabled");
  assert.deepEqual(await service.listMods(a), []);
  await service.importMods([source], a);
  const [current] = await service.listMods(a);
  const updated = modArchive("shared", "A Mod", "A-2");
  const hash = createHash("sha512").update(updated).digest("hex");
  service.request = async () => ({
    id: "a-update",
    project_id: "a-project",
    version_number: "A-2",
    game_versions: [a.version],
    loaders: [a.loader],
    dependencies: [],
    files: [
      {
        filename: "shared-v2.jar",
        primary: true,
        url: "https://cdn.modrinth.com/shared-v2.jar",
        hashes: { sha512: hash },
      },
    ],
  });
  service.download = async (_url, target) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, updated);
  };
  await service.applyUpdates(a, [
    { file: current.file, oldHash: current.sha512, versionId: "a-update" },
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(modsA, "shared-v2.jar")),
    updated,
  );
  assert.deepEqual(await fs.readFile(path.join(modsB, "shared.jar")), bytesB);
  assert.deepEqual(await fs.readdir(modsB), ["shared.jar"]);
  assert.equal((await service.listMods(b))[0].version, "B-1");
  const metadata = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(modsA), ".ldfcl-content.json"),
      "utf8",
    ),
  );
  assert.equal(metadata["mods/shared-v2.jar"].versionId, "a-update");
  await assert.rejects(
    fs.access(path.join(path.dirname(modsB), ".ldfcl-content.json")),
  );
  await assert.rejects(fs.access(path.join(root, "instances")));
});

test("third-party imported version folder IDs remain authoritative while packs leave shared assets and libraries intact", async (t) => {
  const { root, instance } = await fixture(t);
  const minecraftRoot = path.join(root, "第三方 启动器", ".minecraft");
  const imported = {
    ...instance,
    id: "generated-import-id",
    importedVersionId: "fabric-loader-0.16.10-1.20.1",
  };
  const versionDir = path.join(
    minecraftRoot,
    "versions",
    imported.importedVersionId,
  );
  await fs.mkdir(path.join(versionDir, "mods"), { recursive: true });
  await fs.writeFile(
    path.join(versionDir, "mods", "existing.jar"),
    modArchive("third_party", "Existing Imported Mod"),
  );
  const originals = new Map();
  for (const file of [
    "assets/objects/keep",
    "libraries/vendor/keep.jar",
    "mods/shared-root.jar",
  ]) {
    const target = path.join(minecraftRoot, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(`Shared root: ${file}`);
    await fs.writeFile(target, bytes);
    originals.set(target, bytes);
  }
  const service = new ContentService(
    root,
    () => {},
    () => 2,
    root,
    { minecraftRoot },
  );
  assert.deepEqual(
    (await service.listMods(imported)).map((mod) => mod.name),
    ["Existing Imported Mod"],
  );
  const packFile = path.join(root, "third-party.mrpack");
  await fs.writeFile(
    packFile,
    packArchive(imported, [
      ["overrides/mods/packed.jar", modArchive("packed", "Packed Mod")],
      ["overrides/config/pack.json", '{"pack":true}'],
      ["client-overrides/resourcepacks/pack.zip", "Resource fixture"],
      ["client-overrides/shaderpacks/pack.zip", "Shader fixture"],
    ]),
  );
  await service.importPack(packFile, imported);
  assert.deepEqual(
    (await service.listMods(imported)).map((mod) => mod.name),
    ["Existing Imported Mod", "Packed Mod"],
  );
  assert.equal(
    await fs.readFile(path.join(versionDir, "config", "pack.json"), "utf8"),
    '{"pack":true}',
  );
  for (const kind of ["resourcepacks", "shaderpacks"])
    await fs.access(path.join(versionDir, kind, "pack.zip"));
  for (const [file, bytes] of originals)
    assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(
    fs.access(path.join(minecraftRoot, "versions", imported.id)),
  );
});

test("mrpack file entries and both override trees reject version metadata and launcher markers before replacing existing data", async (t) => {
  const { root, instance, service, gameDir } = await fixture(t);
  const reserved = [
    `${instance.id}.json`,
    `${instance.id}.jar`,
    ".ldfcl/migration.json",
    ".ldfcl/launch.json",
    "instance.json",
    ".ldfcl-content.json",
  ];
  const originals = new Map();
  for (const file of [...reserved, "config/keep.txt"]) {
    const full = path.join(gameDir, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const bytes = Buffer.from(`Protected existing: ${file}`);
    await fs.writeFile(full, bytes);
    originals.set(full, bytes);
  }
  let downloads = 0;
  service.download = async () => {
    downloads++;
    throw new Error("Protected files must be rejected before download");
  };
  for (const [index, target] of reserved.entries()) {
    for (const prefix of ["overrides/", "client-overrides/", null]) {
      const archive = path.join(
        root,
        `protected-${index}-${prefix === null ? "index" : prefix.replace("/", "")}.mrpack`,
      );
      const filePath = index % 2 ? target.toUpperCase() : target;
      await fs.writeFile(
        archive,
        prefix === null
          ? packArchive(
              instance,
              [],
              [
                {
                  path: filePath,
                  downloads: ["https://cdn.modrinth.com/forbidden"],
                  hashes: { sha512: "00" },
                },
              ],
            )
          : packArchive(instance, [
              [`${prefix}${filePath}`, "Forbidden replacement"],
              ["overrides/config/keep.txt", "Also must not commit"],
            ]),
      );
      await assert.rejects(
        service.importPack(archive, instance),
        /不能修改启动器配置或版本元数据/,
        `${prefix || "file entry: "}${filePath} should be rejected`,
      );
      for (const [full, bytes] of originals)
        assert.deepEqual(await fs.readFile(full), bytes);
    }
  }
  assert.equal(downloads, 0);
  assert.deepEqual(
    await fs.readdir(path.join(root, "cache", "pack-staging")),
    [],
  );
});

test("mrpack rejects an existing nested config junction before publishing any override or touching external files", async (t) => {
  const { root, instance, service, gameDir } = await fixture(t);
  const config = path.join(gameDir, "config");
  const outside = path.join(root, "外部 用户文件");
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const originalLocal = Buffer.from("Keep this existing version configuration");
  const originalOutside = Buffer.from("Keep this external user file");
  const localFile = path.join(config, "keep.txt");
  const externalFile = path.join(outside, "protected.txt");
  const junction = path.join(config, "escape");
  await fs.writeFile(localFile, originalLocal);
  await fs.writeFile(externalFile, originalOutside);
  try {
    await fs.symlink(
      outside,
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(
        `The filesystem does not support the required directory link: ${error.code}`,
      );
      return;
    }
    throw error;
  }
  const archive = path.join(root, "junction-escape.mrpack");
  await fs.writeFile(
    archive,
    packArchive(instance, [
      ["overrides/config/keep.txt", "Must not replace the local original"],
      [
        "overrides/config/escape/protected.txt",
        "Must not escape the version directory",
      ],
      [
        "client-overrides/config/escape/new.txt",
        "Must not create an external file",
      ],
    ]),
  );
  await assert.rejects(
    service.importPack(archive, instance),
    /符号链接|目录联接|链接/,
  );
  assert.deepEqual(await fs.readFile(localFile), originalLocal);
  assert.deepEqual(await fs.readFile(externalFile), originalOutside);
  assert.deepEqual(await fs.readdir(outside), ["protected.txt"]);
  assert.equal(await fs.realpath(junction), await fs.realpath(outside));
  assert.deepEqual(
    await fs.readdir(path.join(root, "cache", "pack-staging")),
    [],
  );
});
