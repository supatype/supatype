import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  cpSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { isArrayOf, isBoolean, isShape, isString, isUnknown, optional, type FromShape } from "@supatype/shared"
import { badRequest, bodyOf, HttpError, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { assertProject, projectRoot } from "../project.js"

const DEPLOYMENT_META = {
  id: isString,
  status: isString,
  preview: optional(isBoolean),
  createdAt: optional(isString),
  finalizedAt: optional(isString),
} as const

/** What `writeMeta` writes to a deployment's meta.json. */
type DeploymentMeta = FromShape<typeof DEPLOYMENT_META>

const isDeploymentMeta = isShape(DEPLOYMENT_META)

/** One file of a deployment: its path is checked by `fileInside`, which says what is wrong with it. */
const isDeploymentFile = isShape({ path: isUnknown, content: isString, encoding: optional(isString) })

interface DeploymentFile {
  path: unknown
  content: string
  encoding?: string
}

const isDeployBody = isShape({ files: optional(isArrayOf(isDeploymentFile)), preview: optional(isBoolean) })

const isRollbackBody = isShape({ to: optional(isUnknown) })

/** What `randomUUID().slice(0, 8)` produces, so an id can only ever name a directory of its own. */
const DEPLOYMENT_ID = /^[0-9a-f]{8}$/

/** `id` when it is a deployment id; a 400 otherwise. */
function checkedId(id: unknown): string {
  if (typeof id !== "string" || !DEPLOYMENT_ID.test(id)) {
    throw badRequest(`Invalid deployment id ${JSON.stringify(id)}`)
  }
  return id
}

/** `path` resolved under `root`, refused when it is empty or would land anywhere outside it. */
function fileInside(root: string, path: unknown): string {
  if (typeof path !== "string" || path === "" || isAbsolute(path)) {
    throw badRequest(`Invalid file path ${JSON.stringify(path)}`)
  }
  const target = resolve(root, path)
  const rel = relative(resolve(root), target)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw badRequest(`File path ${JSON.stringify(path)} resolves outside the deployment`)
  }
  return target
}

/** Write every file of a deployment, after checking all of their paths first. */
function writeDeploymentFiles(dest: string, files: DeploymentFile[]): void {
  const targets = files.map((file) => ({ file, target: fileInside(dest, file.path) }))
  mkdirSync(dest, { recursive: true })
  for (const { file, target } of targets) {
    mkdirSync(dirname(target), { recursive: true })
    const buf = file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : Buffer.from(file.content, "utf8")
    writeFileSync(target, buf)
  }
}

function deploymentsDir(): string {
  return process.env["SUPATYPE_DEPLOYMENTS_DIR"] ?? join(projectRoot(), ".supatype", "deployments")
}

function staticRoot(): string {
  return process.env["SUPATYPE_STATIC_ROOT"] ?? join(projectRoot(), "dist")
}

/** The deployment's meta.json, or null when there is none or it is not one `writeMeta` wrote. */
function readMeta(id: string): DeploymentMeta | null {
  const metaPath = join(deploymentsDir(), id, "meta.json")
  if (!existsSync(metaPath)) return null
  const meta = JSON.parse(readFileSync(metaPath, "utf8"))
  return isDeploymentMeta(meta) ? meta : null
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

/** Mark the current live deployment as previous, then serve `id` in its place. */
function makeLive(id: string, meta: DeploymentMeta): void {
  const liveId = currentLiveId()
  if (liveId && liveId !== id) {
    const liveMeta = readMeta(liveId)
    if (liveMeta && liveMeta.preview !== true) {
      writeMeta(liveId, { ...liveMeta, status: "previous" })
    }
  }
  promoteDeploymentToStatic(id, meta)
}

/** The deployment a rollback goes to: the one named by `to`, else the latest previous one. */
function rollbackTarget(to: unknown): DeploymentMeta {
  if (to === undefined || to === null || to === "") {
    const previous = findPreviousDeployment()
    if (!previous) throw new HttpError(404, "no_previous", "No previous deployment to roll back to")
    return previous
  }
  const id = checkedId(to)
  const meta = readMeta(id)
  if (!meta || meta.preview === true) {
    throw new HttpError(404, "not_found", `Deployment ${id} not found`)
  }
  return meta
}

export function registerDeploymentRoutes(
  routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }>,
): void {
  route(routes, "POST", "/projects/:ref/deployments", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const body = bodyOf(ctx.body, isDeployBody)
    const id = randomUUID().slice(0, 8)
    const dest = join(deploymentsDir(), id, "files")
    writeDeploymentFiles(dest, body.files ?? [])

    writeMeta(id, {
      id,
      status: "pending",
      preview: body.preview ?? false,
      createdAt: new Date().toISOString(),
    })

    sendJson(ctx.res, 201, { data: { id, uploadUrl: null } })
  })

  route(routes, "POST", "/projects/:ref/deployments/rollback", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const previous = rollbackTarget(bodyOf(ctx.body, isRollbackBody).to)
    makeLive(previous.id, previous)
    sendJson(ctx.res, 200, {
      data: {
        version: previous.id,
        message: `Rolled back to deployment ${previous.id}.`,
      },
    })
  })

  route(routes, "POST", "/projects/:ref/deployments/:id/finalize", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const id = checkedId(ctx.params["id"])
    const meta = readMeta(id)
    if (!meta) {
      sendJson(ctx.res, 404, { error: "not_found", message: "Deployment not found" })
      return
    }
    makeLive(id, meta)
    sendJson(ctx.res, 200, { data: { id, status: "live" } })
  })

  route(routes, "GET", "/projects/:ref/deployments/current", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    const liveId = currentLiveId()
    if (!liveId) {
      sendJson(ctx.res, 200, { data: null })
      return
    }
    sendJson(ctx.res, 200, { data: readMeta(liveId) })
  })

  route(routes, "GET", "/projects/:ref/deployments", async (ctx) => {
    assertProject(ctx.params["ref"]!)
    sendJson(ctx.res, 200, { data: listDeploymentMetas() })
  })
}
