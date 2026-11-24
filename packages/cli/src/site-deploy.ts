/**
 * Uploading a built static site to Supatype Cloud: the manifest the server is asked about, and the
 * calls that follow. The design is Cloud-Static-Hosting-Plan.md, CLI section.
 */

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { isArrayOf, isNumber, isShape, isString, optional } from "@supatype/shared"
import { errorMessage, responseFailureText } from "./error-message.js"
import { TargetApiError, targetFetch } from "./target-client.js"
import { info, warn } from "./ui/messages.js"

/** Where a site goes: the control plane, the project and the caller's credentials. */
export interface SiteTarget {
  apiBaseUrl: string
  projectRef: string
  token: string
  orgId?: string | undefined
  environment?: string | undefined
}

/** One built file: where it is on disk, and what the server is told about it. */
export interface SiteFile {
  absolutePath: string
  /** POSIX, relative to the output directory, NFC. */
  path: string
  size: number
  sha256: string
}

/** One manifest entry as the create call sends it. */
export interface ManifestEntry {
  path: string
  size: number
  sha256: string
}

/** Every file under `dir`, sorted by path, each hashed. */
export function collectSiteFiles(dir: string): SiteFile[] {
  return listFiles(dir, dir).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function listFiles(dir: string, baseDir: string): SiteFile[] {
  const files: SiteFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isFile()) {
      files.push({
        absolutePath: fullPath,
        path: relative(baseDir, fullPath).replaceAll("\\", "/").normalize("NFC"),
        size: statSync(fullPath).size,
        sha256: createHash("sha256").update(readFileSync(fullPath)).digest("hex"),
      })
    } else if (entry.isDirectory()) {
      files.push(...listFiles(fullPath, baseDir))
    }
  }
  return files
}

/** The create call's answer: the deployment, where its blobs go, and which hashes the server lacks. */
const isCreatedDeployment = isShape({
  deploymentId: isString,
  uploadUrl: isString,
  missing: isArrayOf(isString),
  warnings: optional(isArrayOf(isShape({ code: isString, message: isString }))),
})

/** The warning Cloud attaches to a deploy that went live over the plan's size. */
const isOverPlan = isShape({
  code: isString,
  message: isString,
  planBytes: isNumber,
  siteBytes: isNumber,
  goodwillEndsAt: isString,
})

const BYTES_PER_MB = 1024 * 1024

/** Whole MB, rounded up so a site just over the plan never reads as equal to it. */
export const megabytes = (bytes: number): number => Math.ceil(bytes / BYTES_PER_MB)

/** The date part of an ISO timestamp; anything else is shown as the server sent it. */
const dateOf = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso)

/** The two lines that tell a person their site is over the plan and when to upgrade by. */
export function overPlanLines(siteBytes: number, planBytes: number, goodwillEndsAt: string): string[] {
  return [
    `This site is ${megabytes(siteBytes)} MB and your plan includes ${megabytes(planBytes)} MB. It is live, but over your plan.`,
    `Upgrade your plan before ${dateOf(goodwillEndsAt)} to avoid overage charges. Plans are managed in the Supatype Cloud dashboard.`,
  ]
}

/** Print what Cloud warned about: the plan overage in full, any other code as its message. */
function printWarnings(warnings: readonly unknown[]): void {
  for (const w of warnings) {
    if (isOverPlan(w) && w.code === "site_over_plan") {
      for (const line of overPlanLines(w.siteBytes, w.planBytes, w.goodwillEndsAt)) warn(line)
    } else if (isShape({ message: isString })(w)) {
      warn(w.message)
    }
  }
}

/** The manifest the create call sends for `files`. */
export function manifestOf(files: readonly SiteFile[]): ManifestEntry[] {
  return files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }))
}

/** How many blob uploads run at once. */
const UPLOAD_CONCURRENCY = 6
/** How many times a blob upload that failed with a 5xx, or never got an answer, is sent again. */
const UPLOAD_RETRIES = 3
/** How many times finalize is sent again after a 502 `pointer_not_pushed`. */
const FINALIZE_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 500

export interface DeploySiteOptions {
  spa: boolean
  /** Whether `build.spa` in the config set `spa`, so Studio can say so. Left out when the caller does not know. */
  spaFromConfig?: boolean
  preview: boolean
  /** Base wait before an upload or finalize is retried, multiplied by the attempt number. Tests set 0. */
  retryDelayMs?: number
}

/** The files to upload: one per missing hash. A hash with no local file is the server's mistake. */
function filesToUpload(files: readonly SiteFile[], missing: readonly string[]): SiteFile[] {
  const byHash = new Map<string, SiteFile>()
  for (const file of files) if (!byHash.has(file.sha256)) byHash.set(file.sha256, file)
  return [...new Set(missing)].map((hash) => {
    const file = byHash.get(hash)
    if (file === undefined) throw new Error(`The server asked for a file the build does not have (sha256 ${hash}).`)
    return file
  })
}

