import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isJsonObject, isShape } from "@supatype/shared"
import { parseJsonAs } from "../support/json.js"
import { makeMinisign } from "../support/minisign.js"
import { cliArchiveName, cliExecutableName } from "../../src/cli-artifacts.js"

/**
 * A release of this checkout, made the way the release workflow makes one, at a version no real
 * release uses: the npm package, the compiled program, and a signed CDN layout to serve it from.
 *
 * The package is staged in a copy rather than packed in place, because the version has to be
 * stamped into it, and stamping the checkout would leave it modified if the run were interrupted.
 */

export const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const packagesDir = join(cliDir, "..")

/** Under the CLI's own node_modules, so Bun resolves the copy's imports from the workspace. */
const STAGE_ROOT = join(cliDir, "node_modules", ".cache", "supatype-packed-test")

/** The CLI's `files` list, which is what `npm pack` reads from the staged copy. */
const PACKED_PATHS = ["bin", "dist", "releases", "deno.d.ts", "CHANGELOG.md", "LICENSE", "package.json"]

export function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  // A shell only for the package managers, which are `.cmd` scripts on Windows that spawn cannot
  // start directly. Every argument here is fixed or a temp path.
  const shell = process.platform === "win32" && ["npm", "npx", "pnpm"].includes(command)
  const quoted = shell ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)) : args
  return spawnSync(command, quoted, { cwd, encoding: "utf8", shell, timeout: 300_000, env: env ?? process.env })
}

export function mustRun(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = run(command, args, cwd, env)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

const isPackageJson = isShape({ dependencies: isJsonObject })

/** The staged copy's package.json: the test version, and `@supatype/shared` from its tarball. */
function stampPackageJson(dir: string, version: string, sharedTarball: string): void {
  const file = join(dir, "package.json")
  const pkg = parseJsonAs(readFileSync(file, "utf8"), isPackageJson)
  const dependencies = { ...pkg.dependencies, "@supatype/shared": fileSpec(sharedTarball) }
  writeFileSync(file, JSON.stringify({ ...pkg, version, dependencies }, null, 2))
}

/** What scripts/set-version.mjs writes into the source before a release build. */
function stampEmbeddedVersion(dir: string, version: string): void {
  const file = join(dir, "dist", "cli-version-embedded.js")
  const source = readFileSync(file, "utf8")
  const stamped = source.replace('EMBEDDED_CLI_VERSION = ""', `EMBEDDED_CLI_VERSION = ${JSON.stringify(version)}`)
  if (stamped === source) throw new Error(`${file} has no empty EMBEDDED_CLI_VERSION to stamp`)
  writeFileSync(file, stamped)
}

export function fileSpec(path: string): string {
  return `file:${path.split("\\").join("/")}`
}

/** A copy of the built CLI package at `version`, ready to pack and compile. */
export function stageCliPackage(version: string, sharedTarball: string): string {
  const dir = join(STAGE_ROOT, version)
  rmSync(dir, { recursive: true, force: true })
  for (const path of PACKED_PATHS) cpSync(join(cliDir, path), join(dir, path), { recursive: true })
  stampPackageJson(dir, version, sharedTarball)
  stampEmbeddedVersion(dir, version)
  return dir
}

export function removeStagedPackage(version: string): void {
  rmSync(join(STAGE_ROOT, version), { recursive: true, force: true })
}

/** `pnpm pack` for a workspace package, which rewrites `workspace:*` to a version. */
export function packWorkspacePackage(name: string, destination: string): string {
  mustRun("pnpm", ["pack", "--pack-destination", destination], join(packagesDir, name))
  return findTarball(destination, `supatype-${name}-`)
}

export function packStagedCli(stageDir: string, destination: string): string {
  mustRun("npm", ["pack", "--pack-destination", destination, "--ignore-scripts"], stageDir)
  return findTarball(destination, "supatype-cli-")
}

function findTarball(dir: string, prefix: string): string {
  const file = readdirSync(dir).find((entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"))
  if (file === undefined) throw new Error(`no ${prefix}*.tgz in ${dir}`)
  return join(dir, file)
}

/** The program for this machine, compiled from the staged copy as the release script compiles it. */
export function compileProgram(stageDir: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const program = join(outDir, cliExecutableName())
  mustRun("bun", ["build", join(stageDir, "dist", "main.js"), "--compile", "--outfile", program], stageDir)
  return program
}

/** Zips on Windows and tars elsewhere, with the one executable at the root, as the release does. */
function archiveProgram(program: string, archive: string): void {
  const dir = dirname(program)
  const name = program.slice(dir.length + 1)
  if (process.platform === "win32") {
    mustRun("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${program}' -DestinationPath '${archive}' -Force`], dir)
  } else {
    mustRun("tar", ["-czf", archive, "-C", dir, name], dir)
  }
}

export interface Mirror {
  /** The CDN root to put in SUPATYPE_CDN_BASE. */
  base: string
  /** The minisign public key that signed the manifest, for SUPATYPE_RELEASE_PUBLIC_KEY. */
  publicKey: string
  /** Serve a corrupted archive from now on. */
  tamper(): void
  close(): Promise<void>
}

/** The CDN layout for one version, signed with a throwaway key. */
function writeRelease(root: string, version: string, program: string): string {
  const dir = join(root, "cli", `v${version}`)
  mkdirSync(dir, { recursive: true })
  const name = cliArchiveName()
  archiveProgram(program, join(dir, name))
  const sha = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")
  const manifest = Buffer.from(`${sha}  ${name}\n`)
  writeFileSync(join(dir, "checksums.sha256"), manifest)
  const { pubKeyStr, sigFile } = makeMinisign(manifest, "prehashed")
  writeFileSync(join(dir, "checksums.sha256.minisig"), sigFile)
  return pubKeyStr
}

/** The port mirror-server.mjs printed, once it is listening. */
function listeningPort(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ""
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes("\n")) resolve(out.trim())
    })
    server.once("exit", (code) => reject(new Error(`the mirror exited with ${code} before listening`)))
  })
}

/** Serves `root` over HTTP on a free local port, from a process of its own. */
export async function serveRelease(root: string, version: string, program: string): Promise<Mirror> {
  const publicKey = writeRelease(root, version, program)
  const server = spawn(process.execPath, [join(cliDir, "tests", "packed", "mirror-server.mjs"), root], { stdio: ["ignore", "pipe", "inherit"] })
  const port = await listeningPort(server)
  return {
    base: `http://127.0.0.1:${port}`,
    publicKey,
    tamper: () => writeFileSync(join(root, "TAMPER"), ""),
    close: () => stopServer(server),
  }
}

function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    server.once("exit", () => resolve())
    server.kill()
  })
}
