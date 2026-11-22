import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { loadProjectLink } from "../src/link.js"
import { tempProject } from "./support/command-run.js"

/**
 * FF-3: `supatype link --url` named the server's project by this folder's `project.name`, so a
 * second folder was refused `Unknown project ref: <folder name>` until it took the server's name,
 * and then `generate` and `dev` refused it as the same stack as the server's own folder. The
 * server says which project it serves (`GET /platform/v1/project`); the link uses that.
 */
const URL_OF_SERVER = "http://selfhost.example.test"
const SERVER_REF = "the-servers-own-name"

const { runLinkAction } = await import("../src/commands/link-helpers.js")
let project: { dir: string; remove: () => void }
let paths: string[] = []

/** The control plane: serves only SERVER_REF, as assertProject does, and says so at /project. */
function controlPlane(answerProject: boolean) {
  return async (url: string): Promise<Response> => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    if (path === "/platform/v1/project") {
      return answerProject ? Response.json({ data: { ref: SERVER_REF } }) : Response.json({ error: "not_found" }, { status: 404 })
    }
    if (path === `/platform/v1/projects/${SERVER_REF}/status`) return Response.json({ data: { projectRef: SERVER_REF } })
    return Response.json({ error: "not_found", message: `Unknown project ref` }, { status: 404 })
  }
}

beforeEach(() => {
  project = tempProject("link-self-host-ref")
  scaffold(project.dir, defaultScaffoldOptions("lk"))
  vi.spyOn(process, "cwd").mockReturnValue(project.dir)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  paths = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  project.remove()
})

describe("supatype link --url", () => {
  it("links to the project the server says it serves, whatever this folder is called", async () => {
    vi.stubGlobal("fetch", controlPlane(true))
    await runLinkAction({ apiUrl: "https://api.supatype.com", url: URL_OF_SERVER, token: "key" })
    expect(loadProjectLink(project.dir)?.projectRef).toBe(SERVER_REF)
  })

  it("an older server with no /project answer is probed by the folder's name, as before", async () => {
    vi.stubGlobal("fetch", controlPlane(false))
    await expect(runLinkAction({ apiUrl: "https://api.supatype.com", url: URL_OF_SERVER, token: "key" })).rejects.toThrow()
    expect(paths).toContain("/platform/v1/projects/lk/status")
  })
})
