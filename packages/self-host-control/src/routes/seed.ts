import { createHash, randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { isJsonObject } from "@supatype/shared"
import {
  REMOTE_SEED_MAX_BODY_BYTES,
  REMOTE_SEED_MAX_FILES,
  parseRemoteSeedRequest,
  type RemoteSeedRefusal,
  type RemoteSeedRequest,
} from "@supatype/types"
import { audit } from "../audit.js"
import { databaseUrlFromEnv, runEngineDiff } from "../engine-runner.js"
import { HttpError, route, sendJson } from "../http.js"
import type { RouteHandler } from "../http.js"
import { SELF_HOST_ENVIRONMENT, assertProject } from "../project.js"
import { redactCredentials, runEngineSeed, runEngineSeedStatus, seedTimeoutMs } from "../seed-runner.js"

/**
 * Remote seeding, the self-host half: the same two routes and answers as Cloud's control plane,
 * from the one contract in `@supatype/types`.
 *
 *   POST /projects/:ref/seed          apply the seed documents the CLI collected
 *   GET  /projects/:ref/seed/status   what has been applied, and what has changed since
 *
 * Who may seed is decided before a request gets here: only the gateway reaches this server, and it
 * forwards `/platform/v1` for the service role alone (see `push-identity.ts`), as it does for push.
 */

type Routes = Array<{ method: string; pattern: RegExp; handler: RouteHandler }>

/** A refusal: no engine run, answered with its status and the contract's error code. */
interface Refusal {
  status: number
  error: RemoteSeedRefusal
  message: string
}

/**
 * Whether a seed is running. A self-hosted project has one database and one environment, so one flag
 * is the per-environment lock. It lives in this process, which is the only one that seeds.
 */
let seeding = false

/** The environment the request addresses: the header, or the only one there is. */
function targetEnvironment(req: IncomingMessage): string {
  const header = req.headers["x-supatype-environment"]
  const named = (Array.isArray(header) ? header[0] : header)?.trim()
  const environment = named === undefined || named === "" ? SELF_HOST_ENVIRONMENT : named
  if (environment !== SELF_HOST_ENVIRONMENT) {
    throw new HttpError(404, "not_found", `Unknown environment: ${environment}`)
  }
  return environment
}

/** The request body as the contract reads it, or the refusal that names what is wrong with it. */
function readRequest(body: unknown): RemoteSeedRequest {
  if (isJsonObject(body) && Array.isArray(body["irDocuments"]) && body["irDocuments"].length > REMOTE_SEED_MAX_FILES) {
    throw new HttpError(413, "payload_too_large", `At most ${REMOTE_SEED_MAX_FILES} seed files can be sent at once.`)
  }
  const parsed = parseRemoteSeedRequest(body)
  if ("invalid" in parsed) throw new HttpError(400, "validation_error", parsed.invalid)
  return parsed
}

/** Why this request must not run, or undefined when it may. */
function refusalFor(request: RemoteSeedRequest, environment: string): Refusal | undefined {
  if (request.environment !== undefined && request.environment !== environment) {
    return {
      status: 400,
      error: "environment_mismatch",
      message: `--environment ${request.environment} does not match the target environment ${environment}.`,
    }
  }
  if (environment === "production" && !request.confirmProduction) {
    return {
      status: 409,
      error: "production_confirmation_required",
      message: "Seeding production needs confirmProduction: true.",
    }
  }
  return undefined
}

/**
 * The schema check (D6): the database must already have the schema the seed was written against.
 * The engine's diff compares that schema with the live database, so a schema edited and not pushed
 * is refused here, before anything is written, instead of failing part way through the run.
 */
async function schemaRefusal(databaseUrl: string, ast: unknown): Promise<Refusal | undefined> {
  const { operations } = await runEngineDiff(databaseUrl, ast)
  if (operations.length === 0) return undefined
  return {
    status: 409,
    error: "schema_not_pushed",
    message:
      `The database does not have the schema in this seed yet (${operations.length} change(s) to push). ` +
      "Run `supatype push` first.",
  }
}

interface AuditedFile {
  file: string
  hash: string
  status?: string
  written?: unknown
}

/** The `file` key of a collected document, or its position when the text is not what was expected. */
function fileNameOf(document: string, index: number): string {
  try {
    const parsed: unknown = JSON.parse(document)
    if (isJsonObject(parsed) && typeof parsed["file"] === "string") return parsed["file"]
  } catch {
    /* named by position below */
  }
  return `document-${index}`
}

/** Each file by name and the SHA-256 of its text, with what the engine said happened to it. Never rows. */
function auditedFiles(documents: readonly string[], result: unknown): AuditedFile[] {
  const reported = isJsonObject(result) && Array.isArray(result["files"]) ? result["files"] : []
  return documents.map((document, index) => {
    const file = fileNameOf(document, index)
    const outcome = reported.find((one) => isJsonObject(one) && one["file"] === file)
    return {
      file,
      hash: createHash("sha256").update(document, "utf8").digest("hex"),
      ...(isJsonObject(outcome) && typeof outcome["status"] === "string" && { status: outcome["status"] }),
      ...(isJsonObject(outcome) && outcome["written"] !== undefined && { written: outcome["written"] }),
    }
  })
}

function runDetail(request: RemoteSeedRequest, environment: string, runId: string): Record<string, unknown> {
  return {
    environment,
    runId,
    atomic: request.atomic,
    runOnce: request.runOnce,
    conditionEnvironment: request.environment ?? environment,
    ...(request.pushedFrom !== undefined && { pushedFrom: request.pushedFrom }),
  }
}

async function refuse(
  res: ServerResponse,
  request: RemoteSeedRequest,
  environment: string,
  refusal: Refusal,
): Promise<void> {
  await audit({
    actorId: null,
    action: "seed.refused",
    detail: { ...runDetail(request, environment, randomUUID()), reason: refusal.error },
  })
  sendJson(res, refusal.status, { error: refusal.error, message: refusal.message })
}

/**
 * Check the schema, run the engine and answer. A failure to run either is a 502 with credentials
 * redacted, and is audited.
 */
async function apply(res: ServerResponse, request: RemoteSeedRequest, environment: string): Promise<void> {
  const runId = randomUUID()
  const databaseUrl = databaseUrlFromEnv()
  const detail = runDetail(request, environment, runId)
  try {
    const refusal = await schemaRefusal(databaseUrl, request.ast)
    if (refusal !== undefined) return await refuse(res, request, environment, refusal)
    const data = await runEngineSeed(databaseUrl, request.ast, request.irDocuments, {
      atomic: request.atomic,
      runOnce: request.runOnce,
      environment: request.environment ?? environment,
      timeoutMs: seedTimeoutMs(),
    })
    const failed = isJsonObject(data) && data["ok"] === false
    await audit({
      actorId: null,
      action: failed ? "seed.failed" : "seed.applied",
      detail: { ...detail, files: auditedFiles(request.irDocuments, data) },
    })
    sendJson(res, 200, { data, run: { id: runId } })
  } catch (err) {
    const message = redactCredentials(err instanceof Error ? err.message : String(err), databaseUrl)
    await audit({
      actorId: null,
      action: "seed.failed",
      detail: { ...detail, files: auditedFiles(request.irDocuments, undefined), error: message },
    })
    sendJson(res, 502, { error: "engine_error", message })
  }
}

async function handleSeed(ctx: Parameters<RouteHandler>[0]): Promise<void> {
  assertProject(ctx.params["ref"]!)
  const environment = targetEnvironment(ctx.req)
  const request = readRequest(ctx.body)
  const refusal = refusalFor(request, environment)
  if (refusal !== undefined) return refuse(ctx.res, request, environment, refusal)
  if (seeding) {
    return refuse(ctx.res, request, environment, {
      status: 409,
      error: "seed_busy",
      message: "Another seed is running on this project. Try again when it has finished.",
    })
  }
  seeding = true
  try {
    await apply(ctx.res, request, environment)
  } finally {
    seeding = false
  }
}

async function handleStatus(ctx: Parameters<RouteHandler>[0]): Promise<void> {
  assertProject(ctx.params["ref"]!)
  targetEnvironment(ctx.req)
  const databaseUrl = databaseUrlFromEnv()
  try {
    sendJson(ctx.res, 200, { data: await runEngineSeedStatus(databaseUrl, seedTimeoutMs()) })
  } catch (err) {
    const message = redactCredentials(err instanceof Error ? err.message : String(err), databaseUrl)
    sendJson(ctx.res, 502, { error: "engine_error", message })
  }
}

export function registerSeedRoutes(routes: Routes): void {
  route(routes, "POST", "/projects/:ref/seed", handleSeed, { maxBodyBytes: REMOTE_SEED_MAX_BODY_BYTES })
  route(routes, "GET", "/projects/:ref/seed/status", handleStatus)
}
