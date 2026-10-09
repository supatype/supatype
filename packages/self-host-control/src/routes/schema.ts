import type { ServerResponse } from "node:http"
import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import {
  databaseUrlFromEnv,
  engineRefusal,
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

function projectRef(): string {
  return process.env["SUPATYPE_PROJECT_REF"] ?? "project"
}

function assertProject(ref: string): void {
  if (ref !== projectRef()) {
    throw new Error(`Unknown project ref: ${ref}`)
  }
}

/** A list of strings in a request body, or undefined when it is absent or not one. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined
}

/**
 * Run `work`, answering a refusal the engine names (security drift, unmanaged tables, a busy
 * engine) as its own HTTP server does: 409 with the reason and what it is about.
 */
async function answering(res: ServerResponse, work: () => Promise<unknown>): Promise<void> {
  let data: unknown
  try {
    data = await work()
  } catch (err) {
    const refusal = engineRefusal(err)
    if (refusal === undefined) throw err
    sendJson(res, 409, { error: refusal.reason, code: refusal.reason, ...refusal })
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
    }
    const db = databaseUrlFromEnv()
    await answering(ctx.res, () =>
      runEnginePush(db, body.ast, {
        force: body.force,
        schema: body.schema,
        schemaSourcesGzBase64: body.schemaSources?.dataBase64,
        schemaSourcesManifest: body.schemaSources?.manifest,
        overwriteDrift: body.overwrite_drift === true || body.overwriteDrift === true,
      }),
    )
  })

  route(routes, "POST", "/projects/:ref/schema/rollback", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as { schema?: string }
    const db = databaseUrlFromEnv()
    const data = await runEngineRollback(db, body.schema ?? "public")
    sendJson(ctx.res, 200, { data })
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
    try {
      const data = await runEngineMigrationSources(db, name)
      sendJson(ctx.res, 200, { data })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("no schema snapshot")) {
        sendJson(ctx.res, 404, { error: "not_found", message })
        return
      }
      throw err
    }
  })

  route(routes, "POST", "/projects/:ref/schema/doctor", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as {
      ast?: unknown
      no_cache?: boolean
      schema?: string
      rebaseline?: boolean
      accept_access_drift?: boolean
    }
    const db = databaseUrlFromEnv()
    await answering(ctx.res, () =>
      runEngineDoctor(db, body.ast, {
        noCache: body.no_cache,
        schema: body.schema,
        rebaseline: body.rebaseline === true,
        acceptAccessDrift: body.accept_access_drift === true,
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
