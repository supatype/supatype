/**
 * A `package.json` the CLI reads: the project's, a plugin's, a dependency's. Each field is read with
 * a check, and one of the wrong type reads as absent, so a hand-edited file degrades field by field
 * instead of throwing a TypeError at whoever reads it next.
 */

import { isJsonObject, isString } from "@supatype/shared"

export interface PackageJson {
  name?: string
  version?: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  scripts: Record<string, string>
  keywords: string[]
  /** `bin`: one path, or paths by command name. */
  bin?: string | Record<string, string>
  /** The whole object, for a field read only in one place (`supatype`, say). */
  raw: Record<string, unknown>
}

/** The string-valued entries of `value` when it is an object; an empty record otherwise. */
function stringRecord(value: unknown): Record<string, string> {
  if (!isJsonObject(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1])))
}

/** `package.json` text read field by field. Throws when the text is not JSON, as `JSON.parse` does. */
export function parsePackageJson(text: string): PackageJson {
  const parsed = JSON.parse(text)
  const raw = isJsonObject(parsed) ? parsed : {}
  const { name, version, bin, keywords } = raw
  return {
    ...(isString(name) && { name }),
    ...(isString(version) && { version }),
    dependencies: stringRecord(raw["dependencies"]),
    devDependencies: stringRecord(raw["devDependencies"]),
    scripts: stringRecord(raw["scripts"]),
    keywords: Array.isArray(keywords) ? keywords.filter(isString) : [],
    ...(isString(bin) ? { bin } : isJsonObject(bin) && { bin: stringRecord(bin) }),
    raw,
  }
}
