#!/usr/bin/env node
/**
 * Refuse to publish the CLI unless a project `supatype init` writes can install and run on it.
 *
 * FF-32: a CLI whose version had no published packages scaffolded `@supatype/* ^<version>` and a
 * `supatype-prepare` script nothing at that version provided, and its program was not on the CDN
 * or could not be verified, so a fresh project's install failed. For the version being released:
 *
 *   1. every @supatype/* package init scaffolds is being published in this run, or already is,
 *      at that version;
 *   2. the client, which owns the `supatype-prepare` bin, declares it;
 *   3. the minisign public key is embedded in this build, or `supatype generate` stops with
 *      "No minisign public key configured" when it fetches the program;
 *   4. the CLI program for that version is on the CDN (its checksums and their signature).
 *
 * Usage: node scripts/check-cli-release.mjs <version>
 * Run it in the npm job after the public key is embedded and before anything is published.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(fileURLToPath(import.meta.url), "..", "..")
const CDN = "https://releases.supatype.com"
const REGISTRY = "https://registry.npmjs.org"
const REQUEST_TIMEOUT_MS = 15_000

/** The CDN paths that make a CLI version's program downloadable and verifiable. */
export function cdnPathsFor(version) {
  return [`/cli/v${version}/checksums.sha256`, `/cli/v${version}/checksums.sha256.minisig`]
}

/**
 * The problems that make `version` unfit to release, empty when none. Decision logic only: what
 * was read from the tree and what the network answered are arguments, so it is tested without either.
 *
 * @param {object} facts
 * @param {string} facts.version The version being released.
 * @param {string[]} facts.scaffolded Package names init writes into a project's package.json.
 * @param {string[]} facts.publishing Package names this run publishes.
 * @param {(name: string, version: string) => Promise<boolean>} facts.isPublished Whether npm has it.
 * @param {string} facts.embeddedPublicKey EMBEDDED_RELEASE_PUBLIC_KEY of this build.
 * @param {string | undefined} facts.clientPrepareBin What the client's package.json says supatype-prepare is, if it declares it.
 * @param {string} facts.prepareCommand The bin init's `prepare` script runs.
 * @param {(path: string) => Promise<boolean>} facts.cdnHas Whether the CDN serves `path`.
 * @returns {Promise<string[]>}
 */
export async function releaseProblems(facts) {
  const problems = []
  for (const name of facts.scaffolded) {
    if (facts.publishing.includes(name)) continue
    if (await facts.isPublished(name, facts.version)) continue
    problems.push(`init scaffolds @supatype/${name} ^${facts.version}, which this run does not publish and npm does not have.`)
  }
  if (facts.clientPrepareBin === undefined) {
    problems.push(`@supatype/client declares no "${facts.prepareCommand}" bin, which init's "prepare" script runs.`)
  }
  if (facts.embeddedPublicKey.trim() === "") {
    problems.push("The minisign public key is not embedded in this build (run scripts/embed-release-pubkey.mjs first).")
  }
  for (const path of cdnPathsFor(facts.version)) {
    if (!(await facts.cdnHas(path))) problems.push(`The CDN does not serve ${CDN}${path}.`)
  }
  return problems
}

/** Source text without its block and line comments, so a name in prose is not mistaken for code. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** The @supatype/* packages init writes into a project, from the source that writes them. */
export function scaffoldedPackages(initPackageJsonSource) {
  const names = new Set()
  for (const match of withoutComments(initPackageJsonSource).matchAll(/["'`]@supatype\/([a-z0-9-]+)["'`]/g)) {
    names.add(match[1])
  }
  return [...names].sort()
}

/** The command init's `prepare` script runs: `export const PREPARE_COMMAND = "..."`. */
export function prepareCommandOf(initPackageJsonSource) {
  return /export const PREPARE_COMMAND = "([^"]+)"/.exec(initPackageJsonSource)?.[1]
}

/** The names in release.yml's `PACKAGES=( ... )`, which is what the npm job publishes. */
export function publishedPackages(releaseWorkflow) {
  const block = /PACKAGES=\(([\s\S]*?)\)/.exec(releaseWorkflow)?.[1]
  if (block === undefined) return []
  return block.split("\n").map((line) => line.replace(/#.*$/, "").trim()).filter((line) => line !== "")
}

/** The embedded key, "" when the build has none. */
export function embeddedKeyOf(releasePublicKeySource) {
  return /EMBEDDED_RELEASE_PUBLIC_KEY = "([^"]*)"/.exec(releasePublicKeySource)?.[1] ?? ""
}

async function reachable(url, init) {
  try {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return resp.ok
  } catch {
    return false
  }
}

const readText = (...parts) => readFileSync(join(ROOT, ...parts), "utf8")

async function main() {
  const version = (process.argv[2] ?? "").trim().replace(/^v/, "")
  if (version === "") {
    console.error("Usage: node scripts/check-cli-release.mjs <version>")
    process.exit(2)
  }
  const initSource = readText("packages", "cli", "src", "init-package-json.ts")
  const prepareCommand = prepareCommandOf(initSource)
  if (prepareCommand === undefined) {
    console.error("check-cli-release: PREPARE_COMMAND not found in init-package-json.ts")
    process.exit(2)
  }
  const clientBin = JSON.parse(readText("packages", "client", "package.json")).bin ?? {}
  const problems = await releaseProblems({
    version,
    scaffolded: scaffoldedPackages(initSource),
    publishing: publishedPackages(readText(".github", "workflows", "release.yml")),
    isPublished: (name, v) => reachable(`${REGISTRY}/@supatype%2f${name}/${v}`),
    embeddedPublicKey: embeddedKeyOf(readText("packages", "cli", "src", "release-public-key.ts")),
    clientPrepareBin: clientBin[prepareCommand],
    prepareCommand,
    cdnHas: (path) => reachable(`${CDN}${path}`, { method: "HEAD" }),
  })
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`)
    console.error(`check-cli-release: ${version} is not fit to release.`)
    process.exit(1)
  }
  console.log(`check-cli-release: ${version} is fit to release.`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()
