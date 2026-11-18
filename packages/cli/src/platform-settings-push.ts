/**
 * The platform step of `supatype push` and `deploy` to a Cloud target: the project's `services` and
 * `realtime` settings go to `PUT /projects/:ref/platform-settings`, and its own S3 bucket
 * (`storage.s3`) to `PUT /projects/:ref/storage-bucket`, with each key the config points at
 * (`env("NAME")`) resolved from this machine's shell, then `.env`.
 *
 * Nothing is sent for a config that sets none of them, so a project that does not use these is
 * pushed exactly as before. A key this machine does not have is named, not sent empty. Both routes
 * belong to production, so any other environment is told so and skipped. A self-host target never
 * reaches any of this: it reads the same settings from the compose file.
 *
 * Switching to a different bucket does not move the files already stored, and the push says so.
 */
import { readDotEnvFiles } from "./env-file.js"
import { errorMessage } from "./error-message.js"
import { storageBucketPlan, platformSettingsBody, type StorageBucketBody } from "./platform-settings.js"
import { postApplyFailed } from "./post-apply.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import type { DeployTarget } from "./resolve-target.js"
import { TargetApiError, targetFetch } from "./target-client.js"
import { targetRequest } from "./target-request.js"
import { info, warn } from "./ui/messages.js"
import { withSpinner } from "./ui/progress.js"
import { isJsonObject } from "@supatype/shared"

export interface PlatformPushOptions {
  /** What `env("NAME")` resolves against. Default: the shell over `.env` and `.env.local`. */
  environment?: Readonly<Record<string, string | undefined>>
}

/** What a bucket's files are not: moved. Said whenever the bucket changes. */
export const FILES_NOT_MOVED =
  "Files already stored are not moved. New files go to the new bucket; the ones stored before stay where they were, and stop being served."

/** An error's text with every secret value taken out, whatever the server echoed. */
function withoutSecrets(text: string, secrets: readonly string[]): string {
  return secrets.filter((value) => value !== "").reduce((out, value) => out.split(value).join("***"), text)
}

async function putSettings(target: DeployTarget, body: NonNullable<ReturnType<typeof platformSettingsBody>>): Promise<boolean> {
  const request = targetRequest(target, { method: "PUT", subpath: "/platform-settings", body })
  try {
    await withSpinner("Sending platform settings", () => targetFetch(target.apiBaseUrl, target.apiPrefix, request))
    info("Platform settings applied (services, realtime).")
    return false
  } catch (err) {
    postApplyFailed(`the platform settings (services, realtime) were not applied: ${errorMessage(err)}`)
    return true
  }
}

/** The bucket the project has now, or undefined when it cannot be read: then the warning is given. */
async function currentBucket(target: DeployTarget): Promise<string | null | undefined> {
  try {
    const answer = await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, { method: "GET", subpath: "/storage-bucket" }))
    if (!isJsonObject(answer)) return undefined
    const bucket = answer["bucket"]
    return isJsonObject(bucket) && typeof bucket["bucket"] === "string" ? bucket["bucket"] : null
  } catch {
    return undefined
  }
}

async function putBucket(target: DeployTarget, body: StorageBucketBody): Promise<boolean> {
  const before = await currentBucket(target)
  const request = targetRequest(target, { method: "PUT", subpath: "/storage-bucket", body })
  try {
    const answer = await withSpinner("Sending storage bucket", () => targetFetch(target.apiBaseUrl, target.apiPrefix, request))
    const unchanged = isJsonObject(answer) && answer["unchanged"] === true
    info(unchanged ? `Storage bucket ${body.bucket}: unchanged.` : `Storage is now in the bucket ${body.bucket}.`)
    if (!unchanged && before !== body.bucket) warn(FILES_NOT_MOVED)
    return false
  } catch (err) {
    const refused = err instanceof TargetApiError && err.status === 403
    const why = withoutSecrets(errorMessage(err), [body.accessKey, body.secretKey])
    postApplyFailed(
      `the storage bucket was not set: ${why}`,
      refused ? "Only the organisation's owners and admins can change where a project keeps its files." : undefined,
    )
    return true
  }
}

/**
 * Send the project's platform settings to a Cloud target. True when a step failed (it has said so
 * and set the exit code); false when it went through or did not apply: a self-host target, a
 * non-production environment, or a project whose config sets none of these.
 */
export async function pushPlatformSettings(
  cwd: string,
  config: SupatypeProjectConfig,
  target: DeployTarget,
  opts: PlatformPushOptions = {},
): Promise<boolean> {
  if (target.mode !== "cloud") return false
  const settings = platformSettingsBody(config)
  const bucket = storageBucketPlan(config, opts.environment ?? { ...readDotEnvFiles(cwd), ...process.env })
  if (settings === undefined && bucket.kind === "none") return false
  if (target.environment !== "production") {
    warn(`Platform settings (services, realtime, storage.s3) apply to production only: not sent to ${target.environment}.`)
    return false
  }
  let failed = false
  if (settings !== undefined) failed = (await putSettings(target, settings)) || failed
  if (bucket.kind === "missing") {
    postApplyFailed(
      `the storage bucket was not set: ${bucket.names.join(", ")} ${bucket.names.length === 1 ? "is" : "are"} not set here.`,
      "Set it in the environment or .env, as storage.s3 names it with env().",
    )
    failed = true
  } else if (bucket.kind === "send") {
    failed = (await putBucket(target, bucket.body)) || failed
  }
  return failed
}
