#!/usr/bin/env node
/**
 * release/images.json names the images a release runs that are built in other repositories: the
 * schema engine, the server and Postgres, each by its Docker Hub tag and the commit that tag names.
 * scripts/pin.sh decides what goes in it; this file reads and writes the JSON for it and renders the
 * CLI's copy, packages/cli/src/generated/release-images.ts, so the two cannot disagree.
 *
 * Usage:
 *   node scripts/release-images.mjs get <engine|server|postgres> <image|tag|commit>
 *   node scripts/release-images.mjs set <engine|server|postgres> <tag> <commit>
 *   node scripts/release-images.mjs generate [--check]
 *
 * `generate --check` writes nothing and exits 1 when the CLI's copy is stale.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PIN_FILE = join(ROOT, "release", "images.json")
const GENERATED = join(ROOT, "packages", "cli", "src", "generated", "release-images.ts")
const COMPONENTS = ["engine", "server", "postgres"]
const FIELDS = ["image", "tag", "commit"]

function die(message) {
  console.error(`release-images: ${message}`)
  process.exit(1)
}

/** One pin, checked: an image name, a tag and a full commit. */
function checkedPin(name, pin) {
  if (typeof pin !== "object" || pin === null) die(`${name} is missing from ${PIN_FILE}`)
  const { image, tag, commit } = pin
  if (typeof image !== "string" || !/^[a-z0-9./-]+$/.test(image)) die(`${name}.image is not an image name: ${image}`)
  if (typeof tag !== "string" || !/^[A-Za-z0-9._-]+$/.test(tag)) die(`${name}.tag is not a tag: ${tag}`)
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) die(`${name}.commit is not a full commit: ${commit}`)
  return { image, tag, commit }
}

function readPins() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(PIN_FILE, "utf8"))
  } catch (err) {
    die(`cannot read ${PIN_FILE}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return Object.fromEntries(COMPONENTS.map((name) => [name, checkedPin(name, parsed?.[name])]))
}

function render(pins) {
  const lines = COMPONENTS.map((name) => {
    const { image, tag, commit } = pins[name]
    return `  ${name}: { image: ${JSON.stringify(image)}, tag: ${JSON.stringify(tag)}, commit: ${JSON.stringify(commit)} },`
  })
  return [
    "// Generated from release/images.json by scripts/release-images.mjs. Do not edit: run",
    "// `bash scripts/pin.sh set <engine|server|postgres> <tag>`, which rewrites both.",
    "export const PINNED_IMAGES = {",
    ...lines,
    "} as const",
    "",
  ].join("\n")
}

function readText(path) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

function generate(check) {
  const text = render(readPins())
  if (readText(GENERATED) === text) return
  if (check) die(`${GENERATED} is stale: run 'node scripts/release-images.mjs generate'`)
  mkdirSync(dirname(GENERATED), { recursive: true })
  writeFileSync(GENERATED, text, "utf8")
}

function component(name) {
  if (!COMPONENTS.includes(name)) die(`unknown component '${name}', expected one of ${COMPONENTS.join(", ")}`)
  return name
}

function get(name, field) {
  if (!FIELDS.includes(field)) die(`unknown field '${field}', expected one of ${FIELDS.join(", ")}`)
  console.log(readPins()[component(name)][field])
}

function set(name, tag, commit) {
  const pins = readPins()
  pins[component(name)] = checkedPin(name, { image: pins[name].image, tag, commit })
  writeFileSync(PIN_FILE, `${JSON.stringify(pins, null, 2)}\n`, "utf8")
  generate(false)
}

const [command, ...args] = process.argv.slice(2)
if (command === "get" && args.length === 2) get(args[0], args[1])
else if (command === "set" && args.length === 3) set(args[0], args[1], args[2])
else if (command === "generate") generate(args[0] === "--check")
else die("usage: release-images.mjs get <component> <field> | set <component> <tag> <commit> | generate [--check]")
