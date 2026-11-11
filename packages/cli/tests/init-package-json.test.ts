import { describe, expect, it } from "vitest"
import semver from "semver"
import { mergeSupatypePackageJson, PREPARE_COMMAND, scaffoldPackageJson } from "../src/init-package-json.js"

const DEPS = { cli: "0.1.1", types: "0.1.1", client: "0.1.1" }
const NO_APP = { projectName: "existing", app: { mode: "none" }, helloFunction: false }
/** `raised` allows no client below `floor`, and nothing `listed` did not, unless it is `^floor`. */
function expectRaised(raised: string | undefined, listed: string, floor: string): void {
  expect(raised).toBeDefined()
  const lowest = semver.minVersion(raised ?? "")
  expect(lowest !== null && semver.gte(lowest, floor), `${raised} starts below ${floor}`).toBe(true)
  if (raised !== `^${floor}`) expect(semver.subset(raised ?? "", listed), `${raised} widens ${listed}`).toBe(true)
}

const VITE_APP = { projectName: "existing", app: { mode: "static", viteDevUrl: "http://127.0.0.1:5173" }, helloFunction: false }

describe("mergeSupatypePackageJson", () => {
  it("adds Supatype deps and scripts without overwriting existing dev script", () => {
    const merged = mergeSupatypePackageJson({ name: "existing", scripts: { dev: "next dev" } }, NO_APP, DEPS)

    expect(merged.scripts?.dev).toBe("next dev")
    expect(merged.scripts?.["supatype:dev"]).toBe("supatype dev")
    expect(merged.scripts?.push).toBe("supatype push")
  })

  // The same split a new project gets: in dependencies, `npm install --omit=dev` installed the CLI
  // into every production build of the app.
  it("adds the CLI and types as development dependencies", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.devDependencies?.["@supatype/cli"]).toBe("^0.1.1")
    expect(merged.devDependencies?.["@supatype/types"]).toBe("^0.1.1")
    expect(merged.dependencies?.["@supatype/cli"]).toBeUndefined()
    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.1.1")
  })

  it("leaves the CLI where a project already lists it", () => {
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/cli": "0.0.9" } }, NO_APP, DEPS)

    expect(merged.dependencies?.["@supatype/cli"]).toBe("0.0.9")
    expect(merged.devDependencies?.["@supatype/cli"]).toBeUndefined()
  })

  // `tsx seed.ts` loaded the seed module without calling the function it exports.
  it("runs seeds the way a new project does", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.scripts?.seed).toBe("supatype seed")
  })

  // `prepare` runs on a production install too, so the client, whose bin it is, must be installed there.
  it("generates on install, as a new project does", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.scripts?.prepare).toBe(PREPARE_COMMAND)
    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.1.1")
  })

  // A production install leaves development dependencies out, and `supatype-prepare` with them.
  it("moves @supatype/client into dependencies, keeping a range new enough", () => {
    const merged = mergeSupatypePackageJson({ devDependencies: { "@supatype/client": "^0.6.0" } }, NO_APP, DEPS)

    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.6.0")
    expect(merged.devDependencies?.["@supatype/client"]).toBeUndefined()
  })

  // A client older than the one init picks may predate `supatype-prepare`, and fail every install.
  it.each(["^0.0.9", "0.1.0", "~0.1.0", ">=0.0.1", "^0.1", "0.x", "*", "x", "v0.0.6", "<0.9.0", "^1.0.0 || ^0.1.0"])(
    "raises a @supatype/client range of %s",
    (range) => {
      const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/client": range } }, NO_APP, DEPS)

      expectRaised(merged.dependencies?.["@supatype/client"], range, "0.1.1")
    },
  )

  // An older CLI than the project's client raises the lower end only: the project keeps its 0.12.
  it("raises a @supatype/client range without moving the project down to the floor", () => {
    const older = { ...DEPS, client: "0.9.0" }
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/client": ">=0.5.0" } }, NO_APP, older)
    const range = merged.dependencies?.["@supatype/client"] ?? ""

    expect(semver.satisfies("0.12.0", range)).toBe(true)
    expect(semver.satisfies("0.8.0", range)).toBe(false)
  })

  it.each(["^0.0.9", "0.1.0", "<0.1.0"])("sets a @supatype/client range of %s, with nothing at the floor, to ^floor", (range) => {
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/client": range } }, NO_APP, DEPS)

    expect(merged.dependencies?.["@supatype/client"]).toBe("^0.1.1")
  })

  it.each([
    "workspace:*",
    "file:../client",
    "../client",
    "~/client",
    "owner/supatype-client",
    "git@github.com:me/client.git",
    "latest",
    "^0.2.0",
    "^0.2",
    "~1",
    ">= 0.2.0",
    ">=0.2.0 <1.0.0",
    "0.2.0 - 0.3.0",
    "^0.2.0 || ^0.3.0",
    ">0.2.0",
    "<2 >=0.2",
    "0.2.0+build",
  ])("keeps a @supatype/client range of %s", (range) => {
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/client": range } }, NO_APP, DEPS)

    expect(merged.dependencies?.["@supatype/client"]).toBe(range)
  })

  // A pre-release lower bound allows that pre-release, which may predate what its release has.
  it.each([
    ["^0.8.0-rc.1", "0.8.0"],
    [">=0.8.0-0", "0.8.0"],
    ["^0.8.0-rc.0", "0.8.0-rc.2"],
  ])("raises a @supatype/client range of %s below %s", (range, floor) => {
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/client": range } }, NO_APP, { ...DEPS, client: floor })

    expectRaised(merged.dependencies?.["@supatype/client"], range, floor)
  })

  it.each(["^0.9.0", "^0.8.0-rc.2"])("keeps a @supatype/client range of %s above a pre-release init picked", (range) => {
    const rc = { ...DEPS, client: "0.8.0-rc.1" }
    const merged = mergeSupatypePackageJson({ dependencies: { "@supatype/client": range } }, NO_APP, rc)

    expect(merged.dependencies?.["@supatype/client"]).toBe(range)
  })

  // The `prepare` earlier releases wrote failed every production install with `supatype: not found`.
  it("replaces the prepare earlier releases wrote", () => {
    const earlier = mergeSupatypePackageJson({ scripts: { prepare: "supatype generate" } }, NO_APP, DEPS)

    expect(earlier.scripts?.prepare).toBe(PREPARE_COMMAND)
  })

  // A project's own prepare (husky, say) was kept as it was, so a fresh clone never generated the
  // gitignored seed builder. The command runs after it, once.
  it("chains supatype-prepare after a prepare of the project's own", () => {
    const own = mergeSupatypePackageJson({ scripts: { prepare: "husky" } }, NO_APP, DEPS)

    expect(own.scripts?.prepare).toBe(`husky && ${PREPARE_COMMAND}`)
  })

  it("leaves prepare as it is on a re-run, or when it already generates", () => {
    const once = mergeSupatypePackageJson({ scripts: { prepare: "husky" } }, NO_APP, DEPS)
    const twice = mergeSupatypePackageJson(once, NO_APP, DEPS)
    const generates = mergeSupatypePackageJson({ scripts: { prepare: "husky && supatype generate" } }, NO_APP, DEPS)

    expect(twice.scripts?.prepare).toBe(once.scripts?.prepare)
    expect(generates.scripts?.prepare).toBe("husky && supatype generate")
  })

  it("sets a version only when the project has none", () => {
    expect(mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS).version).toBe("0.1.0")
    expect(mergeSupatypePackageJson({ name: "existing", version: "3.2.1" }, NO_APP, DEPS).version).toBe("3.2.1")
  })

  it("keeps the project's own scripts, in their order, ahead of the ones it adds", () => {
    const merged = mergeSupatypePackageJson({ scripts: { prepare: "husky", build: "tsc" } }, VITE_APP, DEPS)

    expect(merged.scripts?.prepare).toBe(`husky && ${PREPARE_COMMAND}`)
    expect(merged.scripts?.build).toBe("tsc")
    expect(Object.keys(merged.scripts ?? {}).slice(0, 2)).toEqual(["prepare", "build"])
  })

  // The CLI's program runs the project's TypeScript itself, so tsx only took up space in every app.
  it("adds TypeScript but not tsx", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, NO_APP, DEPS)

    expect(merged.devDependencies?.typescript).toBe("^5")
    expect(merged.devDependencies?.tsx).toBeUndefined()
  })

  it("adds Vite 8 and a build for a Vite app", () => {
    const merged = mergeSupatypePackageJson({ name: "existing" }, VITE_APP, DEPS)

    expect(merged.devDependencies?.vite).toBe("^8")
    expect(merged.scripts?.build).toBe("vite build")
  })
})

describe("scaffoldPackageJson", () => {
  it("writes the same scripts and dependencies a merge adds", () => {
    const written: unknown = JSON.parse(scaffoldPackageJson(VITE_APP, DEPS))
    const merged = mergeSupatypePackageJson({}, VITE_APP, DEPS)

    expect(written).toMatchObject({ scripts: merged.scripts, devDependencies: merged.devDependencies, version: "0.1.0" })
  })
})

