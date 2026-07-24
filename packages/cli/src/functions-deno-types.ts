/**
 * Scaffold Deno IDE types for edge functions so tsserver / Cursor stop
 * reporting "Cannot find name 'Deno'" under the project root tsconfig.
 *
 * We ship a curated ambient declaration (not `@types/deno` at the app root):
 * installing `@types/deno` as a project dependency auto-includes it in the
 * whole app when root `tsconfig` omits `"types"`, which pollutes React/Next.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const MARKER = "Supatype edge functions (IDE / tsserver)"

/** Ambient Deno types written into `functions/deno.d.ts`. */
export function functionsDenoAmbientSource(): string {
  return `/**
 * ${MARKER}.
 * Runtime is Deno; this file covers APIs edge functions commonly use.
 * Do not add \`@types/deno\` to the app package.json — it leaks into the
 * whole project when root tsconfig has no \`"types"\` field.
 *
 * Optional: for the full Deno API, install the Deno VS Code/Cursor extension
 * and open \`functions/\` as a Deno-enabled workspace folder.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

interface DenoEnv {
  /** Returns the value of the environment variable, or \`undefined\` if unset. */
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  has(key: string): boolean
  toObject(): { [key: string]: string }
}

declare namespace Deno {
  const env: DenoEnv

  namespace errors {
    class NotFound extends Error {}
    class PermissionDenied extends Error {}
  }

  interface DirEntry {
    name: string
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
  }

  interface FileInfo {
    isFile: boolean
    isDirectory: boolean
    isSymlink: boolean
    size: number
    mtime: Date | null
  }

  function readDir(path: string): AsyncIterable<DirEntry>
  function readTextFile(path: string): Promise<string>
  function stat(path: string): Promise<FileInfo>

  function serve(
    options: { port: number; hostname?: string; onListen?: (params: { hostname: string; port: number }) => void },
    handler: (req: Request) => Response | Promise<Response>,
  ): void
}
`
}

/** `functions/tsconfig.json` — owns function files so the app config can exclude them. */
export function functionsTsConfigSource(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": []
  },
  "include": ["./**/*.ts", "./deno.d.ts"]
}
`
}

export type FunctionsDenoTypesResult = {
  wroteDenoDts: boolean
  wroteTsconfig: boolean
  rootExclude: "updated" | "already" | "missing" | "manual"
  hints: string[]
}

/**
 * Ensure `functions/deno.d.ts` + `functions/tsconfig.json` exist, and try to
 * exclude `functions` from the project-root `tsconfig.json`.
 */
export function ensureFunctionsDenoTypes(
  projectRoot: string,
  functionsDir: string,
): FunctionsDenoTypesResult {
  mkdirSync(functionsDir, { recursive: true })

  const denoDtsPath = join(functionsDir, "deno.d.ts")
  const tsconfigPath = join(functionsDir, "tsconfig.json")

  let wroteDenoDts = false
  if (!existsSync(denoDtsPath)) {
    writeFileSync(denoDtsPath, functionsDenoAmbientSource(), "utf8")
    wroteDenoDts = true
  }

  let wroteTsconfig = false
  if (!existsSync(tsconfigPath)) {
    writeFileSync(tsconfigPath, functionsTsConfigSource(), "utf8")
    wroteTsconfig = true
  }

  const rootExclude = ensureRootTsconfigExcludesFunctions(projectRoot)
  const hints: string[] = []
  const fnRel = toPosix(relative(projectRoot, functionsDir)) || "functions"

  if (rootExclude === "manual") {
    hints.push(
      `Add "functions" to the root tsconfig.json "exclude" array so the app checker skips ${fnRel}/.`,
    )
  } else if (rootExclude === "missing") {
    hints.push(
      `If you add a root tsconfig.json, exclude "${fnRel}" (or "functions") so app typecheck stays separate.`,
    )
  }

  return { wroteDenoDts, wroteTsconfig, rootExclude, hints }
}

function ensureRootTsconfigExcludesFunctions(
  projectRoot: string,
): FunctionsDenoTypesResult["rootExclude"] {
  const path = join(projectRoot, "tsconfig.json")
  if (!existsSync(path)) return "missing"

  const raw = readFileSync(path, "utf8")
  const parsed = ts.parseConfigFileTextToJson(path, raw)
  if (parsed.error || parsed.config === undefined || typeof parsed.config !== "object") {
    return "manual"
  }

  const cfg = parsed.config as { exclude?: unknown }
  const exclude = Array.isArray(cfg.exclude) ? cfg.exclude.map(String) : []
  if (exclude.some(isFunctionsExcludeEntry)) return "already"

  try {
    const asJson = JSON.parse(raw) as { exclude?: string[] }
    asJson.exclude = [...(Array.isArray(asJson.exclude) ? asJson.exclude : []), "functions"]
    writeFileSync(path, `${JSON.stringify(asJson, null, 2)}\n`, "utf8")
    return "updated"
  } catch {
    // JSONC / trailing commas — try a conservative string splice into an existing exclude array.
    if (/"exclude"\s*:\s*\[/.test(raw)) {
      const next = raw.replace(/("exclude"\s*:\s*\[)/, `$1\n    "functions",`)
      if (next !== raw) {
        writeFileSync(path, next, "utf8")
        return "updated"
      }
    }
    return "manual"
  }
}

function isFunctionsExcludeEntry(entry: string): boolean {
  const n = entry.replace(/\\/g, "/").replace(/^\.\//, "")
  return n === "functions" || n === "functions/**" || n.startsWith("functions/")
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/")
}
