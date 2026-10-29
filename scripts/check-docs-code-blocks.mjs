/**
 * Typecheck the TypeScript code blocks in the docs pages (docs-content/) against this repo's own
 * packages, and fail on any reference to an API that no longer exists.
 *
 * These pages documented a `@supatype/schema` builder API for months after it was replaced, because
 * nothing ever compiled them. Every fenced block that names a Supatype package is written out as a
 * real file and handed to `tsc`, so an API that does not exist fails here rather than in a reader's
 * editor. The check runs against each package's dist/, so build the packages in PACKAGES first:
 * the docs describe the current code, not the last npm release.
 *
 * Conventions available inside a block:
 *   `// file: name.ts`    split one block into several files (a cross-file example)
 *   `// docs:no-check`    exempt the block, for a fragment that cannot stand alone
 *
 * Usage: node scripts/check-docs-code-blocks.mjs [--keep]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DOCS = join(ROOT, "docs-content")
// A private workspace package that depends on the packages below, so a written block resolves
// them through node_modules and each package's own `exports`, as a reader's project does.
const HOME = join(ROOT, "tests", "docs-code-blocks")
const BLOCKS = join(HOME, ".blocks")
const PACKAGES = ["types", "client", "react", "react-auth", "react-native", "react-native-auth", "cli"]
const slash = (path) => path.replace(/\\/g, "/")
const pageName = (file) => slash(relative(DOCS, file))
const dist = (pkg, file = "index.d.ts") => slash(join(ROOT, "packages", pkg, "dist", file))

/** Every page: the generated .md pages and the hand-written .mdx ones. */
function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : /\.mdx?$/.test(full) ? [full] : []
  })
}

/** Writes one block as a file, or as a folder of files when it uses `// file:` markers. */
function writeBlock(out, name, ext, body) {
  const parts = body.split(/^\/\/ file: (\S+)\s*$/m)
  if (parts.length === 1) {
    writeFileSync(join(out, `${name}.${ext}`), body, "utf8")
    return 1
  }
  const dir = join(out, name)
  mkdirSync(dir, { recursive: true })
  for (let p = 1; p < parts.length; p += 2) writeFileSync(join(dir, parts[p]), parts[p + 1], "utf8")
  return (parts.length - 1) / 2
}

/**
 * A page's checked blocks. Only blocks naming a Supatype package are checked: a snippet of someone
 * else's API, a `@supabase/supabase-js` before/after or an Astro config, says nothing about
 * whether ours is real. `cli` counts because supatype.config.ts examples import from it, and one
 * once shipped with three fields that do not exist.
 *
 * A page may show one file in parts: a later block with the same title and no imports of its own
 * (the schema page's `HeroBlock`, defined "further down") is added to the checked block before it.
 * A block with a default export is a whole file, never a part.
 */
function pageBlocks({ file, text }, skipped) {
  const entries = []
  // A generated page's fence may carry a title (```ts title="schema/index.ts").
  const fences = text.matchAll(/```(typescript|tsx|ts)((?:[ \t][^\n]*)?)\n([\s\S]*?)```/g)
  ;[...fences].forEach(([, lang, info, body], i) => {
    const title = info.match(/title="([^"]*)"/)?.[1]
    const part = title && !/^(import|export default) /m.test(body)
    const earlier = part ? entries.findLast((entry) => entry.title === title) : undefined
    if (earlier) earlier.body += `\n${body}`
    else if (!/@supatype\/(types|client|react|functions|cli)/.test(body)) return
    else if (body.includes("docs:no-check")) skipped.push(`${pageName(file)} block ${i}`)
    else entries.push({ name: `${pageName(file).replace(/\//g, "__").replace(/\.mdx?$/, "")}__${i}`, ext: lang === "tsx" ? "tsx" : "ts", title, body })
  })
  return entries
}

/** Writes every checked block under `out`; returns how many files it wrote and which it skipped. */
function writeBlocks(pages, out) {
  // Examples import the reader's own client module as `./supatype`, so it sits beside them.
  writeFileSync(join(out, "supatype.ts"), readFileSync(join(HOME, "fixtures", "supatype.ts"), "utf8"))
  let written = 0
  const skipped = []
  for (const page of pages) {
    for (const { name, ext, body } of pageBlocks(page, skipped)) written += writeBlock(out, name, ext, body)
  }
  return { written, skipped }
}

/**
 * Vocabulary from APIs that no longer exist. The typecheck only sees blocks that name a Supatype
 * package, and the worst page once named none: it used `model()` and `field.text()` with no import
 * at all, so it read as ordinary TypeScript. This looks for the dead vocabulary itself, anywhere in
 * the page, code or prose.
 */
