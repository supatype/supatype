import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import {
  databaseUrlFromEnv,
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

  route(routes, "POST", "/projects/:ref/schema/push", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = ctx.body as {
      ast?: unknown
      force?: boolean
      schema?: string
      schemaSources?: { manifest?: unknown; dataBase64?: string }
    }
    const db = databaseUrlFromEnv()
    const data = await runEnginePush(db, body.ast, {
      force: body.force,
      schema: body.schema,
      schemaSourcesGzBase64: body.schemaSources?.dataBase64,
      schemaSourcesManifest: body.schemaSources?.manifest,
    })
    sendJson(ctx.res, 200, { data })
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
    const body = ctx.body as { ast?: unknown; no_cache?: boolean; schema?: string }
    const db = databaseUrlFromEnv()
    const data = await runEngineDoctor(db, body.ast, { noCache: body.no_cache, schema: body.schema })
    sendJson(ctx.res, 200, { data })
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
    }
    if (!body.ast) {
      sendJson(ctx.res, 400, { error: "validation_error", message: "ast required" })
      return
    }
    const db = databaseUrlFromEnv()
    const data = await runEngineAdoptWithAst(db, body.ast, {
      schema: body.schema,
      yes: body.yes,
      noCache: body.no_cache,
    })
    sendJson(ctx.res, 200, { data })
  })
}
