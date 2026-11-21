import { describe, expect, it } from "vitest"
import { runTimedStep, spinnerStepView } from "../src/init-setup-steps.js"

/** S-20: a failed dependency install ended its spinner with `Dependency install failed` under the success tick. */
describe("runTimedStep outcome", () => {
  function recorded(): { stops: { text: string; ok: boolean | undefined }[]; view: ReturnType<typeof spinnerStepView> } {
    const stops: { text: string; ok: boolean | undefined }[] = []
    const view = spinnerStepView({ start: () => undefined, stop: (text, ok) => stops.push({ text, ok }) })
    return { stops, view }
  }

  it("ends a step that answered false as a failure, not with the success tick", async () => {
    const { stops, view } = recorded()
    await runTimedStep(view, { label: "Installing", run: async () => false, done: (ok) => (ok ? "Installed" : "Dependency install failed") })
    expect(stops).toHaveLength(1)
    expect(stops[0]?.text).toContain("Dependency install failed")
    expect(stops[0]?.ok).toBe(false)
  })

  it("ends a step that threw as a failure", async () => {
    const { stops, view } = recorded()
    await expect(runTimedStep(view, { label: "Installing", run: async () => { throw new Error("x") }, done: () => "Installed" })).rejects.toThrow("x")
    expect(stops[0]?.ok).toBe(false)
  })

  it("ends a step that succeeded as a success", async () => {
    const { stops, view } = recorded()
    await runTimedStep(view, { label: "Installing", run: async () => true, done: () => "Installed" })
    expect(stops[0]?.ok).not.toBe(false)
  })
})
