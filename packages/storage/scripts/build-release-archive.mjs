#!/usr/bin/env node
/**
 * Build the storage service's release archive for one platform.
 *
 * Usage: node packages/storage/scripts/build-release-archive.mjs <platform> <out-dir>
 *   platform: linux-amd64 | linux-arm64 | darwin-amd64 | darwin-arm64 | windows-amd64
 *
 * Needs a built dist/ (pnpm --filter "@supatype/storage..." build). Writes
 * <out-dir>/supatype-storage-<platform>.tar.gz (a .zip for Windows) holding:
 *   supatype-storage[.exe]   the service, bundled and packaged with Node by pkg
 *   node_modules/            sharp and its prebuilt libvips for <platform>
 *
 * sharp is a native addon that loads libvips from files beside it, which no single-file executable
 * can hold, so it ships as files next to the executable (scripts/sharp-beside-executable.cjs). When
 * the platform is the machine's own, the packaged service renders one image (--self-test) before
 * anything is archived, so a release whose sharp does not load is refused here, not on a user's
 * machine. Kept as a script, as realtime's bundling is, so it runs locally as it runs in CI.
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Each platform the CLI downloads storage for: its pkg target and npm's os and cpu for sharp. */
const PLATFORMS = {
  "linux-amd64": { pkg: "node22-linux-x64", os: "linux", cpu: "x64" },
  "linux-arm64": { pkg: "node22-linux-arm64", os: "linux", cpu: "arm64" },
  "darwin-amd64": { pkg: "node22-macos-x64", os: "darwin", cpu: "x64" },
  "darwin-arm64": { pkg: "node22-macos-arm64", os: "darwin", cpu: "arm64" },
  "windows-amd64": { pkg: "node22-win-x64", os: "win32", cpu: "x64" },
}

function die(message) {
  console.error(`build-release-archive: ${message}`)
  process.exit(1)
}

/** Runs `command`, through a shell on Windows where npx is a .cmd; dies when it fails. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
  if (result.status !== 0) die(`${command} ${args.join(" ")} exited ${result.status}`)
}

/** The sharp version the service is built and tested against, from its own dependency tree. */
function sharpVersion() {
  return createRequire(join(ROOT, "package.json"))("sharp/package.json").version
}

function bundle(outfile) {
  run("npx", [
    "--yes", "esbuild@0.25.5", "dist/index.js", "--bundle", "--platform=node", "--target=node22", "--format=cjs",
    "--alias:sharp=./scripts/sharp-beside-executable.cjs", `--outfile=${outfile}`,
  ], ROOT)
}

/** sharp and its prebuilt libvips for `target`, installed into `stage/node_modules`. */
function stageSharp(stage, target) {
  writeFileSync(join(stage, "package.json"), '{ "private": true }\n')
  run("npm", [
    "install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock",
    `--os=${target.os}`, `--cpu=${target.cpu}`, `sharp@${sharpVersion()}`,
  ], stage)
  rmSync(join(stage, "package.json"))
}

/** Whether this machine can run the platform's executable. */
function isHostPlatform(target) {
  return target.os === process.platform && target.cpu === process.arch
}

/** tar.gz, or a zip for Windows, of the executable and node_modules. Windows' own tar writes zips. */
function archive(stage, exe, out) {
  const entries = [basename(exe), "node_modules"]
  if (out.endsWith(".zip")) {
    const tar = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
    run(tar, ["-a", "-c", "-f", out, ...entries], stage)
  } else {
    run("tar", ["-czf", out, ...entries], stage)
  }
}

function main([platform, outDir]) {
  const target = PLATFORMS[platform]
  if (target === undefined || outDir === undefined) {
    die(`usage: build-release-archive.mjs <${Object.keys(PLATFORMS).join("|")}> <out-dir>`)
  }
  const work = mkdtempSync(join(tmpdir(), "storage-release-"))
  const stage = join(work, "stage")
  mkdirSync(stage)
  const exe = join(stage, platform.startsWith("windows-") ? "supatype-storage.exe" : "supatype-storage")
  bundle(join(work, "bundle.cjs"))
  run("npx", ["--yes", "@yao-pkg/pkg@6.6.0", join(work, "bundle.cjs"), "--targets", target.pkg, "--output", exe], ROOT)
  stageSharp(stage, target)
  if (isHostPlatform(target)) run(exe, ["--self-test"], stage)
  else console.warn(`build-release-archive: ${platform} is not this machine's platform, so --self-test was not run`)
  mkdirSync(resolve(outDir), { recursive: true })
  const ext = platform.startsWith("windows-") ? "zip" : "tar.gz"
  archive(stage, exe, join(resolve(outDir), `supatype-storage-${platform}.${ext}`))
  rmSync(work, { recursive: true, force: true })
}

main(process.argv.slice(2))
