import { describe, expect, it } from "vitest"
import { devReadyPanelCompactRowCount, devReadyPanelRowCount } from "../src/dev-ready-panel.js"

describe("devReadyPanelRowCount", () => {
  it("accounts for border, keys block, and hints", () => {
    const rows = devReadyPanelRowCount({
      title: "Services running",
      links: [
        { label: "API", url: "http://localhost:1" },
        { label: "Studio", url: "http://localhost:1/studio/" },
      ],
      hints: ["Demo data: pnpm seed"],
      anonKey: "anon-jwt",
      serviceRoleKey: "svc-jwt",
    })

    // border(2) + title(1) + links(2) + hint(1) + keys header(1) + anon(1) + svc(1) + margin(1)
    expect(rows).toBe(10)
  })
})

describe("devReadyPanelCompactRowCount", () => {
  it("uses a shorter layout than the full panel", () => {
    const panel = {
      title: "Services running",
      links: [
        { label: "API", url: "http://localhost:1" },
        { label: "REST", url: "http://localhost:1/rest/v1/" },
        { label: "Studio", url: "http://localhost:1/studio/" },
      ],
      hints: ["Demo data: pnpm seed"],
      anonKey: "anon-jwt",
      serviceRoleKey: "svc-jwt",
    }
    expect(devReadyPanelCompactRowCount(panel)).toBeLessThan(devReadyPanelRowCount(panel))
  })
})
