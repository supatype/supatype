import { describe, expect, it } from "vitest"
import { mergeSupatypePackageJson } from "../src/init-package-json.js"

describe("mergeSupatypePackageJson", () => {
  it("adds Supatype deps and scripts without overwriting existing dev script", () => {
    const merged = mergeSupatypePackageJson(
      { name: "existing", scripts: { dev: "next dev" } },
      { projectName: "existing", app: { mode: "none" }, helloFunction: false },
      { cli: "0.1.1", types: "0.1.1" },
    )

    expect(merged.dependencies?.["@supatype/cli"]).toBe("^0.1.1")
    expect(merged.dependencies?.["@supatype/types"]).toBe("^0.1.1")
    expect(merged.scripts?.dev).toBe("next dev")
    expect(merged.scripts?.["supatype:dev"]).toBe("supatype dev")
    expect(merged.scripts?.push).toBe("supatype push")
  })
})
