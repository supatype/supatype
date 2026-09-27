/**
 * Write a project's generated types to disk.
 *
 * `push` used to send `types_path` and `client_path` to the engine and read only `message`,
 * expecting the engine to write the files. It does not write them, so with `output.types`
 * configured the generated TypeScript was printed to the terminal and nothing reached disk:
 * `supatype push` claims to generate types and produced none. `supatype generate` had it right
 * all along, and this is that logic, shared, so the two cannot disagree again.
 *
 * Each path is optional and an absent one is skipped, because the two callers differ on purpose:
 * `generate` falls back to defaults and always writes, while `push` writes only what the project
 * asked for and must not start creating files in projects that never configured any.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { generateClientAugmentation } from "./augmentation-generator.js"
import { ensureEngine, engineRequest } from "./engine-client.js"
import { generateProjectClient } from "./client-generator.js"

/** The client a project imports, beside the generated types. */
const PROJECT_CLIENT_FILENAME = "client.ts"

export interface GenerateTypesRequest {
  cwd: string
  ast: unknown
  /** Relative path for the database types, from `output.types`. */
  typesPath?: string | undefined
  /** Relative path for the client augmentation, from `output.client`. */
  clientPath?: string | undefined
}

/** Writes what was asked for and returns one message per file, for the caller to report. */
export async function writeGeneratedTypes(req: GenerateTypesRequest): Promise<string[]> {
  const written: string[] = []

  if (req.typesPath !== undefined && req.typesPath !== "") {
    await ensureEngine()
    const result = await engineRequest<{ code?: string; message?: string }>(
      "/generate",
      { ast: req.ast, lang: "typescript" },
    )
    // `code` is the field the engine fills; `message` is the older shape. Reading only `message`
    // and printing it is how the generated file ended up in the terminal.
    const code = result.code ?? result.message
    if (code === undefined) {
      throw new Error("Engine returned no output for type generation.")
    }
    const outPath = resolve(req.cwd, req.typesPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, code, "utf8")
    written.push(`Types written to ${req.typesPath}`)
  }

  written.push(...writeAstDerivedOutputs(req))

  return written
}

/**
 * The generated files that come from the AST alone, with no engine round trip.
 *
 * Shared because three commands need them and only one was writing them. `push` and `generate`
 * call {@link writeGeneratedTypes}; `dev` has its own type generation, for good reasons it should
 * keep, and so never wrote these at all. The result was a project developed entirely through
 * `supatype dev` that never received `index.d.ts`, so the module augmentation that makes
 * `createClient` typed without a generic never happened, and never received the generated client,
 * so every exact-value column fell back to asking the API.
 *
 * Kept separate from the types branch above rather than folding `dev` into it: that branch slices
 * the engine's output from a marker and treats a failure as fatal, and `dev` must do neither.
 */
export function writeAstDerivedOutputs(req: GenerateTypesRequest): string[] {
  const written: string[] = []

  if (req.clientPath !== undefined && req.clientPath !== "") {
    const outPath = resolve(req.cwd, req.clientPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, generateClientAugmentation(req.ast), "utf8")
    written.push(`Client augmentation written to ${req.clientPath}`)
  }

  // The client the project imports. One file carrying the augmentation, the exact-value columns
  // and a re-export of `createClient`, so an app writes a single import and tsconfig cannot lose
  // any of it. See `client-generator.ts` for what each part replaced.
  // Beside `output.client` when set, otherwise beside `output.types`. A project that configured
  // only types still gets a usable client: this one file carries the augmentation and the exact
  // columns as well as `createClient`, so without it the project has types and no way to use them
  // that knows anything about its schema.
  const clientDir = req.clientPath ?? req.typesPath
  if (clientDir !== undefined && clientDir !== "") {
    const relative = join(dirname(clientDir), PROJECT_CLIENT_FILENAME)
    const outPath = resolve(req.cwd, relative)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, generateProjectClient(req.ast), "utf8")
    written.push(`Client written to ${toPosix(relative)}`)
  }

  return written
}

/** Reported with forward slashes, so the message reads the same on every platform. */
function toPosix(path: string): string {
  return path.split(sep).join("/")
}
