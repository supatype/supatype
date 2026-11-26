import { isRecordOf, isShape, isString } from "@supatype/shared"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { mergeSupatypePackageJson } from "../src/init-package-json.js"
import { parseJsonAs } from "./support/json.js"

/**
 * `index.md` and `frameworks.md` offer "React (Vite)" from `supatype init`, and init had no such
 * choice: a developer ran `npm create vite` first and wrote the page and the provider by hand.
 * The app question now has a React (Vite) answer that scaffolds the starter.
 */

const asked = vi.hoisted(() => ({ answers: new Map<string, unknown>(), options: new Map<string, { options?: { value: string }[] }>() }))

vi.mock("../src/ui/clack.js", () => {
  const answer = (options: { message: string; initialValue?: unknown; defaultValue?: unknown; options?: { value: string }[] }): Promise<unknown> => {
    asked.options.set(options.message, options)
    const scripted = asked.answers.get(options.message)
    return Promise.resolve(scripted !== undefined ? scripted : (options.initialValue ?? options.defaultValue ?? ""))
  }
  return {
    p: { text: answer, select: answer, confirm: answer, password: answer, note: () => undefined, log: { warn: () => undefined } },
    isCancel: () => false,
    CLACK_CANCEL: Symbol.for("cancel"),
  }
})
vi.mock("../src/dev-ports.js", () => ({ promptKongPortChoice: () => Promise.resolve(18473) }))

const VERSIONS = { cli: "0.9.2", types: "0.9.2", client: "0.9.2" }
const REACT_APP = { mode: "proxy", upstream: "http://localhost:5173", start: "vite", viteDevUrl: "http://localhost:5173", react: true } as const

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-init-react-"))
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("init's app question", () => {
  it("offers React (Vite), and answering it gives a Vite proxy app with the React starter", async () => {
    asked.answers = new Map<string, unknown>([["Host a frontend app at /?", "react"], ["Create an admin user for Studio (/studio/)?", false]])
    const { collectWizardAnswers } = await import("../src/commands/init.js")
    const detected = {
      hasExistingFiles: false, hasSupatypeConfig: false, hasVite: false, declaresVite: false, hasViteConfig: false,
      viteDevUrl: "http://localhost:5173", staticDir: "./dist", packageScripts: {}, summaryLines: [],
    }
    const result = await collectWizardAnswers({ defaultName: "acme", defaultTarget: "later", detected, askName: false })
    expect(asked.options.get("Host a frontend app at /?")?.options?.map((o) => o.value)).toContain("react")
    expect(result.app).toMatchObject({ mode: "proxy", viteDevUrl: "http://localhost:5173", start: "vite", react: true })
  })
})

describe("scaffold with the React (Vite) starter", () => {
  it("writes the page, the entry, the app and a Vite config with the React plugin", () => {
    scaffold(dir, { ...defaultScaffoldOptions("react-app"), app: REACT_APP })
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain('<script type="module" src="/src/main.tsx"></script>')
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toContain("<SupatypeProvider client={supatype}>")
    expect(readFileSync(join(dir, "src/supatype.ts"), "utf8")).toContain("import.meta.env.VITE_SUPATYPE_ANON_KEY")
    expect(readFileSync(join(dir, "src/App.tsx"), "utf8")).toContain('<h1>{"react-app"}</h1>')
    const config = readFileSync(join(dir, "vite.config.ts"), "utf8")
    expect(config).toContain('import react from "@vitejs/plugin-react"')
    expect(config).toContain("plugins: [react()],")
  })

  it("adds React and the Supatype React bindings to package.json", () => {
    scaffold(dir, { ...defaultScaffoldOptions("react-app"), app: REACT_APP }, VERSIONS)
    const pkg = parseJsonAs(readFileSync(join(dir, "package.json"), "utf8"), isShape({ dependencies: isRecordOf(isString), devDependencies: isRecordOf(isString) }))
    expect(pkg.dependencies).toMatchObject({ react: "^19", "react-dom": "^19", "@supatype/react": "^0.9.2" })
    expect(pkg.devDependencies).toMatchObject({ "@vitejs/plugin-react": "^6", "@types/react": "^19", "@types/react-dom": "^19" })
  })

  it("leaves every React file out of a plain Vite app", () => {
    scaffold(dir, { ...defaultScaffoldOptions("plain"), app: { ...REACT_APP, react: false } }, VERSIONS)
    expect(existsSync(join(dir, "src/main.tsx"))).toBe(false)
    expect(readFileSync(join(dir, "vite.config.ts"), "utf8")).not.toContain("plugin-react")
    expect(readFileSync(join(dir, "package.json"), "utf8")).not.toContain('"react"')
  })

  it("keeps the React a project already lists when it is merged", () => {
    const merged = mergeSupatypePackageJson(
      { name: "x", dependencies: { react: "^18.3.0" } },
      { projectName: "x", app: { ...REACT_APP }, helloFunction: false },
      VERSIONS,
    )
    expect(merged.dependencies).toMatchObject({ react: "^18.3.0", "react-dom": "^19" })
  })
})
