/**
 * Uploading a built static site to Supatype Cloud: the manifest the server is asked about, and the
 * calls that follow. The design is Cloud-Static-Hosting-Plan.md, CLI section.
 */

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { isShape, isString } from "@supatype/shared"
import { targetFetch } from "./target-client.js"
import { info } from "./ui/messages.js"

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
const isCreatedDeployment = isShape({ deploymentId: isString, uploadUrl: isString })

/** The manifest the create call sends for `files`. */
export function manifestOf(files: readonly SiteFile[]): ManifestEntry[] {
  return files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }))
}

/** Create a deployment for `files` and upload them. */
export async function deploySite(
  target: SiteTarget,
  outputDir: string,
  opts: { spa: boolean; preview: boolean },
): Promise<void> {
  const files = collectSiteFiles(outputDir)
  const call = {
    token: target.token,
    orgId: target.orgId,
    environment: target.environment,
  }

  const created = await targetFetch(
    target.apiBaseUrl,
    "/api/v1",
    {
      ...call,
      method: "POST",
      path: `/projects/${target.projectRef}/deployments`,
      body: { preview: opts.preview, spa: opts.spa, files: manifestOf(files) },
    },
    isCreatedDeployment,
  )

  for (const file of files) {
    await fetch(`${created.uploadUrl}/${file.path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/octet-stream",
        "X-Deployment-Id": created.deploymentId,
      },
      body: readFileSync(file.absolutePath),
    })
  }

  await targetFetch(target.apiBaseUrl, "/api/v1", {
    ...call,
    method: "POST",
    path: `/projects/${target.projectRef}/deployments/${created.deploymentId}/finalize`,
  })
  info(`Uploaded ${files.length} files.`)
}
