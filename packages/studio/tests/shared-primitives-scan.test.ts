import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Controls, tables and links come from `components/ui.tsx`, so every screen shares one type scale,
 * spacing, border and focus ring. A raw `<button>`, `<select>`, `<input>`, `<textarea>`, table
 * element or `<a>` anywhere else fails here, naming the file and line, instead of drifting quietly.
 *
 * Links have a primitive for each face: `TextLink` for words, `ButtonLink` for a link that looks
 * like a button, `IconLink` for a glyph with a required name. `TextLink` and `ButtonLink` take the
 * router's `to` for a route, so a router `<Link>` given its own `className` fails here too. The one raw `<a>` allowed is the
 * child of an `asChild` menu item, where the menu draws the item and the anchor only navigates.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url))

/** Every .tsx file under `dir`, as a path relative to src. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return path.endsWith(".tsx") ? [relative(SRC, path).replace(/\\/g, "/")] : []
  })
}

/** Where the primitives themselves live. */
function isShared(file: string): boolean {
  return file === "components/ui.tsx" || file.startsWith("components/ui/")
}

/** Comments blanked line for line, so a doc comment that names `<input>` is not read as one. */
function code(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ")
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/gm, blank)
}

const RAW_CONTROL = /<(button|select|input|textarea|table|th|td|a)\b/

/** Whether the `<a>` on line `i` is the child of an `asChild` element, on its line or the one before. */
function isAsChildLink(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? ""
  const before = line.slice(0, line.search(/<a\b/))
  const previous = lines.slice(0, i).reverse().find((l) => l.trim() !== "") ?? ""
  return /asChild>\s*$/.test(before) || /asChild>\s*$/.test(previous)
}

/**
 * Whether the router `<Link>` opening on line `i` carries its own classes: a link dressed by hand,
 * where `ButtonLink` or `TextLink` with `to` gives it the shared face. Its opening tag may span lines.
 */
function isStyledRouterLink(lines: readonly string[], i: number): boolean {
  const rest = lines.slice(i).join("\n")
  return /^<Link\b[^>]*\bclassName=/.test(rest.slice(rest.search(/<Link\b/)))
}

/** `file:line  <tag` for every raw control in `source`; an `asChild` link is listed apart. */
function scan(file: string, source: string): { raw: string[]; asChild: string[] } {
  const lines = code(source).split("\n")
  const raw: string[] = []
  const asChild: string[] = []
  lines.forEach((line, i) => {
    if (/<Link\b/.test(line) && isStyledRouterLink(lines, i)) raw.push(`${file}:${i + 1}  <Link className`)
    const found = RAW_CONTROL.exec(line)
    if (!found) return
    const at = `${file}:${i + 1}  <${found[1]}`
    if (found[1] === "a" && isAsChildLink(lines, i)) asChild.push(at)
    else raw.push(at)
  })
  return { raw, asChild }
}

/** The scan of every Studio source file but the shared module. */
function scanStudio(): { raw: string[]; asChild: string[] } {
  const results = sources(SRC).filter((file) => !isShared(file)).map((file) => scan(file, readFileSync(join(SRC, file), "utf8")))
  return { raw: results.flatMap((r) => r.raw), asChild: results.flatMap((r) => r.asChild) }
}

describe("shared primitives", () => {
  it("draw every control, table and link in Studio outside the shared module", () => {
    expect(scanStudio().raw).toEqual([])
  })

  it("allow a raw anchor only as an asChild menu item's link", () => {
    expect(scanStudio().asChild).toEqual([
      "components/TopBar.tsx:149  <a",
      "components/TopBar.tsx:150  <a",
      "components/UserAccountMenu.tsx:145  <a",
    ])
  })

  // The scan is only worth its green if it would go red: each of these is a control it must find.
  it.each([
    ["a raw button", `<button type="button">Go</button>`],
    ["a raw input", `<input className="st-input" />`],
    ["a link dressed as a button", `<a href="/x" className="st-btn">Open</a>`],
    ["an icon-only link", `<a href="/docs" aria-label="Docs"><HelpIcon /></a>`],
    ["a router link styled by hand", `<Link to="/x" className="rounded-md border px-2">Go</Link>`],
    ["a router link styled by hand over several lines", `<Link\n  key="a"\n  to="/x"\n  className="rounded-md border"\n>\n  Go\n</Link>`],
  ])("finds %s", (_, source) => {
    expect(scan("fixture.tsx", source).raw).toHaveLength(1)
  })

  it("does not count an asChild menu link, a comment, or an element that only starts with a", () => {
    const source = [
      `<DropdownMenuItem asChild><a href="/x">X</a></DropdownMenuItem>`,
      `<DropdownMenuItem asChild>`,
      `  <a href="/y">Y</a>`,
      `</DropdownMenuItem>`,
      `{/* a <button> named in a comment */}`,
      `<aside><abbr title="x">x</abbr></aside>`,
      `<Link to="/settings">Project settings</Link>`,
      `<LinkButton className="x" />`,
    ].join("\n")
    expect(scan("fixture.tsx", source)).toEqual({ raw: [], asChild: ["fixture.tsx:1  <a", "fixture.tsx:3  <a"] })
  })
})
