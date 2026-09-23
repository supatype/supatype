/**
 * Check that every name in `functions.serviceRole` is a function that exists.
 *
 * The grant fails **closed**: a typo, or a function that has since been renamed, means that function
 * quietly does not receive the service-role key. Nothing breaks loudly, the handler simply reads
 * `undefined` and whatever it does with the key stops working, at runtime, in a deploy that reported
 * success. So the name is checked where it is declared, against the directory it must match.
 *
 * `serviceRoleRoutes()` claimed this was already true. It was not: nothing read the list except the two
 * places that turn it into an env var.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import {
  functionsPathCandidatesFromProject,
  serviceRoleRoutes,
  type SupatypeProjectConfig,
} from "./project-config.js"

export interface ServiceRoleProblems {
  /** Names with no matching function. Each line is ready to print. */
  errors: string[]
  /** The same names, unformatted, for callers that need to mark them rather than print them. */
  missing: string[]
  /** Entries that are harmless but say nothing, e.g. a hook. */
  warnings: string[]
  /** Function names available to be granted, for the "did you mean" line. */
  available: string[]
}

/** Function directory names, matching how the worker discovers routes. */
function availableFunctions(dirs: readonly string[]): string[] {
  const names = new Set<string>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith("_") || entry.startsWith(".")) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (existsSync(join(full, "index.ts"))) names.add(entry)
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        names.add(entry.replace(/\.ts$/, ""))
      }
    }
  }
  return [...names].sort()
}

/**
 * Resolve the declared grants against what is on disk.
 *
 * Returns the problems rather than throwing, so `push` can refuse while `doctor` reports alongside
 * everything else it found.
 */
export function checkServiceRoleRoutes(
  cfg: SupatypeProjectConfig,
  cwd: string,
): ServiceRoleProblems {
  const declared = serviceRoleRoutes(cfg)
  if (declared.length === 0) return { errors: [], missing: [], warnings: [], available: [] }

  const dirs = functionsPathCandidatesFromProject(cfg, cwd)
  const available = availableFunctions(dirs)
  const known = new Set(available)
  // Forward slashes and the candidates listed separately: joining them into one path produced
  // "no functions or supatype\functions/send-email/index.ts", which reads as neither a path nor a list.
  const searched = dirs.map((dir) => (relative(cwd, dir) || dir).replace(/\\/g, "/"))
  const primary = searched[0] ?? "functions"

  const errors: string[] = []
  const missing: string[] = []
  const warnings: string[] = []

  for (const name of declared) {
    if (name.startsWith("hooks/")) {
      // Not an error: it was the documented form once, and the worker grants hooks whatever this says.
      // Still worth saying, because a reader would reasonably assume the line is what does the granting.
      warnings.push(
        `  "${name}" is not needed, a hook receives the service-role key because only the API server ` +
          `can reach it`,
      )
      continue
    }
    if (!known.has(name)) {
      const where =
        searched.length > 1 ? ` (searched ${searched.join(", ")})` : ""
      errors.push(`  "${name}": no ${primary}/${name}/index.ts${where}`)
      missing.push(name)
    }
  }

  return { errors, missing, warnings, available }
}

/** The full message for a refusal, including what *is* available to name. */
export function serviceRoleProblemLines(problems: ServiceRoleProblems): string[] {
  if (problems.errors.length === 0) return []
  const lines = [...problems.errors, ""]
  lines.push(
    problems.available.length > 0
      ? `Functions found: ${problems.available.join(", ")}`
      : "No functions found. Create one with: supatype functions new <name>",
  )
  lines.push("")
  lines.push(
    "A name that matches nothing grants nothing, and says so nowhere: the function reads no key at " +
      "runtime, in a deploy that reported success.",
  )
  return lines
}
