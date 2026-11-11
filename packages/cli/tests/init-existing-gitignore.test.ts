/**
 * 0.9.2 release test (N-RB1): `supatype init` in an existing create-vite or create-expo-app app
 * added only `.supatype/` (and sometimes `.env.*.local`) to the app's own `.gitignore`, so `.env`,
 * which holds POSTGRES_PASSWORD, JWT_SECRET and SERVICE_ROLE_KEY, was one `git add .` from a public
 * repository. `link --fix-gitignore` did the same in reverse: a file that already named `.supatype/`
 * got nothing, `.env` included.
 *
 * Asserted with `git check-ignore` in a real repository, since the question is what git does, and
 * with the `.gitignore` each generator writes, since what they already cover is what the merge has
 * to judge.
 */

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { Command } from "commander"
import { registerLinkOptions } from "../src/commands/link-helpers.js"
import {
  ensureSupatypeGitignore,
  missingSupatypeIgnores,
  SUPATYPE_GITIGNORE_PATHS,
  warnIfLinkNotGitignored,
} from "../src/gitignore.js"

/** create-vite's `.gitignore` (Vue, Svelte, Solid and React templates alike). */
const CREATE_VITE = `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`

/** create-expo-app's `.gitignore` (SDK 58 default template). */
const CREATE_EXPO_APP = `# Learn more https://docs.github.com/en/get-started/getting-started-with-git/ignoring-files

# dependencies
node_modules/

# Expo
.expo/
dist/
web-build/
expo-env.d.ts

# Native
.kotlin/
*.orig.*
*.jks
*.p8
*.p12
*.key
*.mobileprovision

# Metro
.metro-health-check*

# debug
npm-debug.*
yarn-debug.*
yarn-error.*

# macOS
.DS_Store
*.pem

# local env files
.env*.local

# typescript
*.tsbuildinfo

# generated native folders
/ios
/android
`

/** create-next-app's env line, which already covers every env file. */
const CREATE_NEXT_APP = `/node_modules
/.next/
# env files (can opt-in for committing if needed)
.env*
`

/** Every file Supatype writes that must stay out of git. */
const SECRET_FILES = [
  ".env",
  ".env.local",
  ".env.development.local",
  "functions/.env.local",
  "functions/.env.checkout.local",
  ".supatype/link.json",
  "supatype.local.config.ts",
  "supatype/generated/seed.ts",
]

/** Files that belong in the repository, which a careless pattern would swallow. */
const SOURCE_FILES = ["supatype.config.ts", "schema/index.ts", "seed.ts", "src/env.local.ts", "supatype/generated/index.d.ts"]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b-init-gitignore-"))
  execFileSync("git", ["init", "-q", "."], { cwd: dir })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** What git itself says about `rel`, after creating it. */
function ignored(rel: string): boolean {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, "x", "utf8")
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: dir })
    return true
  } catch {
    return false
  }
}

/** Everything printed so far, through console.log and console.warn. */
function printed(): string {
  const calls = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls]
  return calls.map((args) => args.map(String).join(" ")).join("\n")
}

/** The lines init appended below the app's own `.gitignore`. */
function appendedLines(original: string): string[] {
  const now = readFileSync(join(dir, ".gitignore"), "utf8")
  expect(now.startsWith(original)).toBe(true)
  return now.slice(original.length).split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))
}

function initInto(existingGitignore: string): void {
  writeFileSync(join(dir, ".gitignore"), existingGitignore, "utf8")
  scaffold(dir, defaultScaffoldOptions("b-init-app"))
}

function expectSecretsIgnoredAndSourcesNot(): void {
  for (const rel of SECRET_FILES) expect({ rel, ignored: ignored(rel) }).toEqual({ rel, ignored: true })
  for (const rel of SOURCE_FILES) expect({ rel, ignored: ignored(rel) }).toEqual({ rel, ignored: false })
}

