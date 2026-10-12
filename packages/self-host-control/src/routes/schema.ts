import type { ServerResponse } from "node:http"
import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject } from "../project.js"
import { PUSH_IDENTITY } from "../push-identity.js"
import {
  databaseUrlFromEnv,
  engineRefusal,
  type EngineRefusal,
  runEngineCapabilities,
  runEngineAdoptWithAst,
  runEngineDiff,
  runEngineDoctor,
  runEngineIntrospect,
  runEngineListMigrations,
  runEngineMigrationSources,
  runEnginePush,
  runEngineRollback,
} from "../engine-runner.js"

/** A list of strings in a request body, or undefined when it is absent or not one. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined
}

/**
 * Run `work`, answering a refusal the engine names (security drift, unmanaged tables, a busy
 * engine, a rebaseline whose drift moved after its preview, a rollback with nothing to undo) as its
 * own HTTP server does: 409 with the reason and what it is about. `statusOf` picks another status
 * for a refusal this route has always answered differently.
 */
async function answering(
  res: ServerResponse,
  work: () => Promise<unknown>,
  statusOf: (refusal: EngineRefusal) => { status: number; error: string } | undefined = () => undefined,
): Promise<void> {
  let data: unknown
  try {
    data = await work()
  } catch (err) {
    const refusal = engineRefusal(err)
    if (refusal === undefined) throw err
    const answer = statusOf(refusal) ?? { status: 409, error: refusal.reason }
    sendJson(res, answer.status, { ...refusal, error: answer.error, code: refusal.reason })
    return
  }
  sendJson(res, 200, { data })
}

export function registerSchemaRoutes(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "POST", "/projects/:ref/schema/diff", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as { ast?: unknown; schema?: string }
    const db = databaseUrlFromEnv()
    const data = await runEngineDiff(db, body.ast, body.schema ?? "public")
    sendJson(ctx.res, 200, { data })
  })

  // What the engine behind this control plane supports, so a CLI refuses a flag it would drop.
  route(routes, "GET", "/projects/:ref/schema/capabilities", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    sendJson(ctx.res, 200, { data: await runEngineCapabilities() })
  })

  route(routes, "POST", "/projects/:ref/schema/push", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as {
      ast?: unknown
      force?: boolean
      schema?: string
      schemaSources?: { manifest?: unknown; dataBase64?: string }
      overwrite_drift?: boolean
      /** The spelling a CLI from before the capabilities check sent. */
      overwriteDrift?: boolean
      /** Where the push comes from (a host, a CI run): context, kept as the client sent it. */
      pushed_from?: unknown
    }
    const db = databaseUrlFromEnv()
    await answering(ctx.res, () =>
      runEnginePush(db, body.ast, {
        force: body.force,
        schema: body.schema,
        schemaSourcesGzBase64: body.schemaSources?.dataBase64,
        schemaSourcesManifest: body.schemaSources?.manifest,
        overwriteDrift: body.overwrite_drift === true || body.overwriteDrift === true,
        // The author is who this control plane authenticated: `pushed_by` and
        // `pushed_by_verified` in the body are the client's claim, and are not read.
        audit: {
          ...PUSH_IDENTITY,
          pushedVia: "self-host",
          ...(typeof body.pushed_from === "string" && body.pushed_from !== "" && { pushedFrom: body.pushed_from }),
        },
      }),
    )
  })

  route(routes, "POST", "/projects/:ref/schema/rollback", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as { schema?: string }
    const db = databaseUrlFromEnv()
    // Nothing to undo (`no_applied_migration`, `no_rollback_sql`) is a 409 naming which.
    await answering(ctx.res, () => runEngineRollback(db, body.schema ?? "public"))
  })

  route(routes, "GET", "/projects/:ref/schema/migrations", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const db = databaseUrlFromEnv()
    const data = await runEngineListMigrations(db)
    sendJson(ctx.res, 200, { data })
  })

  route(routes, "GET", "/projects/:ref/schema/migrations/:name/sources", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const name = ctx.params["name"]!
    const db = databaseUrlFromEnv()
    // A migration that recorded no sources has none to return: a 404, as it has always been, now
    // naming `no_schema_snapshot` as its code.
    await answering(
      ctx.res,
      () => runEngineMigrationSources(db, name),
      (refusal) => (refusal.reason === "no_schema_snapshot" ? { status: 404, error: "not_found" } : undefined),
    )
  })

  route(routes, "POST", "/projects/:ref/schema/doctor", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as {
      ast?: unknown
      no_cache?: boolean
      schema?: string
      rebaseline?: boolean
      accept_access_drift?: boolean
      keys?: unknown
    }
    const keys = stringList(body.keys)
    // Over HTTP `keys: []` means "the preview showed nothing", which the binary cannot be told: no
    // `--key` at all is "record whatever drift there is". Refused rather than sent unkeyed.
    if (body.rebaseline === true && keys !== undefined && keys.length === 0) {
      sendJson(ctx.res, 400, {
        error: "validation_error",
        message: "'keys' names no object: send the drifted objects the preview showed, or no 'keys'",
      })
      return
    }
    const db = databaseUrlFromEnv()
    await answering(ctx.res, () =>
      runEngineDoctor(db, body.ast, {
        noCache: body.no_cache,
        schema: body.schema,
        rebaseline: body.rebaseline === true,
        acceptAccessDrift: body.accept_access_drift === true,
        ...(keys !== undefined && { keys }),
      }),
    )
  })

  route(routes, "POST", "/projects/:ref/schema/introspect", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as { schema?: string }
    const db = databaseUrlFromEnv()
    const data = await runEngineIntrospect(db, body.schema ?? "public")
    sendJson(ctx.res, 200, { data })
  })

  route(routes, "POST", "/projects/:ref/schema/adopt", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as {
      ast?: unknown
      names?: string[]
      schema?: string
      yes?: boolean
      no_cache?: boolean
      keys?: unknown
      release?: unknown
      reclaim?: unknown
    }
    if (!body.ast) {
      sendJson(ctx.res, 400, { error: "validation_error", message: "ast required" })
      return
    }
    const db = databaseUrlFromEnv()
    const keys = stringList(body.keys)
    const release = stringList(body.release)
    const reclaim = stringList(body.reclaim)
    await answering(ctx.res, () =>
      runEngineAdoptWithAst(db, body.ast, {
        schema: body.schema,
        yes: body.yes,
        noCache: body.no_cache,
        // `keys: []` is "adopt none", which an absent list is not: kept apart all the way down.
        ...(keys !== undefined && { keys }),
        ...(release !== undefined && { release }),
        ...(reclaim !== undefined && { reclaim }),
      }),
    )
  })
}
