import type * as ComposeRenderMode from "../../src/compose-render-mode.js"

type RenderModeModule = typeof ComposeRenderMode

/** A probe for a machine where no project stack runs and no dev session holds the folder. */
const NO_STACK: ComposeRenderMode.ComposeRenderModeProbe = {
  devSessionLocked: () => false,
  runningServerMode: () => undefined,
}

/**
 * `compose-render-mode` with the Docker question answered "nothing runs". The live probe runs
 * `docker ps`, which a CI runner with no Docker cannot answer, and which on a developer machine
 * answers with whatever that machine happens to be running. Use it from a `vi.mock` factory:
 *
 *   vi.mock("../src/compose-render-mode.js", async (importOriginal) =>
 *     (await import("./support/no-running-stack.js")).withNoRunningStack(await importOriginal()))
 */
export function withNoRunningStack(actual: RenderModeModule): RenderModeModule {
  return {
    ...actual,
    runningStackMode: (cwd, name) => actual.runningStackMode(cwd, name, NO_STACK),
    composeRenderMode: (cwd, name) => actual.composeRenderMode(cwd, name, NO_STACK),
    composeRenderOptions: (cwd, name) => actual.composeRenderOptions(cwd, name, NO_STACK),
  }
}
