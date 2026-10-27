/**
 * Whether this project has already been asked to create its first admin.
 *
 * `supatype dev` asks "Create an admin user now?" when a project has no admin, and it asked on every
 * start of a project whose owner had said no, waiting each time. The answer is kept in the project's
 * `.supatype/` directory (gitignored, so it is one developer's answer, not the team's), and a "no"
 * is not asked again. `supatype admin create-user` creates one at any time.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { readJsonObjectFile } from "./json-file.js"

function statePath(cwd: string): string {
  return join(cwd, ".supatype", "admin-prompt.json")
}

/** True when the first-admin prompt was answered "no" in this project. */
export function adminPromptDeclined(cwd: string): boolean {
  return readJsonObjectFile(statePath(cwd))?.["declined"] === true
}

/** Keep the "no", so the prompt is not asked again. Best effort: failing to write only means it asks again. */
export function recordAdminPromptDeclined(cwd: string): void {
  const path = statePath(cwd)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ declined: true })}\n`)
  } catch {
    // Not worth failing a dev start over: the cost is one more question.
  }
}
