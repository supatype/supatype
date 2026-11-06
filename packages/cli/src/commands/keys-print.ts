/**
 * `supatype keys --print <target>`: what `keys` prints instead of the key pair.
 *
 * `frontend` is a deployment's front-end names and values, one `NAME=value` per line and nothing
 * else on stdout, to paste into a host's settings or append to `$GITHUB_ENV`. They come from the
 * resolver `supatype build` uses (frontend-values.ts), with the same refusal of a local address, so
 * what is printed is what a wrapped build would have been given.
 */

import { frontendEnv } from "../frontend-env.js"
import { FrontendValuesRefused, resolveFrontendValues } from "../frontend-values.js"
import { fatalError } from "../ui/fatal.js"
import { plain } from "../ui/messages.js"

/** What `--print <target>` can print, beside the key pair bare `--print` does. */
const PRINT_TARGETS = ["frontend"] as const

function isPrintTarget(target: string): target is (typeof PRINT_TARGETS)[number] {
  return PRINT_TARGETS.some((known) => known === target)
}

/** The options only `--print frontend` reads, by flag name. */
export interface PrintTargetOptions {
  env: string | undefined
  allowLocal: boolean
}

/**
 * `keys --print <target>`, and `--env` / `--allow-local`, which only `--print frontend` reads.
 * `target` is true or undefined when one of those came without `--print frontend`, which leaves
 * them nothing to apply to.
 */
export async function printTarget(target: string | boolean | undefined, opts: PrintTargetOptions): Promise<void> {
  if (typeof target !== "string") {
    const given = [...(opts.env !== undefined ? ["--env"] : []), ...(opts.allowLocal ? ["--allow-local"] : [])]
    fatalError(`${given.join(" and ")} ${given.length > 1 ? "apply" : "applies"} only to --print frontend.`)
  }
  if (!isPrintTarget(target)) {
    fatalError(`Unknown --print target "${target}". Valid targets: ${PRINT_TARGETS.join(", ")} (or bare --print for the key pair).`)
  }
  try {
    const values = await resolveFrontendValues({
      cwd: process.cwd(),
      env: opts.env,
      allowLocal: opts.allowLocal,
      command: "supatype keys --print frontend",
    })
    for (const [name, value] of Object.entries(frontendEnv(values))) plain(`${name}=${value}`)
  } catch (err) {
    if (!(err instanceof FrontendValuesRefused)) throw err
    fatalError(err.message)
  }
}