describe("init in an existing app's repository", () => {
  it("ignores .env and every other secret in a create-vite app", () => {
    initInto(CREATE_VITE)
    expectSecretsIgnoredAndSourcesNot()
    // `*.local` already covers both local env patterns, so they are not written again.
    expect(appendedLines(CREATE_VITE)).not.toContain(".env.local")
    expect(appendedLines(CREATE_VITE)).not.toContain(".env.*.local")
  })

  it("ignores .env and every other secret in a create-expo-app app", () => {
    initInto(CREATE_EXPO_APP)
    expectSecretsIgnoredAndSourcesNot()
    // `.env*.local` already covers them.
    expect(appendedLines(CREATE_EXPO_APP)).not.toContain(".env.local")
    expect(appendedLines(CREATE_EXPO_APP)).not.toContain(".env.*.local")
  })

  it("adds no env line to a create-next-app file, whose `.env*` covers them all", () => {
    initInto(CREATE_NEXT_APP)
    expectSecretsIgnoredAndSourcesNot()
    expect(appendedLines(CREATE_NEXT_APP).filter((line) => line.startsWith(".env"))).toEqual([])
  })

  it("leaves a file that already covers everything as it was", () => {
    const complete = `${CREATE_NEXT_APP}.supatype\nsupatype.local.config.*\nsupatype/generated/seed.ts\n`
    initInto(complete)
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(complete)
  })

  it("adds .env again after a later line that un-ignores it", () => {
    initInto(`.env\n!.env\n`)
    expect(ignored(".env")).toBe(true)
  })

  // 0.9.2 release test round 2 (R2-S6): init overrode a deliberate `!.env` and printed only
  // "updated .gitignore (added Supatype's local files)".
  it("says so when it overrides a line that un-ignores .env", () => {
    initInto(`node_modules\n!.env\n`)
    expect(printed()).toContain(`Your .gitignore un-ignores .env with a "!" line`)
  })

  it("says nothing about an override when no line un-ignores a Supatype path", () => {
    initInto(CREATE_VITE)
    expect(printed()).not.toContain("un-ignores")
  })
})

describe("link --fix-gitignore", () => {
  it("adds .env to a file that already ignores .supatype/", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.supatype/\n", "utf8")
    ensureSupatypeGitignore(dir, { silent: true })
    expectSecretsIgnoredAndSourcesNot()
  })

  it("says so when it overrides a line that un-ignores .env", () => {
    writeFileSync(join(dir, ".gitignore"), ".supatype/\n!.env\n", "utf8")
    ensureSupatypeGitignore(dir)
    expect(ignored(".env")).toBe(true)
    expect(printed()).toContain(`Your .gitignore un-ignores .env with a "!" line`)
  })

  // 0.9.2 release test round 2 (R2-S7): `link` without the flag checked only `.supatype/`, so a
  // `.gitignore` that ignored it but not `.env` got no warning.
  it("without the flag, warns in one line naming the flag when .env is not ignored", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.next/\n.supatype/\n", "utf8")
    warnIfLinkNotGitignored(dir)
    const warned = vi.mocked(console.warn).mock.calls.map((args) => args.map(String).join(" "))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain(".env,")
    expect(warned[0]).toContain("supatype link --fix-gitignore")
  })

  it("without the flag, says nothing when every path is ignored", () => {
    ensureSupatypeGitignore(dir, { silent: true })
    warnIfLinkNotGitignored(dir)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it("--help says the flag adds every Supatype path", () => {
    const cmd = new Command("link")
    registerLinkOptions(cmd)
    expect(cmd.helpInformation()).toMatch(/--fix-gitignore\s+Add \.env, \.supatype\/ and Supatype's other/)
  })

  it("does not count a commented-out line as ignoring .supatype/", () => {
    writeFileSync(join(dir, ".gitignore"), "# .supatype/\n", "utf8")
    ensureSupatypeGitignore(dir, { silent: true })
    expect(ignored(".supatype/link.json")).toBe(true)
  })
})

describe("coverage, judged as git judges it", () => {
  // Each a .gitignore some project has, and for each of Supatype's paths, what the merge decides is
  // compared with what git says about a file at that path, at the top and one folder down.
  const variants = [
    CREATE_VITE,
    CREATE_EXPO_APP,
    CREATE_NEXT_APP,
    "/.env\n/.supatype\n",
    ".env*\n!.env.example\n*.local\n",
    "**/.env\nsupatype/\n!supatype/generated/\n",
    ".supatype/*\n!.supatype/keep\n",
    "\\#not-a-comment\n.env.[dl]*\n",
    ".env\n*.local\n!.env.local\n!.env\n",
    // A `]` first in a class is a member, not its end: `[]v]` is `]` or `v`.
    ".en[]v]\n",
    // An escape inside a class quotes the next character: `[\]l]` is `]` or `l`.
    ".env.[\\]l]ocal\n",
  ]

  it.each(variants)("agrees with git check-ignore for %j", (content) => {
    writeFileSync(join(dir, ".gitignore"), content, "utf8")
    const missing = missingSupatypeIgnores(content)
    for (const entry of SUPATYPE_GITIGNORE_PATHS) {
      const rel = entry.replace(/\/$/, "/link.json").replace(/\*/g, "checkout")
      const gitSays = ignored(rel) && (entry.includes("/") && !entry.endsWith("/") ? true : ignored(`sub/${rel}`))
      expect({ entry, covered: !missing.includes(entry) }).toEqual({ entry, covered: gitSays })
    }
  })
})
