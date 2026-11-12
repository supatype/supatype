/**
 * The gateway and anon key the smoke runs against. Its own module so a test can check where they
 * come from without starting the smoke.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface SmokeTarget {
  gateway: string
  anonKey: string
}

/** A `.env`-style file as names and values, or nothing when it is absent. */
function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** The first of `values` that holds something other than blanks. */
function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value) => value !== undefined && value !== "")
}

/**
 * The environment's `SUPATYPE_URL` / `SUPATYPE_ANON_KEY`, then the files the way `expo start`
 * reads them: `.env.development.local`, where `supatype keys` and `dev` write the local stack's
 * values, before `.env`. A blank counts as unset (0.9.1 release test, FF43: a template's blank
 * `EXPO_PUBLIC_SUPATYPE_ANON_KEY=` won over `ANON_KEY` and the smoke said the key was missing).
 */
export function smokeTarget(exampleRoot: string, env: NodeJS.ProcessEnv = process.env): SmokeTarget {
  const dev = loadDotEnv(resolve(exampleRoot, ".env.development.local"))
  const base = loadDotEnv(resolve(exampleRoot, ".env"))
  const fromFiles = (name: string) => firstSet(dev[name], base[name])
  return {
    gateway:
      firstSet(env["SUPATYPE_URL"], fromFiles("EXPO_PUBLIC_SUPATYPE_URL"), fromFiles("PUBLIC_SUPATYPE_URL")) ?? "http://localhost:18473",
    anonKey: firstSet(env["SUPATYPE_ANON_KEY"], fromFiles("EXPO_PUBLIC_SUPATYPE_ANON_KEY"), base["ANON_KEY"]) ?? "",
  }
}