function callHeaders(target: SiteTarget): Record<string, string> {
  return {
    Authorization: `Bearer ${target.token}`,
    ...(target.orgId ? { "X-Org-Id": target.orgId } : {}),
    ...(target.environment ? { "X-Supatype-Environment": target.environment } : {}),
  }
}

/** One blob PUT: its body is the file, so Content-Length is the manifest's size. */
async function putBlob(target: SiteTarget, uploadUrl: string, file: SiteFile): Promise<Response> {
  return fetch(`${uploadUrl.replace(/\/$/, "")}/${file.sha256}`, {
    method: "PUT",
    headers: { ...callHeaders(target), "Content-Type": "application/octet-stream" },
    body: readFileSync(file.absolutePath),
  })
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** Upload one file, sending it again after a 5xx or a dropped connection; any other refusal stops the deploy. */
async function uploadBlob(target: SiteTarget, uploadUrl: string, file: SiteFile, retryDelayMs: number): Promise<void> {
  let failure = ""
  for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * attempt)
    let res: Response
    try {
      res = await putBlob(target, uploadUrl, file)
    } catch (err) {
      failure = errorMessage(err)
      continue
    }
    if (res.ok) {
      await res.body?.cancel()
      return
    }
    failure = await responseFailureText(res)
    if (res.status < 500) break
  }
  throw new Error(`Uploading ${file.path} failed: ${failure}`)
}

/** Run `work` over `items`, at most `limit` at a time; the first failure stops new work and is thrown. */
async function inPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed: unknown
  const worker = async (): Promise<void> => {
    while (failed === undefined && next < items.length) {
      const item = items[next++] as T
      try {
        await work(item)
      } catch (err) {
        failed = err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed !== undefined) throw failed
}

/** A site that is live: the deployment's version and the address it is served at. */
export interface SiteDeployed {
  version: string
  url: string
}

const isFinalized = isShape({ version: isString, status: isString, url: isString })

/** Whether finalize failed only because the live pointer was not pushed, which finalizing again fixes. */
function isPointerNotPushed(err: unknown): boolean {
  return err instanceof TargetApiError && err.status === 502 && err.code === "pointer_not_pushed"
}

/**
 * Finalize the deployment and read its answer. A 502 `pointer_not_pushed` means the version is
 * recorded but the project's server was not told, and finalize is idempotent, so it is sent again.
 */
async function finalizeSite(target: SiteTarget, deploymentId: string, retryDelayMs: number): Promise<SiteDeployed> {
  const request = {
    token: target.token,
    orgId: target.orgId,
    environment: target.environment,
    method: "POST",
    path: `/projects/${target.projectRef}/deployments/${deploymentId}/finalize`,
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = await targetFetch(target.apiBaseUrl, "/api/v1", request, isFinalized)
      if (answer.status !== "live") throw new Error(`The site is not live after finalizing: its status is ${answer.status}.`)
      return { version: answer.version, url: answer.url }
    } catch (err) {
      if (isPointerNotPushed(err) && attempt < FINALIZE_RETRIES) {
        await sleep(retryDelayMs * (attempt + 1))
        continue
      }
      if (isPointerNotPushed(err)) {
        throw new Error(`The files are uploaded but the site is not live: ${errorMessage(err)}. Run the deploy again to finalize it.`, { cause: err })
      }
      if (err instanceof TargetApiError) throw new Error(`Finalizing failed: ${errorMessage(err)}`, { cause: err })
      throw err
    }
  }
}

/** Create a deployment for the files under `outputDir`, upload the ones the server lacks, and make it live. */
export async function deploySite(target: SiteTarget, outputDir: string, opts: DeploySiteOptions): Promise<SiteDeployed> {
  const files = collectSiteFiles(outputDir)
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  const created = await targetFetch(
    target.apiBaseUrl,
    "/api/v1",
    {
      token: target.token,
      orgId: target.orgId,
      environment: target.environment,
      method: "POST",
      path: `/projects/${target.projectRef}/deployments`,
      body: {
        preview: opts.preview,
        spa: opts.spa,
        ...(opts.spaFromConfig !== undefined && { spaFromConfig: opts.spaFromConfig }),
        files: manifestOf(files),
      },
    },
    isCreatedDeployment,
  )

  const upload = filesToUpload(files, created.missing)
  info(`${upload.length} of ${files.length} files to upload, ${files.length - upload.length} already on the server`)
  await inPool(upload, UPLOAD_CONCURRENCY, (file) => uploadBlob(target, created.uploadUrl, file, retryDelayMs))

  const deployed = await finalizeSite(target, created.deploymentId, retryDelayMs)
  printWarnings(created.warnings ?? [])
  return deployed
}
