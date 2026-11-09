import { describe, expect, it } from "vitest"
import { createClackApi } from "../src/ui/clack-api.js"
import type { FlowController, FlowLogLine } from "../src/ui/flows/types.js"

/** A controller that keeps what it is asked to show. */
function recorder(): { controller: FlowController; lines: FlowLogLine[] } {
  const lines: FlowLogLine[] = []
  const controller: FlowController = {
    appendLog: (level, text) => lines.push({ level, text }),
    setSpinner: () => undefined,
    waitForPrompt: async () => undefined,
    finish: async () => undefined,
  }
  return { controller, lines }
}

describe("a flow's spinner", () => {
  // The round 6 run: push printed "Schema pushed." above "Applying schema via Docker Compose".
  it("keeps its message above the lines the work it covers logs", () => {
    const { controller, lines } = recorder()
    const api = createClackApi(controller)
    const spinner = api.spinner()
    spinner.start("Applying schema via Docker Compose")
    api.log.info("Schema pushed.")
    spinner.stop("Applying schema via Docker Compose")
    expect(lines.map((line) => line.text)).toEqual(["Applying schema via Docker Compose", "Schema pushed."])
  })

  it("logs its done line once when the work logged nothing", () => {
    const { controller, lines } = recorder()
    const api = createClackApi(controller)
    const spinner = api.spinner()
    spinner.start("Computing diff")
    spinner.stop("Computing diff")
    expect(lines).toEqual([{ level: "success", text: "Computing diff" }])
  })

  it("still logs a done line that says something new", () => {
    const { controller, lines } = recorder()
    const api = createClackApi(controller)
    const spinner = api.spinner()
    spinner.start("Starting")
    api.note("a line")
    spinner.stop("Failed")
    expect(lines.map((line) => line.text)).toEqual(["Starting", "a line", "Failed"])
  })
})
