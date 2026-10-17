import type { DeployTarget } from "../../src/resolve-target.js"

/** The target `resolveTarget` returns for `--direct`: the engine run against `databaseUrl`, no server. */
export function directTarget(databaseUrl: string): DeployTarget {
  return {
    mode: "direct",
    environment: "local",
    projectRef: "demo",
    apiBaseUrl: "",
    apiPrefix: "/platform/v1",
    link: null,
    databaseUrl,
  }
}
