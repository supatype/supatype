import { describe, expect, it } from "vitest"
import { endpointToArgs } from "../src/engine-client.js"
import {
  auditFlags,
  auditWhenSupported,
  pushAuditFields,
  resolveAuthor,
  resolvePushedFrom,
} from "../src/push-audit.js"

/**
 * Who pushed, how and from where (the audit trail). The CLI cannot prove who is at the keyboard, so
 * it says who git says it is, else the OS user, and marks every claim unverified: only a control
 * plane that authenticated the caller records a verified author.
 */

describe("resolveAuthor()", () => {
  it("is git's user.name and user.email", () => {
    const git = (key: string) => ({ "user.name": "Ada Lovelace", "user.email": "ada@example.com" })[key]
    expect(resolveAuthor({ git, osUser: () => "ada" })).toBe("Ada Lovelace <ada@example.com>")
  })

  it("is the name alone when git has no email", () => {
    const git = (key: string) => (key === "user.name" ? "Ada Lovelace" : undefined)
    expect(resolveAuthor({ git, osUser: () => "ada" })).toBe("Ada Lovelace")
  })

  it("falls back to the OS user, marked unverified", () => {
    expect(resolveAuthor({ git: () => undefined, osUser: () => "ada" })).toBe("ada (OS user, unverified)")
  })

  it("is 'unknown' when neither can be read", () => {
    expect(resolveAuthor({ git: () => undefined, osUser: () => undefined })).toBe("unknown (unverified)")
  })
})

describe("resolvePushedFrom()", () => {
  it("is the CI run when a CI system says so", () => {
    expect(
      resolvePushedFrom(
        {
          GITHUB_ACTIONS: "true",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "acme/app",
          GITHUB_RUN_ID: "42",
        },
        "runner-1",
      ),
    ).toBe("github-actions https://github.com/acme/app/actions/runs/42")
    expect(resolvePushedFrom({ GITLAB_CI: "true", CI_PIPELINE_URL: "https://gitlab.com/p/-/pipelines/7" }, "h")).toBe(
      "gitlab-ci https://gitlab.com/p/-/pipelines/7",
    )
    expect(resolvePushedFrom({ CIRCLECI: "true", CIRCLE_BUILD_URL: "https://circleci.com/b/9" }, "h")).toBe(
      "circleci https://circleci.com/b/9",
    )
    expect(resolvePushedFrom({ BUILDKITE: "true", BUILDKITE_BUILD_URL: "https://buildkite.com/b/3" }, "h")).toBe(
      "buildkite https://buildkite.com/b/3",
    )
    expect(resolvePushedFrom({ CI: "true" }, "agent-7")).toBe("ci agent-7")
  })

  it("is the host name anywhere else", () => {
    expect(resolvePushedFrom({}, "nics-laptop")).toBe("nics-laptop")
  })
})

const fields = { pushed_by: "Ada <ada@example.com>", pushed_via: "cli", pushed_from: "laptop" }

describe("what the engine is sent", () => {
  it("over HTTP: who, the channel and where from, never a verified claim", () => {
    const sent = pushAuditFields(process.cwd())
    expect(Object.keys(sent).sort()).toEqual(["pushed_by", "pushed_from", "pushed_via"])
    expect(sent.pushed_via).toBe("cli")
    expect(sent).not.toHaveProperty("pushed_by_verified")
  })

  it("to the binary: the same fields as flags", () => {
    expect(auditFlags(fields)).toEqual([
      "--pushed-by",
      "Ada <ada@example.com>",
      "--pushed-via",
      "cli",
      "--pushed-from",
      "laptop",
    ])
    const args = endpointToArgs("/push", { ast: {}, ...fields }, { reqFile: "/tmp/req.json" })
    expect(args.slice(args.indexOf("--pushed-by"))).toEqual(auditFlags(fields))
    expect(endpointToArgs("/push", { ast: {} }, { reqFile: "/tmp/req.json" })).not.toContain("--pushed-by")
  })

  it("only to an engine that records them: an older one refuses the flags", async () => {
    const caps = (features: string[]) => async () => ({ features: new Set(features), source: "engine" as const })
    expect(await auditWhenSupported(process.cwd(), caps(["push_audit"]))).toMatchObject({ pushed_via: "cli" })
    expect(await auditWhenSupported(process.cwd(), caps([]))).toBeUndefined()
    const failing = async () => Promise.reject(new Error("no engine"))
    expect(await auditWhenSupported(process.cwd(), failing)).toBeUndefined()
  })
})
