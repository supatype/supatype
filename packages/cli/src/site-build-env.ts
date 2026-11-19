/**
 * What a build of the site is given, one answer for `supatype build` and `supatype deploy`: the API
 * address and anon key under every framework's prefix, and the site's public values, with the
 * precedence between them decided once (site-public-env.ts, `buildPublicVars`): the config's values,
 * then a variable the shell already sets, then the ones Studio set.
 */

import { frontendEnv } from "./frontend-env.js"
import { resolveFrontendValues, type ResolvedFrontendValues } from "./frontend-values.js"
import { buildPublicVars, resolveBuildPublicEnv, siteScope } from "./site-public-env.js"

export interface SiteBuildEnvOptions {
  /** The linked environment to build for (`--env`), else the link's default. */
  env?: string | undefined
  allowLocal?: boolean | undefined
  /** The environment the build runs in, read first for every value: a host's own settings win. */
  shell: NodeJS.ProcessEnv
  /** The command a refusal tells the person to run with `--env`. */
  command?: string | undefined
}

export interface SiteBuildEnv {
  /** The variables to lay over the build's environment. */
  vars: Record<string, string>
  /** Where the address and anon key came from, for a line saying so. */
  frontend: ResolvedFrontendValues
  /** How many public values the build is given. */
  publicCount: number
}

/**
 * Resolve the address and anon key and fetch the public values together, then merge them. Throws a
 * {@link BuildRefused} (build-refused.ts) before anything is built when the address or key is
 * missing, or when Cloud holds values Studio set and cannot hand them over.
 */
export async function siteBuildEnv(cwd: string, opts: SiteBuildEnvOptions): Promise<SiteBuildEnv> {
  const scope = siteScope(cwd, { env: opts.env, tokenOptional: true })
  const [frontend, entries] = await Promise.all([
    resolveFrontendValues({
      cwd,
      env: opts.env,
      allowLocal: opts.allowLocal === true,
      processEnv: opts.shell,
      ...(opts.command !== undefined && { command: opts.command }),
    }),
    resolveBuildPublicEnv(scope),
  ])
  return { vars: { ...buildPublicVars(entries, opts.shell), ...frontendEnv(frontend) }, frontend, publicCount: entries.length }
}
