/**
 * One run's project name, over the one in supatype.config.ts.
 *
 * Two runs of one project from two checkouts (the live test scripts, side by side) need two compose
 * projects, and the compose project is named after `project.name`. Renaming the project in a file
 * meant a generated supatype.local.config.ts, which a killed run left behind, and the name it
 * carried was then recorded as the project's own, so the next run warned of a rename.
 *
 * `SUPATYPE_PROJECT_NAME`, or `--project-name` on any command, renames the project for the run and
 * writes nothing. Everything that names the compose project, the database or the state directory
 * reads `config.project.name` and so follows it. State that outlives the run records
 * `projectNameInFile(config)` instead.
 */

import type { Command } from "commander"
import type { SupatypeProjectConfig } from "./project-config.js"

export const PROJECT_NAME_ENV = "SUPATYPE_PROJECT_NAME"

// Compose's own rule for a project name. Anything else it would rewrite, and the stack would then
// run under a name nothing here looks for.
const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/

const namesInFile = new WeakMap<SupatypeProjectConfig, string>()

/** The run's project name, when one is set. Throws on a name compose would not keep as written. */
export function projectNameOverride(): string | undefined {
  const name = process.env[PROJECT_NAME_ENV]?.trim()
  if (!name) return undefined
  if (!VALID_NAME.test(name)) {
    throw new Error(
      `${PROJECT_NAME_ENV}="${name}" is not a project name compose keeps as written: ` +
        "use lower case letters, digits, - and _, starting with a letter or digit.",
    )
  }
  return name
}

/** The config with the run's project name applied, when one is set. */
export function applyProjectNameOverride(config: SupatypeProjectConfig): SupatypeProjectConfig {
  const name = projectNameOverride()
  if (name === undefined || name === config.project.name) return config
  const renamed: SupatypeProjectConfig = { ...config, project: { ...config.project, name } }
  namesInFile.set(renamed, config.project.name)
  return renamed
}

/** The name in the config files, whatever this run is called. For state that outlives the run. */
export function projectNameInFile(config: SupatypeProjectConfig): string {
  return namesInFile.get(config) ?? config.project.name
}

/** `--project-name <name>` on every command: the same as SUPATYPE_PROJECT_NAME, for this run. */
export function registerProjectNameOption(program: Command): void {
  program.option(
    "--project-name <name>",
    `name the project for this run, over supatype.config.ts (also ${PROJECT_NAME_ENV})`,
  )
  program.hook("preAction", (root) => {
    const name: unknown = root.opts()["projectName"]
    if (typeof name === "string") process.env[PROJECT_NAME_ENV] = name
  })
}
