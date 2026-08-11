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

/**
 * Parse a project `.env` into key/value pairs.
 *
 * Deliberately small: `KEY=value`, `#` comments, one optional layer of surrounding quotes. No
 * interpolation and no `export` handling, because Compose's own parser does not do those either and
 * a `.env` that means two different things depending on who reads it is worse than a limited one.
 */
export function readEnvFile(cwd: string): Record<string, string> {
  const envPath = join(cwd, ".env")
  if (!existsSync(envPath)) return {}

  const out: Record<string, string> = {}
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

export function readEnvValue(cwd: string, key: string, fallback: string): string {
  const envPath = join(cwd, ".env")
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"))
    if (m?.[1]) return m[1].trim()
  }
  return fallback
}

/** Whether `.env` carries a non-empty value for `key`. Distinguishes absent from defaulted. */
export function hasEnvValue(cwd: string, key: string): boolean {
  const envPath = join(cwd, ".env")
  if (!existsSync(envPath)) return false
  return new RegExp(`^${key}=(.+)$`, "m").test(readFileSync(envPath, "utf8"))
}

export function readEnvInt(cwd: string, key: string): number | null {
  const raw = readEnvValue(cwd, key, "")
  if (!raw) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}
