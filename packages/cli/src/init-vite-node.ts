/**
 * Whether the Node that will run the app's Vite can start the Vite init adds.
 *
 * 0.9.2 release test (N-FF8): the CLI runs on Node 18, and init gave a new app Vite 8, which needs
 * Node 20.19 or later. Nothing said so: `supatype dev` restarted the app forever on `SyntaxError ...
 * 'styleText'` and the App URL answered 502. Init now refuses, before it writes anything, and names
 * the Node to install, as the CLI's own floor refusal does (bin/node-version.js).
 */

import { execFileSync } from "node:child_process"
import semver from "semver"
import { isCompiledBinary } from "./cli-install-method.js"
import { VITE_NODE_RANGE, VITE_RANGE } from "./init-package-json.js"
import { declaredVite, readPackageJson } from "./init-project-detect.js"
import { nodeExecutable } from "./node-executable.js"

/** What the first `node` on PATH said its version is, once asked: a spawn with a 5 s limit. */
let pathNodeVersion: { version: string | undefined } | undefined

/**
 * The version of the Node that runs Vite: this one under Node, and from the compiled binary the
 * first `node` on PATH, which is what `dev` starts Vite with (node-executable.ts). Undefined when
 * there is none or it does not answer. Asked once from the binary: init checks when Vite is chosen
 * and again before it writes.
 */
function viteNodeVersion(): string | undefined {
  if (!isCompiledBinary()) return process.versions.node
  pathNodeVersion ??= { version: askPathNode() }
  return pathNodeVersion.version
}

function askPathNode(): string | undefined {
  try {
    return execFileSync(nodeExecutable("vite"), ["--version"], { encoding: "utf8", timeout: 5_000 }).trim().replace(/^v/, "")
  } catch {
    return undefined
  }
}

/** The refusal for Node `version`, or undefined when it runs the Vite init adds. */
export function viteNodeRefusal(version: string): string | undefined {
  if (semver.valid(version) === null || semver.satisfies(version, VITE_NODE_RANGE)) return undefined
  const major = semver.major(semver.minVersion(VITE_RANGE) ?? "0.0.0")
  return (
    `A Vite app needs ${viteNodeMinimums()} for Vite ${major}, which init adds; ` +
    `this is Node.js ${version}. Install a newer Node from https://nodejs.org, or run init again without a Vite app.`
  )
}

/**
 * The Node minimums in VITE_NODE_RANGE, said as "Node.js 20.19 or later (22.12 or later on Node 22)":
 * the first part's floor, then each later part's floor on its own major.
 */
function viteNodeMinimums(): string {
  const said = (v: semver.SemVer): string => (v.patch === 0 ? `${v.major}.${v.minor}` : v.version)
  return VITE_NODE_RANGE.split("||")
    .map((part) => semver.minVersion(part.trim()) ?? new semver.SemVer("0.0.0"))
    .map((v, i) => (i === 0 ? `Node.js ${said(v)} or later` : ` (${said(v)} or later on Node ${v.major})`))
    .join("")
}

/**
 * Throw when init is about to add Vite to `dir` (a Vite app whose package.json lists none) and the
 * Node that would run it cannot. An app that lists its own Vite keeps it, so it is not refused.
 */
export function refuseViteOnOldNode(dir: string, viteDevUrl: string | undefined): void {
  if (viteDevUrl === undefined || declaredVite(readPackageJson(dir)) !== undefined) return
  refuseAddingViteOnOldNode()
}

/**
 * Throw when the Node that would run the Vite init adds cannot. Asked as soon as Vite is chosen too,
 * so init does not ask every question after it first (0.9.2 release test round 2, pm N2).
 */
export function refuseAddingViteOnOldNode(): void {
  const version = viteNodeVersion()
  const refusal = version === undefined ? undefined : viteNodeRefusal(version)
  if (refusal !== undefined) throw new Error(refusal)
}
