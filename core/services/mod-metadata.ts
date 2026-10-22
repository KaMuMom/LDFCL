export type ModMetadata = {
  id: string;
  ids: string[];
  name: string;
  version: string;
  description: string;
};

type ReadMetadata = (name: string) => string | null;

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function versionText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : text(value);
}

function identifiers(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && /^[a-z0-9_.:-]{1,256}$/i.test(value),
      ),
    ),
  ];
}

/** Split TOML statements without interpreting table names inside quoted descriptions. */
function tomlStatements(source: string): string[] {
  const result: string[] = [];
  let statement = "";
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      statement += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote[0] === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (source.startsWith(quote, index)) {
        statement += quote.slice(1);
        index += quote.length - 1;
        quote = "";
      }
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index++;
      if (depth) statement += "\n";
      else {
        if (statement.trim()) result.push(statement.trim());
        statement = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = source.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      statement += quote;
      index += quote.length - 1;
    } else if (char === "\n" && !depth) {
      if (statement.trim()) result.push(statement.trim());
      statement = "";
    } else {
      if (char === "[" || char === "{") depth++;
      if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
      statement += char;
    }
  }
  if (!quote && statement.trim()) result.push(statement.trim());
  return result;
}

function tomlString(value: string): string {
  const delimiter =
    value.startsWith('"""') || value.startsWith("'''")
      ? value.slice(0, 3)
      : value[0];
  if (
    (delimiter !== '"' &&
      delimiter !== "'" &&
      delimiter !== '"""' &&
      delimiter !== "'''") ||
    value.length < delimiter.length * 2 ||
    !value.endsWith(delimiter)
  )
    return "";
  let body = value.slice(delimiter.length, -delimiter.length);
  if (delimiter.length === 3) body = body.replace(/^\r?\n/, "");
  if (delimiter[0] === "'") return body;
  if (delimiter.length === 3) body = body.replace(/\\\r?\n\s*/g, "");
  const escapes: Record<string, string> = {
    b: "\b",
    t: "\t",
    n: "\n",
    f: "\f",
    r: "\r",
    '"': '"',
    "\\": "\\",
  };
  return body.replace(
    /\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[btnfr"\\])/g,
    (_match, escape: string) => {
      if (escape[0] !== "u" && escape[0] !== "U") return escapes[escape];
      const code = Number.parseInt(escape.slice(1), 16);
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

/** Only [[mods]] provides IDs; [[dependencies.*]] describes required mods. */
function forgeMetadata(source: string, manifest: string): Partial<ModMetadata> {
  const mods: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  for (const statement of tomlStatements(source)) {
    if (statement.startsWith("[")) {
      current = /^\[\[\s*mods\s*\]\]$/.test(statement) ? {} : undefined;
      if (current) mods.push(current);
      continue;
    }
    if (!current) continue;
    const assignment =
      /^(modId|displayName|version|description)\s*=\s*([\s\S]*)$/.exec(
        statement,
      );
    if (assignment) current[assignment[1]] = tomlString(assignment[2].trim());
  }
  const first = mods[0] || {};
  const ids = identifiers(mods.map((mod) => mod.modId));
  let version = first.version || "";
  if (version === "${file.jarVersion}") {
    const unfolded = manifest.replace(/\r?\n /g, "");
    version =
      /^Implementation-Version:\s*([^\r\n]*)/im.exec(unfolded)?.[1]?.trim() ||
      "";
  }
  return {
    id: ids[0] || "",
    ids,
    name: first.displayName,
    version,
    description: first.description,
  };
}

/** The caller bounds archive entry sizes before supplying their text. */
export function readModMetadata(
  read: ReadMetadata,
  fallbackName: string,
): ModMetadata {
  let parsed: Partial<ModMetadata> = {};
  const fabric = read("fabric.mod.json");
  const quilt = read("quilt.mod.json");
  if (fabric) {
    const mod = record(JSON.parse(fabric));
    parsed = {
      id: identifiers([mod.id])[0],
      ids: identifiers([
        mod.id,
        ...(Array.isArray(mod.provides) ? mod.provides : []),
      ]),
      name: text(mod.name),
      version: versionText(mod.version),
      description: text(mod.description),
    };
  } else if (quilt) {
    const mod = record(record(JSON.parse(quilt)).quilt_loader);
    const metadata = record(mod.metadata);
    parsed = {
      id: identifiers([mod.id])[0],
      ids: identifiers([
        mod.id,
        ...(Array.isArray(mod.provides)
          ? mod.provides.map((value: unknown) =>
              typeof value === "string" ? value : record(value).id,
            )
          : []),
      ]),
      name: text(metadata.name),
      version: versionText(mod.version),
      description: text(metadata.description),
    };
  } else {
    const toml =
      read("META-INF/mods.toml") || read("META-INF/neoforge.mods.toml");
    if (toml) parsed = forgeMetadata(toml, read("META-INF/MANIFEST.MF") || "");
    else {
      const legacy = read("mcmod.info");
      if (legacy) {
        const value = JSON.parse(legacy);
        const list = Array.isArray(value) ? value : record(value).modList;
        const mods = Array.isArray(list) ? list.map(record) : [];
        const first = mods[0] || {};
        const ids = identifiers(mods.map((mod) => mod.modid));
        parsed = {
          id: ids[0],
          ids,
          name: text(first.name),
          version: versionText(first.version),
          description: text(first.description),
        };
      }
    }
  }
  return {
    id: parsed.id || "",
    ids: parsed.ids || [],
    name: parsed.name || fallbackName,
    version: parsed.version || "",
    description: parsed.description || "",
  };
}

export type DuplicateMod = {
  file: string;
  ids: string[];
  sha512: string;
  enabled: boolean;
};
export type DuplicateGroup = { reason: string; id?: string; files: string[] };

export function findDuplicateMods(mods: DuplicateMod[]): DuplicateGroup[] {
  const grouped = new Map<string, string[]>();
  for (const mod of mods) {
    if (!mod.enabled) continue;
    for (const key of [
      `hash:${mod.sha512}`,
      ...new Set(mod.ids.map((id) => `id:${id}`)),
    ]) {
      const files = grouped.get(key) || [];
      files.push(mod.file);
      grouped.set(key, files);
    }
  }
  const seen = new Set<string>();
  const result: DuplicateGroup[] = [];
  for (const [key, files] of grouped) {
    if (files.length < 2) continue;
    const signature = JSON.stringify([...files].sort());
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({
      reason: key.startsWith("id:") ? "相同模组 ID" : "完全相同的文件",
      id: key.startsWith("id:") ? key.slice(3) : undefined,
      files,
    });
  }
  return result;
}
