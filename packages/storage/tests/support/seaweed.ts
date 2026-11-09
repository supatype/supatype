/**
 * A throwaway SeaweedFS for the service's S3 tests, on a free local port, with an admin login and
 * an app login whose actions the test chooses, as SeaweedFS reads them from `s3.json`. Needs Docker.
 */
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3"

export const ADMIN = { accessKeyId: "admin", secretAccessKey: "admin-secret" }
export const APP = { accessKeyId: "app", secretAccessKey: "app-secret" }
// The same pin as the self-host compose file and the storage-backend e2e.
const SEAWEEDFS_IMAGE = "chrislusf/seaweedfs:4.46@sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62"

export function docker(args: string[]): string {
  const res = spawnSync("docker", args, { encoding: "utf8" })
  if (res.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${res.stderr}`)
  return res.stdout.trim()
}

export interface Seaweed {
  container: string
  endpoint: string
  /** A client on the admin login, for looking at what the service wrote. */
  admin: S3Client
  /** Removes the container and its config. */
  stop(): void
}

/** Starts SeaweedFS, the app login allowed `appActions`, and waits until the admin login can create a bucket. */
export async function startSeaweed(appActions: readonly string[]): Promise<Seaweed> {
  const work = mkdtempSync(join(tmpdir(), "storage-seaweed-"))
  const identities = {
    identities: [
      { name: "admin", credentials: [{ accessKey: ADMIN.accessKeyId, secretKey: ADMIN.secretAccessKey }], actions: ["Admin", "Read", "List", "Tagging", "Write"] },
      { name: "app", credentials: [{ accessKey: APP.accessKeyId, secretKey: APP.secretAccessKey }], actions: [...appActions] },
    ],
  }
  writeFileSync(join(work, "s3.json"), JSON.stringify(identities))
  chmodSync(work, 0o755)
  chmodSync(join(work, "s3.json"), 0o644)
  const container = docker([
    "run", "-d", "--rm", "-p", "127.0.0.1::8333", "-v", `${join(work, "s3.json").replaceAll("\\", "/")}:/etc/seaweedfs/s3.json:ro`,
    SEAWEEDFS_IMAGE, "server", "-dir=/data", "-s3", "-s3.port=8333", "-s3.config=/etc/seaweedfs/s3.json",
  ])
  const endpoint = `http://127.0.0.1:${docker(["port", container, "8333"]).split(":").pop()}`
  const admin = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: ADMIN })
  const stop = (): void => {
    admin.destroy()
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" })
    rmSync(work, { recursive: true, force: true })
  }
  await waitUntilReady(admin)
  return { container, endpoint, admin, stop }
}

/** Waits for SeaweedFS to take a bucket create, with a probe bucket the admin login then keeps. */
async function waitUntilReady(admin: S3Client): Promise<void> {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      await admin.send(new CreateBucketCommand({ Bucket: "ready-probe" }))
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}
