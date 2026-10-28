import { DeleteBucketPolicyCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.stubEnv("JWT_SECRET", "bucket-policy-test-secret")

const storage = await import("../src/s3.js")
const send = vi.spyOn(storage.s3, "send")

/**
 * A bucket made private or custom has to lose the public-read policy it was given. The policy
 * could only be put, never taken away, so a bucket made private stayed readable by anyone straight
 * from S3 while the service refused the same reads.
 */
beforeEach(() => {
  send.mockReset()
  send.mockImplementation(async () => ({}))
})

function sentCommands(): unknown[] {
  return send.mock.calls.map(([command]) => command)
}

describe("applyBucketPolicyFromConfig", () => {
  it("removes the bucket policy from a bucket that is not public", async () => {
    await storage.applyBucketPolicyFromConfig("b", { public: false, s3BucketPolicy: null })
    expect(sentCommands().some((c) => c instanceof DeleteBucketPolicyCommand)).toBe(true)
  })

  it.each(["NoSuchBucketPolicy", "NotImplemented", "MethodNotAllowed"])(
    "does not fail when S3 answers %s: there is no policy to remove",
    async (name) => {
      send.mockImplementation(async () => {
        throw Object.assign(new Error(name), { name })
      })
      await expect(storage.applyBucketPolicyFromConfig("b", { public: false })).resolves.toBeUndefined()
    },
  )

  it("still fails when the policy cannot be removed", async () => {
    send.mockImplementation(async () => {
      throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" })
    })
    await expect(storage.applyBucketPolicyFromConfig("b", { public: false })).rejects.toThrow("Access Denied")
  })

  it("puts the public policy on a public bucket", async () => {
    await storage.applyBucketPolicyFromConfig("b", { public: true })
    expect(sentCommands().some((c) => c instanceof PutBucketPolicyCommand)).toBe(true)
  })
})
