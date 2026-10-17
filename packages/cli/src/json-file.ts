/**
 * JSON files the CLI reads but does not own the shape of at runtime: `package.json`, the manifest the
 * server reads, the link and lock files a previous run wrote. Each is checked as it is read.
 */

import { readFileSync } from "node:fs"
import { parseJsonObject, type Guard } from "@supatype/shared"

/** The JSON object in the file, or undefined when it cannot be read, is not JSON, or is not an object. */
export function readJsonObjectFile(path: string): Record<string, unknown> | undefined {
  try {
    const read = parseJsonObject(readFileSync(path, "utf8"))
    return read.ok ? read.value : undefined
  } catch {
    return undefined
  }
}

/** The file's JSON when `guard` accepts it, or undefined when it cannot be read, is not JSON, or is refused. */
export function readJsonFile<T>(path: string, guard: Guard<T>): T | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  return guard(value) ? value : undefined
}

/**
 * The file's JSON, which `guard` must accept. Throws when the file is not JSON, as `JSON.parse`
 * does, and when `guard` refuses it, naming the file and what it should have held.
 */
export function readJsonFileOrThrow<T>(path: string, guard: Guard<T>, what: string): T {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!guard(value)) throw new Error(`${path} does not hold ${what} this CLI can read`)
  return value
}
