/**
 * A static site's public values on a self-host stack.
 *
 *   PUT /projects/:ref/site/env/config - the values `build.publicEnv` gives this environment
 *
 * `supatype push` sends them after the schema is applied, on every push, empty when the config
 * declares none so it clears what an earlier push wrote. They go into the manifest's `public_env`,
 * which the server watches and serves at `/supatype-env.js` and `/supatype-env.json` beside the
 * address and anon key, so a stack answers as Supatype Cloud does. A value is checked here as the
 * CLI checks it (`@supatype/shared`), so a stack never serves one a request put there that the CLI
 * would have refused.
 */
import { isRecordOf, isString, publicEnvProblems } from "@supatype/shared"
import { badRequest, bodyOf, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { writeChanged } from "../deploy-files.js"
import { manifestFile, readManifest } from "./hooks.js"

const isValuesBody = (value: unknown): value is { values: Record<string, string> } =>
  typeof value === "object" && value !== null && "values" in value && isRecordOf(isString)(value.values)

/** The refusals, said by name and never with the value. */
function refusalText(problems: ReadonlyArray<{ name: string; reason: string }>): string {
  return problems.map((p) => (p.name === "" ? `The public values: ${p.reason}` : `${p.name} ${p.reason}`)).join("; ")
}

export function registerSiteEnvRoutes(routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>): void {
  route(routes, "PUT", "/projects/:ref/site/env/config", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const { values } = bodyOf(ctx.body, isValuesBody)
    const problems = publicEnvProblems(values)
    if (problems.length > 0) throw badRequest(refusalText(problems))
    const manifest = readManifest()
    const same = JSON.stringify(values) === JSON.stringify(manifest["public_env"] ?? {})
    if (!same) {
      if (Object.keys(values).length === 0) delete manifest["public_env"]
      else manifest["public_env"] = values
      await writeChanged([manifestFile(manifest)])
    }
    sendJson(ctx.res, 200, { data: { values: Object.keys(values).sort() } })
  })
}
