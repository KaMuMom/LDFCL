import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface PathBases {
  program?: string;
  data: string;
  game: string;
}
export interface PathReference {
  base: keyof PathBases;
  relative: string;
  originalHash: string;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const absolute = (value: unknown): value is string =>
  typeof value === "string" && !value.includes("\0") && path.isAbsolute(value);
const inside = (base: string, value: string) => {
  const relative = path.relative(base, value);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};

/** Absolute paths remain available to older launchers; these relative bindings
 * are authoritative only while the original field has not been manually edited. */
export function pathReference(
  value: unknown,
  bases: PathBases,
): PathReference | undefined {
  if (!absolute(value)) return;
  const candidates = Object.entries(bases)
    .filter(
      (entry): entry is [keyof PathBases, string] =>
        absolute(entry[1]) && inside(entry[1], value),
    )
    .sort((a, b) => b[1].length - a[1].length);
  const selected = candidates[0];
  if (!selected) return;
  return {
    base: selected[0],
    relative: path.relative(selected[1], value).split(path.sep).join("/"),
    originalHash: digest(value),
  };
}

export function resolvePathReference(
  value: unknown,
  reference: unknown,
  bases: PathBases,
): unknown {
  if (!absolute(value) || !reference || typeof reference !== "object")
    return value;
  const r = reference as Partial<PathReference>;
  if (
    !r.base ||
    !["program", "data", "game"].includes(r.base) ||
    !absolute(bases[r.base]) ||
    r.originalHash !== digest(value) ||
    typeof r.relative !== "string" ||
    r.relative.includes("\0") ||
    /[\\:]/.test(r.relative) ||
    r.relative.split("/").some((p) => p === ".." || p === ".") ||
    path.isAbsolute(r.relative)
  )
    return value;
  const target = path.resolve(bases[r.base]!, r.relative);
  return inside(bases[r.base]!, target) ? target : value;
}

export function validBases(value: unknown): value is PathBases {
  if (!value || typeof value !== "object") return false;
  const b = value as PathBases;
  return (
    absolute(b.data) &&
    absolute(b.game) &&
    (b.program === undefined || absolute(b.program))
  );
}

export function basesMoved(previous: PathBases, current: PathBases): boolean {
  return (
    path.resolve(previous.data) !== path.resolve(current.data) ||
    !!(
      previous.program &&
      current.program &&
      path.resolve(previous.program) !== path.resolve(current.program)
    )
  );
}

export function rebaseHistoricalPath(
  value: string,
  history: PathBases[],
  current: PathBases,
): string {
  for (const previous of history) {
    const ref = pathReference(value, previous);
    if (ref) return resolvePathReference(value, ref, current) as string;
  }
  return value;
}

export function configurationBindings(
  data: any,
  bases: PathBases,
  history: PathBases[] = [],
) {
  return {
    schemaVersion: 1,
    origin: bases,
    history,
    directories: Object.fromEntries(
      (data.gameDirectories || [])
        .map((d: any) => [d.id, pathReference(d.path, bases)])
        .filter((entry: any[]) => entry[1]),
    ),
    java: pathReference(data.settings?.javaPath, bases),
    instances: Object.fromEntries(
      (data.instances || [])
        .map((i: any) => [i.id, pathReference(i.javaPath, bases)])
        .filter((entry: any[]) => entry[1]),
    ),
  };
}

/** Decode only launcher-owned location fields. User external roots and explicit
 * edits retain their original meaning; no files are moved, copied or created. */
export async function resolveConfigurationPaths(
  data: any,
  bases: PathBases,
): Promise<{ data: any; history: PathBases[] }> {
  const next = structuredClone(data);
  const metadata =
    data.pathBindings?.schemaVersion === 1 ? data.pathBindings : undefined;
  let previous: PathBases | undefined = validBases(metadata?.origin)
    ? metadata.origin
    : undefined;
  let legacy = false;
  if (!metadata && Array.isArray(data.gameDirectories)) {
    const prior = data.gameDirectories.find(
      (d: any) =>
        d?.isDefault &&
        d.layout === "standard" &&
        absolute(d.path) &&
        path.basename(d.path) === ".minecraft",
    );
    // Legacy copies are associated only when the destination actually exists.
    // A deleted/missing game directory must never be silently recreated.
    if (
      prior &&
      path.resolve(prior.path) !== path.resolve(bases.game) &&
      (await fs.lstat(bases.game).catch(() => null))?.isDirectory()
    ) {
      previous = {
        game: prior.path,
        data: path.join(path.dirname(prior.path), "LDFCL-data"),
        ...(bases.program ? { program: path.dirname(prior.path) } : {}),
      };
      legacy = true;
    }
  }
  const moved = legacy || !!(previous && basesMoved(previous, bases));
  const history: PathBases[] = [];
  for (const item of [
    moved ? previous : undefined,
    ...(Array.isArray(metadata?.history) ? metadata.history : []),
  ]) {
    if (
      validBases(item) &&
      JSON.stringify(item) !== JSON.stringify(bases) &&
      !history.some((b) => JSON.stringify(b) === JSON.stringify(item))
    )
      history.push(item);
  }
  const reference = (value: unknown, saved: unknown) =>
    moved
      ? resolvePathReference(
          value,
          legacy && previous ? pathReference(value, previous) : saved,
          bases,
        )
      : value;
  if (Array.isArray(next.gameDirectories))
    for (const directory of next.gameDirectories)
      if (directory && typeof directory === "object")
        directory.path = reference(
          directory.path,
          metadata?.directories?.[directory.id],
        );
  if (next.settings && typeof next.settings === "object")
    next.settings.javaPath = reference(next.settings.javaPath, metadata?.java);
  if (Array.isArray(next.instances))
    for (const instance of next.instances)
      if (
        instance &&
        typeof instance === "object" &&
        instance.javaPath !== undefined
      )
        instance.javaPath = reference(
          instance.javaPath,
          metadata?.instances?.[instance.id],
        );
  return { data: next, history: history.slice(0, 32) };
}
