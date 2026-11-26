import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runAppBuild } from "../src/commands/deploy.js"
import { tempProject } from "./support/command-run.js"

/**
 * `deploy` ran the framework's default build (`vite build`) with the shell's PATH, where the app's
 * own `node_modules/.bin` is not, so the build failed with "'vite' is not recognized". A package
 * manager puts those directories on PATH; the build step now does the same, for the app's directory
 * and the workspace root above it.
 */
let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("deploy-build-bin-path")
})

afterEach(() => project.remove())

/** A `node_modules/.bin` entry named `name` under `dir` that writes `<name>.ran` in its working directory. */
function addBin(dir: string, name: string): void {
  const bin = join(dir, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\necho ran> ${name}.ran\r\n`)
  const posix = join(bin, name)
  writeFileSync(posix, `#!/bin/sh\necho ran > ${name}.ran\n`)
  chmodSync(posix, 0o755)
}

/** The app's `directory` with a build command, in a workspace whose root is `project.dir`. */
function app(buildCommand: string): { directory: string; buildCommand: string } {
  const directory = join(project.dir, "web")
  mkdirSync(directory, { recursive: true })
  return { directory, buildCommand }
}

/**
 * The environment a user's shell has, minus the relative PATH entries a test runner adds (`pnpm exec`
 * adds `./node_modules/.bin`, which the build's own working directory would then resolve).
 */
function shellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== "PATH") continue
    env[key] = (env[key] ?? "").split(delimiter).filter((entry) => isAbsolute(entry)).join(delimiter)
  }
  return env
}

describe("runAppBuild", () => {
  it("finds a binary in the app directory's node_modules/.bin", () => {
    const config = app("appbin build")
    addBin(config.directory, "appbin")
    runAppBuild(config, shellEnv())
    expect(existsSync(join(config.directory, "appbin.ran"))).toBe(true)
  })

  it("finds a binary in the workspace root's node_modules/.bin", () => {
    const config = app("rootbin build")
    addBin(project.dir, "rootbin")
    runAppBuild(config, shellEnv())
    expect(existsSync(join(config.directory, "rootbin.ran"))).toBe(true)
  })
})
