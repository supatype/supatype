import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Merge key/value updates into a project `.env` without dropping unrelated lines. */
export function upsertEnvFile(
  cwd: string,
  updates: Record<string, string>,
  removeKeys: readonly string[] = [],
): void {
  const envPath = join(cwd, ".env")
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const keys = new Set([...Object.keys(updates), ...removeKeys])
  const kept = existing
    .split("\n")
    .filter((line) => {
      const key = line.split("=")[0]?.trim()
      return key && line.includes("=") && !keys.has(key)
    })
  const merged = [...kept, ...Object.entries(updates).map(([key, value]) => `${key}=${value}`)]
  writeFileSync(envPath, `${merged.join("\n").trimEnd()}\n`, "utf8")
}

export function readEnvValue(cwd: string, key: string, fallback: string): string {
  const envPath = join(cwd, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"))
    if (m?.[1]) return m[1].trim()
  }
  return fallback
}

export function readEnvInt(cwd: string, key: string): number | null {
  const raw = readEnvValue(cwd, key, "")
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}
