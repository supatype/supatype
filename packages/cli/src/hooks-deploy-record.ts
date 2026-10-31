/**
 * Which linked targets the last successful hook deploy gave anything to (a handler, or an entry in
 * the hook, validator or cache map), kept in `.supatype/hooks-deployed.json`.
 *
 * A push sends an empty hook deploy only to clear what a target was last given. Sent on every push,
 * it failed the push for someone allowed to push a schema but not to deploy hooks, though there was
 * nothing to deploy; and a 403 cannot be waved through either, since an empty deploy that clears
 * hooks is a real change. With this record, an empty deploy goes only where it clears something,
 * and any refusal of it is a failure.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { isBoolean, isRecordOf } from "@supatype/shared"
import { readJsonFile } from "./json-file.js"
import type { DeployTarget } from "./resolve-target.js"

const RECORD = join(".supatype", "hooks-deployed.json")

/** One target, as a key: the same project on another server or environment is another target. */
function targetKey(target: DeployTarget): string {
  return [target.mode, target.apiBaseUrl, target.projectRef, target.environment].join(" ")
}

function readRecord(cwd: string): Record<string, boolean> {
  return readJsonFile(join(cwd, RECORD), isRecordOf(isBoolean)) ?? {}
}

/** Whether the last hook deploy that `target` took gave it anything. */
export function targetHasDeployedHooks(cwd: string, target: DeployTarget): boolean {
  return readRecord(cwd)[targetKey(target)] === true
}

/** Records what `target` was just given: anything, or nothing. */
export function recordHooksDeploy(cwd: string, target: DeployTarget, gaveAnything: boolean): void {
  const record = { ...readRecord(cwd), [targetKey(target)]: gaveAnything }
  const path = join(cwd, RECORD)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8")
}