const BANNED = [
  [/@supatype\/schema\b/, "`@supatype/schema` was replaced by type-level `Model<…>` from `@supatype/types`"],
  [/\bmodel\(["'`]/, "`model()` builder: use `export type X = Model<Fields, Meta>`"],
  [/\bfield\.[a-zA-Z]+\(/, "`field.*()` builders: a field's type is its column type"],
  [/\b(belongsTo|hasMany|hasOne|manyToMany)\(/, "relation builders: use `RelatedTo`/`HasMany`/`HasOne`/`ManyToMany`"],
  [/\b(timestamps|publishable|softDelete)\(\)/, "composite spreads: use `WithTimestamps<…>` and friends"],
  [/\.access\(\{/, "`.access({…})`: access rules live in the model's second type argument"],
  [/\.admin\(\{/, "`.admin({…})` never existed; the field's type picks its Studio widget"],
  [/\bisLoading\b/, "hooks report `loading`, not `isLoading`"],
  [/createClient<Database>/, "no type argument: the generated `.d.ts` augments `@supatype/client`"],
  [/from ["']\.\/supatype\/types["']/, "no `Database` export; generated types are `supatype/generated/index.d.ts`"],
]

// A Supabase "before" example shows Supabase's own API, `createClient<Database>` included, so its
// lines are blanked (keeping the line numbers) before the scan.
const withoutSupabaseBlocks = (text) =>
  text.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => (block.includes("@supabase/supabase-js") ? block.replace(/[^\n]/g, "") : block))

function bannedLines(pages) {
  return pages.flatMap(({ file, text }) => withoutSupabaseBlocks(text).split("\n").flatMap((line, n) => {
    if (line.includes("docs:allow-legacy")) return []
    return BANNED.filter(([pattern]) => pattern.test(line))
      .map(([, why]) => `${pageName(file)}:${n + 1}  ${line.trim().slice(0, 70)}\n    ${why}`)
  }))
}

/** The tsconfig for the written blocks. Only the Next.js example's `@/` alias is mapped by hand. */
function writeTsconfig(out) {
  const compilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
    target: "ES2022", module: "Preserve", moduleResolution: "bundler", lib: ["ES2022", "DOM"], jsx: "react-jsx",
    types: ["node", "react"], paths: { "@/*": ["../fixtures/*"] },
  }
  const include = ["./**/*.ts", "./**/*.tsx", "../stubs.d.ts", "../schema.d.ts"]
  const tsconfig = join(out, "tsconfig.json")
  writeFileSync(tsconfig, JSON.stringify({ compilerOptions, include }, null, 2), "utf8")
  return tsconfig
}

function typecheck(tsconfig) {
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc")
  const result = spawnSync(process.execPath, [tsc, "-p", tsconfig], { cwd: ROOT, encoding: "utf8" })
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

function reportTypeErrors(output) {
  // `tsc` reports syntactic diagnostics *instead of* semantic ones, so one mis-tagged fence (JSX in
  // a ```typescript block) hides every wrong API on every other page. Say so.
  if (/error TS1\d{3}:/.test(output)) {
    console.error("\nSyntax errors below. These suppress ALL type checking, so fix them first,\n" +
      "usually a JSX block fenced as ```typescript instead of ```tsx.\n")
  }
  console.error(output)
  console.error("\nEach path above is a fenced block: <page>__<n> is the nth fenced block on that page.")
}

function main() {
  const missing = PACKAGES.filter((pkg) => !existsSync(dist(pkg)))
  if (missing.length > 0) throw new Error(`build these packages first: ${missing.map((p) => `@supatype/${p}`).join(", ")}`)
  const pages = walk(DOCS).map((file) => ({ file, text: readFileSync(file, "utf8") }))
  const out = BLOCKS
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const { written, skipped } = writeBlocks(pages, out)
  const banned = bannedLines(pages)
  console.log(`checking ${written} code block file(s) from ${pages.length} pages`)
  if (skipped.length > 0) console.log(`exempt (docs:no-check): ${skipped.join(", ")}`)
  const output = typecheck(writeTsconfig(out))
  if (process.argv.includes("--keep")) console.log(`blocks kept in ${out}`)
  else rmSync(out, { recursive: true, force: true })
  if (output.length > 0) reportTypeErrors(output)
  if (banned.length > 0) {
    console.error(`\n${banned.length} reference(s) to APIs that no longer exist:\n\n${banned.join("\n")}`)
    console.error("\nAdd `docs:allow-legacy` on the line if it is deliberately describing the old API.")
  }
  if (output.length > 0 || banned.length > 0) process.exit(1)
  console.log("all code blocks typecheck; no references to removed APIs")
}

main()
