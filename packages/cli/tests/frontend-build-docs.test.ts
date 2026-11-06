/**
 * The docs and the agent skill tell people to build with `supatype build` and to print a host's
 * values with `supatype keys --print frontend`. Every flag they write on either command has to be
 * one the CLI's `--help` lists, or a reader copies a command that fails with "unknown option".
 *
 * Spawns the compiled CLI, so `pnpm build` must have run first (turbo handles this).
 */
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(here, "../bin/supatype.js")
const repo = resolve(here, "..", "..", "..")

function help(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args, "--help"], { encoding: "utf8", timeout: 60_000 })
  if (result.signal) throw new Error(`\`supatype ${args.join(" ")} --help\` was killed by ${result.signal}`)
  expect(result.status, `supatype ${args.join(" ")} --help\n${result.stderr}`).toBe(0)
  return String(result.stdout)
}

/** Every Markdown file under `dir`. */
function markdownUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return markdownUnder(path)
    return /\.mdx?$/.test(entry) ? [path] : []
  })
}

const DOCS = [...markdownUnder(join(repo, "skills", "supatype")), ...markdownUnder(join(repo, "docs-content"))]

/**
 * The flags written after `invocation` anywhere in the docs, with the file each is in. An
 * invocation ends at a code span's end, a line's end, a comment, a table cell, the comma,
 * semicolon or closing parenthesis that ends a name in prose, or the `--` that hands the rest of
 * the line to the build command.
 */
function documentedFlags(invocation: string): { flag: string; file: string }[] {
  const pattern = new RegExp(`${invocation.replace(/ /g, " +")}((?:(?! -- )[^\`\\n#|,;)])*)`, "g")
  return DOCS.flatMap((file) => {
    const text = readFileSync(file, "utf8")
    return [...text.matchAll(pattern)].flatMap(([, rest = ""]) =>
      [...rest.matchAll(/--[a-z][a-z-]*/g)].map(([flag]) => ({ flag, file: relative(repo, file) })))
  })
}

describe("the frontend build commands the docs and skill document", () => {
  it("are documented in the skill and in the docs page", () => {
    const skill = ["SKILL.md", "references/cli.md", "references/frontend.md", "references/self-host.md"]
      .map((file) => readFileSync(join(repo, "skills", "supatype", file), "utf8"))
    for (const text of skill) expect(text).toContain("supatype build")
    expect(skill.join("\n")).toContain("supatype keys --print frontend")
    expect(readFileSync(join(repo, "skills", "supatype", "references", "config.md"), "utf8")).toContain("server.public_env")
    const page = readFileSync(join(repo, "docs-content", "deploying-your-frontend.md"), "utf8")
    for (const host of ["Vercel", "Netlify", "Cloudflare Pages", "GitHub Actions", "Your own server", "Supatype hosts it"]) {
      expect(page).toContain(host)
    }
  })

  it("write only flags `supatype build --help` lists", () => {
    const text = help(["build"])
    const flags = documentedFlags("supatype build")
    expect(flags.map(({ flag }) => flag)).toEqual(expect.arrayContaining(["--env", "--allow-local"]))
    for (const { flag, file } of flags) expect(text, `${flag} in ${file}`).toContain(flag)
    expect(text).toContain("[command...]")
  })

  it("write only flags `supatype keys --help` lists for --print frontend", () => {
    const text = help(["keys"])
    const flags = documentedFlags("supatype keys --print frontend")
    expect(flags.map(({ flag }) => flag)).toContain("--env")
    for (const { flag, file } of flags) expect(text, `${flag} in ${file}`).toContain(flag)
    expect(text).toContain("--print [target]")
  })

  it("document deploy's --allow-local, which deploy --help lists", () => {
    expect(help(["deploy"])).toContain("--allow-local")
  })
})
