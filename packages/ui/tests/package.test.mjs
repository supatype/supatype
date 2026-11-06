// Checks the built and packed shape of @supatype/ui: what a consumer installing it from npm gets.
// Runs against dist/, so the package must be built first (turbo's test task depends on build).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
const LEXICAL = /^(lexical|@lexical\/)/

/** Every target path named in package.json "exports", flattened. */
function exportTargets(node) {
  if (typeof node === "string") return [node]
  return Object.values(node).flatMap(exportTargets)
}

/** Bare module specifiers reachable from a built entry file through its relative imports. */
function bareImports(entry) {
  const seen = new Set()
  const bare = new Set()
  const pending = [entry]
  const importRe = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, "utf8").matchAll(importRe)) {
      const spec = match[1] ?? match[2]
      if (spec === undefined) continue
      if (spec.startsWith(".")) pending.push(resolve(dirname(file), spec))
      else bare.add(spec)
    }
  }
  return [...bare]
}

let packed

/** The tarball's file list, from one `npm pack --dry-run` shared by the tests that read it. */
function packedFiles() {
  if (packed === undefined) {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", { cwd: pkgDir, encoding: "utf8" })
    const [report] = JSON.parse(out)
    packed = report.files.map((f) => f.path.replaceAll("\\", "/"))
  }
  return packed
}

test("every exports target exists after build", () => {
  for (const target of exportTargets(pkg.exports)) {
    assert.ok(existsSync(join(pkgDir, target)), `missing ${target}`)
  }
})

test("dist/styles.css carries the rich text editor rules", () => {
  const css = readFileSync(join(pkgDir, "dist/styles.css"), "utf8")
  for (const cls of [".su-richtext-toolbar", ".su-richtext-surface", ".su-richtext-placeholder", ".su-rt-link"]) {
    assert.ok(css.includes(cls), `styles.css has no ${cls}`)
  }
})

/** Every class name string in a nested editor theme object. */
function themeClasses(node) {
  if (typeof node === "string") return node.split(/\s+/)
  return Object.values(node).flatMap(themeClasses)
}

async function editorTheme() {
  const mod = await import(pathToFileURL(join(pkgDir, "dist/RichTextEditor.js")).href)
  return mod.EDITOR_THEME
}

test("every editor theme class has a rule in styles.css", async () => {
  const css = readFileSync(join(pkgDir, "dist/styles.css"), "utf8")
  const unstyled = themeClasses(await editorTheme()).filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(css))
  assert.deepEqual(unstyled, [])
})

test("text that is underlined and struck through gets its own class", async () => {
  // With both formats, Lexical puts both separate classes on the text, and both set
  // text-decoration, so whichever rule comes later wins and only one line shows. A theme
  // underlineStrikethrough class replaces the pair, so it can draw both lines.
  const theme = await editorTheme()
  assert.equal(typeof theme.text.underlineStrikethrough, "string")
})

test("a quote gets a theme class, styled from the --su-rt-* variables", async () => {
  // QuoteNode is registered, so a pasted blockquote becomes one; without a theme class it rendered
  // as a bare <blockquote> that no rule of the package reached.
  const theme = await editorTheme()
  assert.equal(typeof theme.quote, "string")
  const css = readFileSync(join(pkgDir, "dist/styles.css"), "utf8")
  const rule = css.match(new RegExp(`\\.${theme.quote}\\s*\\{([^}]*)\\}`))?.[1] ?? ""
  assert.match(rule, /var\(--su-rt-/)
})

test("the main entry never reaches lexical", () => {
  const leaked = bareImports(join(pkgDir, "dist/index.js")).filter((s) => LEXICAL.test(s))
  assert.deepEqual(leaked, [])
})

test("the rich-text entry is where lexical lives", () => {
  const entry = join(pkgDir, "dist/rich-text.js")
  assert.ok(existsSync(entry), "dist/rich-text.js missing")
  assert.ok(bareImports(entry).some((s) => LEXICAL.test(s)), "rich-text entry does not import lexical")
})

test("the main entry loads", async () => {
  const mod = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href)
  assert.notEqual(mod.Button, undefined)
  assert.equal(typeof mod.emptyRichTextDocument, "function")
  assert.equal(mod.RichTextEditor, undefined)
})

test("every lexical peer is optional", () => {
  const lexicalPeers = Object.keys(pkg.peerDependencies).filter((s) => LEXICAL.test(s))
  assert.ok(lexicalPeers.length > 0)
  for (const name of lexicalPeers) {
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} is not optional`)
  }
})

test("no unused Radix dependencies", () => {
  const radix = Object.keys(pkg.dependencies ?? {}).filter((s) => s.startsWith("@radix-ui/"))
  assert.deepEqual(radix, [])
})

test("the tarball has no source or declaration maps", () => {
  assert.deepEqual(packedFiles().filter((f) => f.endsWith(".map")), [])
})

test("the tarball ships dist, styles, README, CHANGELOG and LICENSE, and no sources", () => {
  const files = packedFiles()
  const components = ["Select", "Textarea", "Checkbox", "Table", "field"].flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`])
  for (const want of ["dist/index.js", "dist/rich-text.js", "dist/rich-text.d.ts", "dist/styles.css", ...components, "README.md", "CHANGELOG.md", "LICENSE"]) {
    assert.ok(files.includes(want), `tarball lacks ${want}`)
  }
  const stray = files.filter((f) => f.startsWith("src/") || f.endsWith(".tsbuildinfo") || f.startsWith("tests/"))
  assert.deepEqual(stray, [])
})
