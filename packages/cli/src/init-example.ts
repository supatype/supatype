/**
 * `supatype init <dir> --example <name>`: start from one of the repository's examples.
 *
 * The example comes from the release tag matching the running CLI (`v<version>`), so the code and
 * the CLI that runs it are the same release. GitHub's codeload tarball of that tag is read in memory
 * and only `examples/<name>/` is written. In the repository an example depends on the packages
 * through `workspace:*`, which installs nowhere else, so each is pinned to `^<version>`.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, posix } from "node:path"
import { isJsonObject, parseJsonObject } from "@supatype/shared"
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

/** An entry's path inside the repository: the archive's root folder (`supatype-<version>/`) removed. */
function repoPath(entry: TarEntry): string {
  return entry.path.slice(entry.path.indexOf("/") + 1)
}

/** The examples in the archive: folders directly under `examples/`. */
export function exampleNames(entries: readonly TarEntry[]): string[] {
  const names = new Set<string>()
  for (const entry of entries) {
    const parts = repoPath(entry).split("/")
    if (parts[0] === "examples" && parts.length > 2 && parts[1] !== undefined && parts[1] !== "") names.add(parts[1])
  }
  return [...names].sort()
}

/** The files of `examples/<name>/`, relative to it; refuses a name the archive has no folder for. */
export function selectExample(entries: readonly TarEntry[], name: string): ExampleFile[] {
  const names = exampleNames(entries)
  if (!names.includes(name)) {
    throw new Error(`Unknown example "${name}". The examples are: ${names.join(", ")}.`)
  }
  const root = `examples/${name}/`
  return entries
    .filter((entry) => entry.kind === "file" && repoPath(entry).startsWith(root))
    .map((entry) => ({ path: insideExample(repoPath(entry).slice(root.length), name), data: entry.data }))
}

/** A path that stays inside the example folder, or a refusal: an archive names its own paths. */
function insideExample(path: string, name: string): string {
  const normal = posix.normalize(path)
  if (normal.startsWith("../") || normal === ".." || posix.isAbsolute(normal) || /^[A-Za-z]:/.test(normal)) {
    throw new Error(`The archive's example "${name}" has a file outside the example: ${path}`)
  }
  return normal
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
    const target = join(dir, ...file.path.split("/"))
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
