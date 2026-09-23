import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

const TEMPLATE_REL = join("config", "api-config.json")
const TARGET_REL = join(".supatype", "api-config.json")

/** Copy committed `config/api-config.json` when `.supatype/api-config.json` is missing. */
export function ensureDevApiConfig(cwd: string): boolean {
  const target = join(cwd, TARGET_REL)
  if (existsSync(target)) return false

  const template = join(cwd, TEMPLATE_REL)
  if (!existsSync(template)) return false

  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(template, target)
  return true
}
