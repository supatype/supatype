import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { projectRootFromConfig, type SupatypeProjectConfig } from "./project-config.js"

function upsertEnvVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m")
  if (re.test(content)) return content.replace(re, `${key}=${value}`)
  const sep = content.endsWith("\n") || content.length === 0 ? "" : "\n"
  return `${content}${sep}${key}=${value}\n`
}

/** Write VITE_SUPATYPE_* keys for the app dev server (P2 DX). */
export function writeAppViteEnv(
  cwd: string,
  config: SupatypeProjectConfig,
  apiUrl: string,
  anonKey: string,
): void {
  const appDir = projectRootFromConfig(config, cwd)
  if (!existsSync(join(appDir, "package.json"))) return

  const envPath = resolve(appDir, ".env.local")
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  content = upsertEnvVar(content, "VITE_SUPATYPE_URL", apiUrl)
  content = upsertEnvVar(content, "VITE_SUPATYPE_ANON_KEY", anonKey)
  writeFileSync(envPath, content, "utf8")
}
