import { describe, expect, it, vi } from "vitest"

/**
 * Pre-push review: `docker compose config --format json` answering something that is not JSON (an
 * older compose, a warning on stdout) threw a bare SyntaxError from JSON.parse, naming nothing.
 */
const answer = vi.hoisted(() => ({ stdout: "" }))

vi.mock("../src/docker-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-exec.js")>()),
  askDocker: async () => ({ status: 0, stdout: answer.stdout, stderr: "", timedOut: false, missing: false }),
}))

const { composeServiceImages } = await import("../src/compose-services.js")
const ctx = { composePath: "/p/.supatype/self-host/docker-compose.yml", projectRoot: "/p", projectName: "supatype-p" }

describe("composeServiceImages", () => {
  it("names the compose file when compose does not answer with JSON", async () => {
    answer.stdout = "WARN[0000] the attribute `version` is obsolete\nservices:\n  db: {}\n"
    await expect(composeServiceImages(ctx)).rejects.toThrow(/docker-compose\.yml.*not JSON/)
  })

  it("reads each service's image from a JSON answer", async () => {
    answer.stdout = JSON.stringify({ services: { db: { image: "supatype/postgres:17" }, api: {} } })
    await expect(composeServiceImages(ctx)).resolves.toEqual([{ service: "db", image: "supatype/postgres:17" }])
  })
})
