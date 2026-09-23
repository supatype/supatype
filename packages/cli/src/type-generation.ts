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
import { dirname, resolve } from "node:path"
import { generateClientAugmentation } from "./augmentation-generator.js"
import { ensureEngine, engineRequest } from "./engine-client.js"

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

  // Generated locally from the AST, so it needs no engine round trip.
  if (req.clientPath !== undefined && req.clientPath !== "") {
    const outPath = resolve(req.cwd, req.clientPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, generateClientAugmentation(req.ast), "utf8")
    written.push(`Client augmentation written to ${req.clientPath}`)
  }

  return written
}
