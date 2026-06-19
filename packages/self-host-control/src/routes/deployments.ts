import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  cpSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"

interface DeploymentMeta {
  id: string
  status: string
  preview?: boolean
  createdAt?: string
  finalizedAt?: string
}

function projectRoot(): string {
  return process.env["SUPATYPE_PROJECT_ROOT"] ?? "/project"
}

function deploymentsDir(): string {
  return process.env["SUPATYPE_DEPLOYMENTS_DIR"] ?? join(projectRoot(), ".supatype", "deployments")
}

function staticRoot(): string {
  return process.env["SUPATYPE_STATIC_ROOT"] ?? join(projectRoot(), "dist")
}

function readMeta(id: string): DeploymentMeta | null {
  const metaPath = join(deploymentsDir(), id, "meta.json")
  if (!existsSync(metaPath)) return null
  return JSON.parse(readFileSync(metaPath, "utf8")) as DeploymentMeta
}

function writeMeta(id: string, meta: DeploymentMeta): void {
  mkdirSync(join(deploymentsDir(), id), { recursive: true })
  writeFileSync(join(deploymentsDir(), id, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8")
}

function currentPath(): string {
  return join(deploymentsDir(), "current")
}

function currentLiveId(): string | null {
  if (!existsSync(currentPath())) return null
  return readFileSync(currentPath(), "utf8").trim() || null
}

function listDeploymentMetas(): DeploymentMeta[] {
  const dir = deploymentsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readMeta(d.name))
    .filter((m): m is DeploymentMeta => m !== null)
}

function findPreviousDeployment(): DeploymentMeta | null {
  const candidates = listDeploymentMetas()
    .filter((m) => m.status === "previous" && m.preview !== true)
    .sort((a, b) => {
      const ta = a.finalizedAt ?? a.createdAt ?? ""
      const tb = b.finalizedAt ?? b.createdAt ?? ""
      return tb.localeCompare(ta)
    })
  return candidates[0] ?? null
}

function clearStaticRoot(): void {
  const root = staticRoot()
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    rmSync(join(root, entry), { recursive: true, force: true })
  }
}

function copyDeploymentFilesToStatic(id: string): void {
  const src = join(deploymentsDir(), id, "files")
  mkdirSync(staticRoot(), { recursive: true })
  clearStaticRoot()
  if (!existsSync(src)) return
  for (const entry of readdirSync(src)) {
    cpSync(join(src, entry), join(staticRoot(), entry), { recursive: true, force: true })
  }
}

function promoteDeploymentToStatic(id: string, meta: DeploymentMeta): void {
  copyDeploymentFilesToStatic(id)
  writeMeta(id, { ...meta, status: "live", finalizedAt: new Date().toISOString() })
  writeFileSync(currentPath(), id, "utf8")
}

export function registerDeploymentRoutes(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "POST", "/projects/:ref/deployments", async (ctx) => {
    const body = ctx.body as {
      files?: Array<{ path: string; content: string; encoding?: string }>
      preview?: boolean
    }
    const id = randomUUID().slice(0, 8)
    const dest = join(deploymentsDir(), id, "files")
    mkdirSync(dest, { recursive: true })

    for (const file of body.files ?? []) {
      const target = join(dest, file.path)
      mkdirSync(join(target, ".."), { recursive: true })
      const buf = file.encoding === "base64"
        ? Buffer.from(file.content, "base64")
        : Buffer.from(file.content, "utf8")
      writeFileSync(target, buf)
    }

    writeMeta(id, {
      id,
      status: "pending",
      preview: body.preview ?? false,
      createdAt: new Date().toISOString(),
    })

    sendJson(ctx.res, 201, { data: { id, uploadUrl: null } })
  })

  route(routes, "POST", "/projects/:ref/deployments/rollback", async (ctx) => {
    const body = ctx.body as { to?: string }
    let previous: DeploymentMeta | null

    if (body.to) {
      const meta = readMeta(body.to)
      if (!meta || meta.preview === true) {
        sendJson(ctx.res, 404, {
          error: "not_found",
          message: `Deployment ${body.to} not found`,
        })
        return
      }
      previous = meta
    } else {
      previous = findPreviousDeployment()
    }

    if (!previous) {
      sendJson(ctx.res, 404, {
        error: "no_previous",
        message: "No previous deployment to roll back to",
      })
      return
    }

    const liveId = currentLiveId()
    if (liveId && liveId !== previous.id) {
      const liveMeta = readMeta(liveId)
      if (liveMeta && liveMeta.preview !== true) {
        writeMeta(liveId, { ...liveMeta, status: "previous" })
      }
    }

    promoteDeploymentToStatic(previous.id, previous)

    sendJson(ctx.res, 200, {
      data: {
        version: previous.id,
        message: `Rolled back to deployment ${previous.id}.`,
      },
    })
  })

  route(routes, "POST", "/projects/:ref/deployments/:id/finalize", async (ctx) => {
    const id = ctx.params["id"]!
    const meta = readMeta(id)
    if (!meta) {
      sendJson(ctx.res, 404, { error: "not_found", message: "Deployment not found" })
      return
    }

    const liveId = currentLiveId()
    if (liveId && liveId !== id) {
      const liveMeta = readMeta(liveId)
      if (liveMeta && liveMeta.preview !== true) {
        writeMeta(liveId, { ...liveMeta, status: "previous" })
      }
    }

    promoteDeploymentToStatic(id, meta)

    sendJson(ctx.res, 200, { data: { id, status: "live" } })
  })

  route(routes, "GET", "/projects/:ref/deployments/current", async (ctx) => {
    const liveId = currentLiveId()
    if (!liveId) {
      sendJson(ctx.res, 200, { data: null })
      return
    }
    sendJson(ctx.res, 200, { data: readMeta(liveId) })
  })

  route(routes, "GET", "/projects/:ref/deployments", async (ctx) => {
    sendJson(ctx.res, 200, { data: listDeploymentMetas() })
  })
}
