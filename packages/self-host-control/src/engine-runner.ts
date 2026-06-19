import { spawn } from "node:child_process"
import { writeFile, unlink } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

function engineBin(): string {
  return process.env["SUPATYPE_ENGINE_BIN"] ?? "supatype-engine"
}

async function writeTempJson(data: unknown): Promise<string> {
  const path = join(tmpdir(), `supatype-engine-${randomUUID()}.json`)
  await writeFile(path, JSON.stringify(data), "utf-8")
  return path
}

async function deleteTempFile(path: string): Promise<void> {
  await unlink(path).catch(() => {})
}

function runEngine(subcommand: string, args: string[], opts?: { inputPath?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const mockScript = process.env["SUPATYPE_ENGINE_MOCK"]
    const bin = mockScript ? process.execPath : engineBin()
    const cmdArgs: string[] = mockScript ? [mockScript] : []
    if (opts?.inputPath) cmdArgs.push("--input", opts.inputPath)
    cmdArgs.push(subcommand, ...args)

    const proc = spawn(bin, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString() })
    proc.on("error", (err) => reject(new Error(`Failed to spawn engine: ${err.message}`)))
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Engine exit ${code}: ${stderr.trim()}`))
    })
  })
}

export interface DiffResult {
  operations: Array<{ kind: string; description: string; risk: string; sql?: string }>
  warnings: string[]
}

export async function runEngineDiff(databaseUrl: string, ast: unknown, schema = "public"): Promise<DiffResult> {
  const astPath = await writeTempJson(ast)
  try {
    const out = await runEngine("diff", [
      "--database-url", databaseUrl,
      "--schema", schema,
    ], { inputPath: astPath })
    return JSON.parse(out) as DiffResult
  } finally {
    await deleteTempFile(astPath)
  }
}

export async function runEnginePush(
  databaseUrl: string,
  ast: unknown,
  opts?: {
    force?: boolean
    schema?: string
    schemaSourcesGzBase64?: string
    schemaSourcesManifest?: unknown
  },
): Promise<unknown> {
  const astPath = await writeTempJson(ast)
  const tempFiles: string[] = [astPath]
  try {
    const args = [
      "--database-url", databaseUrl,
      "--schema", opts?.schema ?? "public",
      "--non-interactive",
    ]
    if (opts?.force) args.push("--force")
    if (opts?.schemaSourcesGzBase64) {
      const gzPath = join(tmpdir(), `supatype-sources-${randomUUID()}.gz`)
      writeFileSync(gzPath, Buffer.from(opts.schemaSourcesGzBase64, "base64"))
      tempFiles.push(gzPath)
      args.push("--schema-sources-gz", gzPath)
    }
    if (opts?.schemaSourcesManifest) {
      const manPath = join(tmpdir(), `supatype-manifest-${randomUUID()}.json`)
      writeFileSync(manPath, JSON.stringify(opts.schemaSourcesManifest))
      tempFiles.push(manPath)
      args.push("--schema-sources-manifest", manPath)
    }
    const out = await runEngine("push", args, { inputPath: astPath })
    try {
      return JSON.parse(out)
    } catch {
      return { message: out.trim() }
    }
  } finally {
    for (const f of tempFiles) await deleteTempFile(f)
  }
}

export async function runEngineRollback(
  databaseUrl: string,
  schema = "public",
): Promise<unknown> {
  const out = await runEngine("rollback", [
    "--database-url", databaseUrl,
    "--schema", schema,
  ])
  return JSON.parse(out)
}

export async function runEngineListMigrations(databaseUrl: string): Promise<unknown> {
  const out = await runEngine("migrations", ["--database-url", databaseUrl])
  return JSON.parse(out)
}

export async function runEngineMigrationSources(
  databaseUrl: string,
  name: string,
): Promise<unknown> {
  const out = await runEngine("migrations", [
    "--database-url", databaseUrl,
    "--name", name,
  ])
  return JSON.parse(out)
}

export async function runEngineDoctor(
  databaseUrl: string,
  ast: unknown,
  opts?: { noCache?: boolean; schema?: string },
): Promise<unknown> {
  const astPath = await writeTempJson(ast)
  try {
    const args = [
      "--database-url", databaseUrl,
      "--schema", opts?.schema ?? "public",
    ]
    const out = await runEngine("doctor", args, { inputPath: astPath })
    return JSON.parse(out)
  } finally {
    await deleteTempFile(astPath)
  }
}

export async function runEngineIntrospect(databaseUrl: string, schema = "public"): Promise<unknown> {
  const out = await runEngine("introspect", [
    "--database-url", databaseUrl,
    "--schema", schema,
  ])
  return JSON.parse(out)
}

export async function runEngineAdoptWithAst(
  databaseUrl: string,
  ast: unknown,
  opts?: { schema?: string; yes?: boolean; noCache?: boolean },
): Promise<unknown> {
  const astPath = await writeTempJson(ast)
  try {
    const args = [
      "--database-url", databaseUrl,
      "--schema", opts?.schema ?? "public",
    ]
    if (opts?.yes) args.push("--yes")
    if (opts?.noCache) args.push("--no-cache")
    const out = await runEngine("adopt", args, { inputPath: astPath })
    return JSON.parse(out)
  } finally {
    await deleteTempFile(astPath)
  }
}

export function databaseUrlFromEnv(): string {
  const url = process.env["DATABASE_URL"] ?? process.env["SUPATYPE_SQL_DATABASE_URL"]
  if (!url?.trim()) throw new Error("DATABASE_URL is not configured")
  return url.trim()
}
