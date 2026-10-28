# LDFCL 0.5.0 · Third-party notices

Version 0.5.0 integrates **liquid-glass-react@1.1.1** as an actual runtime dependency for the UI refactor. Thank you to **Max Rovensky**, whose MIT notice is **Copyright 2025 MAX ROVENSKY**. The upstream README and LICENSE were inspected at fixed commit [ac48eab18d1f7f444ae30002d240cae29c863a21](https://github.com/rdev/liquid-glass-react/tree/ac48eab18d1f7f444ae30002d240cae29c863a21); package-lock.json records the npm package version. LDFCL independently implements the GlassBackdrop / GlassSurface adaptation and application layout around the upstream effect. See [docs/UI_REFACTOR.md](docs/UI_REFACTOR.md) for scope and the complete MIT notice below. Earlier release notes retain their original version context.

Version 0.4.0 independently implements Mod target/release selection, required dependency resolution, Mod favorites, a local skin library, OptiFine release selection and isolated installation, and inherited game settings. OptiFine is developed by **sp614x** and retains its own copyright and license. [BMCLAPI](https://github.com/bangbang93/BMCLAPI), maintained by bangbang93 and contributors, supplies OptiFine metadata and a mirror of the official installers. No new third-party source or dependencies were introduced.

The launcher fetches an official OptiFine installer over HTTPS only when the user requests installation, invokes its own installation and patching workflow inside a temporary game directory, and checks the resulting profile and generated libraries. LDFCL's Java 8 reflection adapter is independently authored; its complete source is [docs/OptiFineBridge.java](docs/OptiFineBridge.java), and the bundled adapter bytecode is compiled from that source. No OptiFine installer, upstream implementation, patched game content or decompiled source is included in the application or source release. OptiFine and BMCLAPI are runtime software/service sources, not dependencies relicensed under LDFCL's MIT license.

Version 0.3.2 independently implements modpack release selection and filtering. Release metadata and archives are fetched from Modrinth at runtime; individual pack and mod authors retain their licenses. No new third-party source or dependencies were introduced.

Version 0.3.1 independently implements executable-side account/configuration storage and preservation of prior settings. No new third-party source or dependencies were introduced.

Version 0.3.0 uses [YUN-SAN3/KAMUCL](https://github.com/YUN-SAN3/KAMUCL/tree/30874ab871c8ee00c1edab275bb3aeb25704330b), inspected on 2026-10-21 at commit `30874ab871c8ee00c1edab275bb3aeb25704330b`, as an architectural and behavioral reference for downloads, Java discovery, launch preparation, account lifecycle and Mod management. Thank you to YUN-SAN3, kamubaba-i and the project contributors. The upstream root LICENSE states MIT for **original KAMUCL contributions only**, Copyright (c) 2026 kamubaba-i; third-party code retains separate terms and some historical provenance is unresolved there. LDFCL independently implements these changes without importing upstream source, assets, executables or OAuth identities. This reference is not a bundled dependency. See [docs/KAMUCL_REFERENCE.md](docs/KAMUCL_REFERENCE.md) for the exact scope.

Version 0.2.4 implements standard versions-folder isolation, existing-profile management and legacy instance compatibility independently. No new third-party source or dependencies were introduced.

Version 0.2.3 adds an independently implemented split instance manager, version search, isolated Mod views and enforced per-instance game-directory arguments. No new third-party source or dependencies were introduced for this change.

Version 0.2.2 adds independently implemented game-directory registration, portable executable directory resolution, legacy layout compatibility, local version scanning and settings UI. This feature introduces no additional third-party source or dependencies. Existing acknowledgments follow.

LDFCL is an independent Minecraft Java Edition launcher. Minecraft is a trademark of Mojang/Microsoft; LDFCL is not affiliated with, endorsed by, or distributed by Mojang or Microsoft. Minecraft game files are downloaded from the relevant services when requested and are not part of this project's source license.

## Visual, protocol and community references

[SuGar0218/TryLiquidGlass-WinUI3](https://github.com/SuGar0218/TryLiquidGlass-WinUI3) was the visual reference requested for the initial interface. Its `main` tree and README were inspected on 2026-10-20; no public license file was found in that inspected tree. LDFCL does not assume MIT or another reuse license for it. LDFCL's Electron/React/CSS implementation is independent; its WinUI controls, shaders, source and image assets were not copied. Version 0.2.1 used a compact Windows 11 layout and Electron's native Mica background where supported; that is a historical UI record. Version 0.5.0 uses the liquid-glass-react dependency described above.

The following projects and official documents were read as references. They are not bundled implementation dependencies, and attribution does not mean that their maintainers contributed code to LDFCL:

| Reference                                                                                                                                               | Verified upstream notice                                                                                       | Use in LDFCL                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MSAL.js LoopbackClient](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/src/network/LoopbackClient.ts)       | MIT; Copyright Microsoft Corporation                                                                           | Historical reference for the independently implemented 0.2.0 authorization-code + PKCE loopback flow. The 0.2.1 UI defaults to device-code authorization. No MSAL source copied or bundled. |
| [Prism Launcher](https://github.com/PrismLauncher/PrismLauncher)                                                                                        | README: GPL-3.0-only for launcher code; CC BY-SA 4.0 for logo/assets; individual files include further notices | Public authentication implementation and ecosystem reading. No source, artwork, branding, or OAuth application identity imported.                                                           |
| [HMCL MicrosoftAccount.java](https://github.com/HMCL-dev/HMCL/blob/main/HMCLCore/src/main/java/org/jackhuang/hmcl/auth/microsoft/MicrosoftAccount.java) | Inspected file: GPL-3.0-or-later; Copyright huangyuhui and contributors                                        | Public account implementation and ecosystem reading. No Java source or OAuth application identity imported. Other HMCL files retain their own notices.                                      |
| [CFPAOrg Minecraft Mod Language Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package)                                                     | CC BY-NC-SA 4.0                                                                                                | Community localization reference and acknowledgement. Its translations are not copied, converted into, or bundled with the built-in LDFCL catalog.                                          |

The LDFCL Chinese mod name/description catalog is independently authored and covered by this project's MIT license. User-supplied translation catalogs retain their own terms. Project names, upstream descriptions and downloaded content remain attributable to their respective authors.

The default Microsoft sign-in UI in 0.2.1 independently implements the [device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code): it opens Microsoft's verification page, displays the user code, polls at the service-provided interval, and supports cancellation and expiry. Microsoft's [desktop application registration guidance](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration) explains the public client flow setting and that device-code authorization requires no redirect URI. The [application registration guidance](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) describes supported account types; this launcher needs support for personal Microsoft accounts. It requires an application Client ID that the user owns or is authorized to use, with the required Minecraft API access. It does not borrow another launcher's application identity or include a client secret.

Microsoft's [authorization-code / PKCE documentation](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) and [redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url) were references for the earlier 0.2.0 implementation. Its regression tests remain historical implementation coverage, not evidence that the current UI defaults to PKCE or that device-code sign-in has been verified with a real account.

The user-selected [Xbox Live authentication / XSTS document](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-xbox-live-authentication?view=gdk-2510) is protocol background. LDFCL does not include GDK/XSAPI code or claim to implement GDK title-service request signing. The Java Minecraft account exchange uses OAuth, Xbox Live, XSTS and Minecraft Services HTTP APIs; device-code authorization does not bypass API access requirements or game ownership checks. Intermediate XBL/XSTS tokens are used in memory only.

Microsoft, Xbox and Minecraft account requests use HTTPS with server certificate validation. Version 0.2.1 blocks account requests when `NODE_TLS_REJECT_UNAUTHORIZED=0` is present. Microsoft passwords are entered on Microsoft's page in the system browser, not received by LDFCL; the launcher does receive authorization tokens. The 0.2.1 device-code unit tests and desktop smoke tests passed using controlled service responses; real-account authorization remains unverified. See [VALIDATION.md](VALIDATION.md) for final test results and untested boundaries. Historical 0.2.0 results are separate from this device-code verification.

Reference checks above used the named public branches on 2026-10-20. GitHub-hosted files were read through jsDelivr's GitHub mirror when the GitHub endpoints returned gateway errors. These branch references are not presented as immutable commit audits. See [CREDITS.md](CREDITS.md) for author acknowledgements and the contribution boundary.

## Bundled libraries

The components below are actual runtime dependencies. `package-lock.json` records exact versions and the complete resolved dependency graph.

| Component                   | License                                         | Project                                    |
| --------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Electron                    | MIT, with Chromium/Node.js third-party licenses | https://www.electronjs.org/                |
| React / React DOM           | MIT                                             | https://react.dev/                         |
| liquid-glass-react 1.1.1    | MIT; Copyright 2025 MAX ROVENSKY                | https://github.com/rdev/liquid-glass-react |
| adm-zip                     | MIT                                             | https://github.com/cthackers/adm-zip       |
| skinview3d / skinview-utils | MIT                                             | https://github.com/bs-community/skinview3d |
| Three.js                    | MIT                                             | https://threejs.org/                       |
| Lucide React                | ISC, with Feather-derived portions under MIT    | https://lucide.dev/                        |

Electron distributions include their own `LICENSE` and `LICENSES.chromium.html`; preserve these files when redistributing unpacked application runtimes. Development tooling includes TypeScript (Apache-2.0), Vite (MIT), electron-builder (MIT), and their dependencies. Consult the installed package license files and lockfile for those components.

### liquid-glass-react 1.1.1 — MIT

The following complete notice matches both the installed package's LICENSE and the LICENSE at the fixed upstream commit above:

```text
Copyright 2025 MAX ROVENSKY

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MIT notices

The following notices apply to the corresponding libraries, rather than changing LDFCL's own copyright statement:

- Electron: Copyright (c) Electron contributors; Copyright (c) 2013–2020 GitHub Inc.
- React / React DOM: Copyright (c) Meta Platforms, Inc. and affiliates.
- adm-zip: Copyright (c) 2012 Another-D-Mention Software and other contributors.
- skinview3d / skinview-utils: Copyright (c) 2014–2018 Kent Rasmussen; Copyright (c) 2017–2022 Haowei Wen, Sean Boult and contributors.
- Three.js: Copyright © 2010–2023 three.js authors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Lucide ISC notice

Copyright (c) for portions of Lucide are held by Cole Bemis 2013–2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Downloaded components and online services

- Mojang/Microsoft: version manifests, game files, libraries, assets, Microsoft/Xbox/Minecraft account and profile APIs; subject to their respective service terms and Minecraft EULA.
- Fabric, Quilt, Minecraft Forge and [NeoForge](https://neoforged.net/): loader metadata, libraries and official installers fetched on demand; those projects retain their own licenses. NeoForge artifacts and checksum files are retrieved from https://maven.neoforged.net/releases/ and are not bundled in this source or EXE.
- [OptiFine](https://optifine.net/), by sp614x: its official installer is downloaded and executed locally on demand. OptiFine retains its own copyright and license; the installer, generated game patches and upstream code are not bundled with LDFCL.
- [BMCLAPI](https://bmclapi2.bangbang93.com/), maintained by bangbang93 and contributors: OptiFine release metadata and installer mirror endpoints (`/optifine/{minecraftVersion}` and `/optifine/{minecraftVersion}/{type}/{patch}`). LDFCL uses the online service and does not bundle or copy BMCLAPI server code.
- [Eclipse Adoptium / Temurin](https://adoptium.net/): Java runtimes fetched on demand; preserve the runtime's bundled legal notices. The OpenJDK runtime is distributed under its applicable GPLv2 with Classpath Exception and included third-party terms.
- [Azul Zulu](https://www.azul.com/downloads/): fallback OpenJDK runtime distribution fetched on demand; preserve its included OpenJDK and third-party legal notices.
- [authlib-injector](https://github.com/yushijinhun/authlib-injector): downloaded on demand for third-party Yggdrasil authentication; licensed under GPL-3.0. It runs as a separate Java agent and is not embedded into this TypeScript project's source license.
- [Modrinth](https://modrinth.com/): content API and download links; individual mods, modpacks, resource packs and shaders retain their authors' licenses. Installing them does not relicense them under LDFCL's MIT license.
- Iris, Oculus and OptiFine: LDFCL reads and writes their user configuration formats to select a shader pack. Their implementation and shader packs are not bundled or relicensed.
- Crash diagnosis uses local rules and does not bundle or call third-party model services.

This application does not bundle paid Minecraft content or grant Microsoft account, skin, cape, or game ownership rights.
