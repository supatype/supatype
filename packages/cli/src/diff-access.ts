import type { DiffResult, RoleAccess } from "./engine-client.js"

/**
 * What each API role may do on each model's table, as `diff` prints it (issue 16).
 *
 * `anon` is granted a privilege only where the engine can prove its rule needs no login, so a rule
 * meant to be public that the engine cannot see through leaves a signed-out caller with
 * `401 42501` and nothing else said. Printed on every diff, changed or not, so the author sees
 * what each role is left with; a line the push changes shows what it is now as well.
 */

/** Who a role is, said beside its name. */
const ROLE_CALLER: Readonly<Record<string, string>> = {
  anon: "signed out",
  authenticated: "signed in",
}

/** Space between a table's name and what the role may do on it, and before what a link denies. */
const GAP = 3
const GAP_TEXT = " ".repeat(GAP)

function verbs(list: readonly string[]): string {
  return list.length === 0 ? "none" : list.join(", ")
}

function sameVerbs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((verb) => b.includes(verb))
}

/** `none -> read` for a line the push changes, else what the role may do after it. */
function accessText(entry: RoleAccess): string {
  const after = verbs(entry.after)
  const text = changes(entry) ? `${verbs(entry.before)} -> ${after}` : after
  const { denied } = entry
  return denied === undefined ? text : `${text}${GAP_TEXT}(${denied.verbs.join(", ")} denied: ${denied.reason})`
}

function changes(entry: RoleAccess): boolean {
  return !sameVerbs(entry.before, entry.after)
}

/** A table's name, and `(link)` after a many-to-many junction's. */
function label(entry: RoleAccess): string {
  return entry.link === true ? `${entry.table} (link)` : entry.table
}

function heading(role: string): string {
  const caller = ROLE_CALLER[role]
  return caller === undefined ? `Access for ${role}:` : `Access for ${role} (${caller}):`
}

/** The entries grouped by role, each role in the order it first appears. */
function byRole(access: readonly RoleAccess[]): Map<string, RoleAccess[]> {
  const groups = new Map<string, RoleAccess[]>()
  for (const entry of access) {
    const group = groups.get(entry.role)
    if (group === undefined) groups.set(entry.role, [entry])
    else group.push(entry)
  }
  return groups
}

export interface RoleAccessOptions {
  /** Only the lines a push changes, and no block for a role with none: what `supatype dev` prints. */
  changedOnly?: boolean
}

/** One block per role: a heading, then one line per table with its names aligned. */
export function formatRoleAccess(access: readonly RoleAccess[], options: RoleAccessOptions = {}): string[] {
  const shown = options.changedOnly === true ? access.filter(changes) : access
  const width = Math.max(0, ...shown.map((entry) => label(entry).length)) + GAP
  const blocks = [...byRole(shown)].map(([role, entries]) => [
    heading(role),
    ...entries.map((entry) => `  ${label(entry).padEnd(width)}${accessText(entry)}`),
  ])
  return blocks.flatMap((block, i) => (i === 0 ? block : ["", ...block]))
}

/** Print each role's access, or nothing for an engine that does not send it. */
export function printRoleAccess(result: Pick<DiffResult, "access">, options: RoleAccessOptions = {}): void {
  const lines = formatRoleAccess(result.access ?? [], options)
  if (lines.length > 0) console.log(`${lines.join("\n")}\n`)
}
