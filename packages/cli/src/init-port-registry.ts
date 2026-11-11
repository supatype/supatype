/**
 * The Kong port init gave each project, so the next init does not give it again.
 *
 * FF26 remainder (0.9.2 release test, pm): two `init -y` runs before either project started both got
 * 18475. Init skips the ports Docker knows of (reservedComposePorts), and a project nobody has
 * started has no containers yet. So init records the port it gives each project folder in
 * `~/.supatype/init-ports.json`. A record counts only while its folder exists and that folder's
 * `.env` still names the port: a deleted project, or one moved to another port by hand, frees it
 * without anyone cleaning up.
 *
 * Round 2 (pm N1): the record lived in `~/.supatype/projects/<name>/`, one per project name, so a
 * second folder whose project had the same name replaced the first folder's, and the next init was
 * offered the first project's port again. One file, keyed by folder, has no names to collide.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isArrayOf, isNumber, isShape, isString, parseJsonObject } from "@supatype/shared"
import { readEnvInt } from "./env-file.js"
import { supatypeProjectsRoot } from "./project-config.js"

const KONG_PORT_ENV = "SUPATYPE_KONG_PORT"

interface InitPortsRecord {
  kongPort: number
  projectDir: string
}

const isInitPortsFile = isShape({ projects: isArrayOf(isShape({ kongPort: isNumber, projectDir: isString })) })

/** `~/.supatype/init-ports.json`. Read at each call, so a test's own home is used. */
function recordsPath(): string {
  return join(dirname(supatypeProjectsRoot()), "init-ports.json")
}

/** The records whose project still exists and whose `.env` still names the port. */
function liveRecords(): InitPortsRecord[] {
  try {
    const path = recordsPath()
    if (!existsSync(path)) return []
    const parsed = parseJsonObject(readFileSync(path, "utf8"))
    if (!parsed.ok || !isInitPortsFile(parsed.value)) return []
    return parsed.value.projects.filter((r) => existsSync(r.projectDir) && readEnvInt(r.projectDir, KONG_PORT_ENV) === r.kongPort)
  } catch {
    // An unreadable file reserves nothing: the next init may offer a port again, as before.
    return []
  }
}

/** Record that init gave `projectDir` `kongPort`. Best effort: a failure only loses the hint. */
export function recordInitKongPort(projectDir: string, kongPort: number): void {
  try {
    const projects = [...liveRecords().filter((r) => r.projectDir !== projectDir), { kongPort, projectDir }]
    mkdirSync(dirname(recordsPath()), { recursive: true })
    writeFileSync(recordsPath(), `${JSON.stringify({ projects }, null, 2)}\n`, "utf8")
  } catch {
    // The home folder is not writable: the next init may offer this port again, as before.
  }
}

/** Every Kong port init gave a project that still exists and still uses it. */
export function registeredInitKongPorts(): Set<number> {
  return new Set(liveRecords().map((r) => r.kongPort))
}
