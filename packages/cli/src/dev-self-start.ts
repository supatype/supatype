/**
 * `supatype dev` starting itself as its own app. In proxy mode dev runs a package.json script as
 * the app, and init writes `"dev": "supatype dev"`, so `app.start: "dev"` made dev run a second dev
 * inside its app pane. That copy failed, and the pane restarted it for ever.
 */

import { fatalError } from "./ui/fatal.js"

/** Set on the app dev starts, so a `supatype dev` the app starts some other way can tell. */
export const DEV_APP_ENV = "SUPATYPE_DEV_APP"

/** A `supatype dev` refused inside dev's own app exits with this, and the app pane leaves it stopped. */
export const SELF_START_EXIT_CODE = 78

/** What to do about either refusal. */
const SET_APP_START = "Set app.start in supatype.config.ts to the script that starts your frontend's dev server."

/** `supatype dev` or `@supatype/cli dev` as a command in a script, wherever the CLI was run from. */
const RUNS_SUPATYPE_DEV = /(?:^|[\s;&|(/])(?:@supatype\/cli|supatype)(?:\.js)?\s+dev(?=$|[\s;&|)])/

/** Whether a package.json script body runs `supatype dev`. */
export function runsSupatypeDev(scriptBody: string): boolean {
  return RUNS_SUPATYPE_DEV.test(scriptBody)
}

/** Why dev will not run `script` as its app. */
export function selfStartProblem(script: string): string {
  return `package.json script "${script}" runs supatype dev, so dev would start itself as your app.\n  ${SET_APP_START}`
}

/** Ends this `supatype dev` when dev started it as its own app, before it starts anything. */
export function refuseInsideDevApp(env: NodeJS.ProcessEnv = process.env): void {
  if (env[DEV_APP_ENV] !== "1") return
  fatalError("supatype dev was started by supatype dev's own app, so it is not starting again.", [SET_APP_START], {
    exitCode: SELF_START_EXIT_CODE,
  })
}
