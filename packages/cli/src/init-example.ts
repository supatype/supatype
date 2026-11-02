/**
 * `supatype init <dir> --example <name>`: start from one of the repository's examples.
 *
 * The example comes from the release tag matching the running CLI (`v<version>`), so the code and
 * the CLI that runs it are the same release. GitHub's codeload tarball of that tag is read in memory
 * and only `examples/<name>/` is written. In the repository an example depends on the packages
 * through `workspace:*`, which installs nowhere else, so each is pinned to `^<version>`.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, posix } from "node:path"
import { isJsonObject, parseJsonObject, resolveInside } from "@supatype/shared"
import { readTarGz, type TarEntry } from "./tar-reader.js"

interface ExampleFile {
  /** Relative to the example's own folder, with forward slashes. */
  path: string
  data: Buffer
}

export interface InitFromExampleOptions {
  dir: string
  example: string
  /** The release to take the example from, without the `v`. */
  version: string
  /** Fetch a URL's body; the network in the CLI, a fixture in tests. */
  download: (url: string) => Promise<Buffer>
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

export function exampleTarballUrl(version: string): string {
  return `https://codeload.github.com/supatype/supatype/tar.gz/refs/tags/v${version}`
}

/**
 * An entry's path inside the repository: the archive's root folder (`supatype-<version>/`) removed.
 * A backslash is read as the separator Windows takes it for, so an unsafe name that would land in an
 * example is counted as part of it.
 */
function repoPath(entry: TarEntry): string {
  const path = entry.path.replace(/\\/g, "/")
  return path.slice(path.indexOf("/") + 1)
}

/** The examples in the archive: folders directly under `examples/`, named by safe entries only. */
export function exampleNames(entries: readonly TarEntry[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.safe) continue
    const parts = repoPath(entry).split("/")
    if (parts[0] === "examples" && parts.length > 2 && parts[1] !== undefined && parts[1] !== "") names.add(parts[1])
  }
  return [...names].sort()
}

/**
 * The files of `examples/<name>/`, relative to it. Refuses a name the archive has no folder for, and
 * an example holding an entry the tar reader marked unsafe; one elsewhere in the repository is never
 * written, so it does not stop the example.
 */
export function selectExample(entries: readonly TarEntry[], name: string): ExampleFile[] {
  const names = exampleNames(entries)
  if (!names.includes(name)) {
    throw new Error(`Unknown example "${name}". The examples are: ${names.join(", ")}.`)
  }
  const root = `examples/${name}/`
  const inExample = entries.filter((entry) => repoPath(entry).startsWith(root))
  const unsafe = inExample.find((entry) => !entry.safe)
  if (unsafe !== undefined) {
    throw new Error(`The example "${name}" has an unsafe entry name: ${JSON.stringify(unsafe.path)}. Nothing was written.`)
  }
  return inExample
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({ path: repoPath(entry).slice(root.length), data: entry.data }))
}

/**
 * Where an example file is written: under `dir` once resolved on this platform, or a refusal.
 * {@link selectExample} has already refused a name with a `..` segment, a backslash or a drive spec;
 * this checks where the file actually lands, whatever let it through.
 */
export function exampleTarget(dir: string, path: string): string {
  const target = resolveInside(dir, path)
  if (target === undefined) throw new Error(`The example's file ${JSON.stringify(path)} resolves outside ${dir}.`)
  return target
}

/** `package.json` text with every `workspace:` dependency pinned to `^<version>`. */
export function rewriteWorkspaceDependencies(text: string, version: string): string {
  const parsed = parseJsonObject(text)
  if (!parsed.ok) return text
  const pkg = parsed.value
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = pkg[section]
    if (!isJsonObject(deps)) continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) deps[name] = `^${version}`
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/** Download the release, write `examples/<example>/` into `dir`, and say how many files and whether it has a README. */
export async function initFromExample(options: InitFromExampleOptions): Promise<{ files: number; hasReadme: boolean }> {
  const { dir, example, version } = options
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and is not empty. Choose a new directory for the example.`)
  }
  const files = selectExample(readTarGz(await options.download(exampleTarballUrl(version))), example)
  for (const file of files) {
    const target = exampleTarget(dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    const isPackageJson = posix.basename(file.path) === "package.json"
    writeFileSync(target, isPackageJson ? rewriteWorkspaceDependencies(file.data.toString("utf8"), version) : file.data)
  }
  return { files: files.length, hasReadme: files.some((file) => file.path === "README.md") }
}

/** The release tarball over HTTPS, refusing anything but a 200. */
export async function downloadRelease(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) {
    throw new Error(
      `Could not download ${url} (HTTP ${response.status}). Examples are taken from the release tag ` +
        "matching this CLI, so a CLI built from source has none to download.",
    )
  }
  return Buffer.from(await response.arrayBuffer())
}
