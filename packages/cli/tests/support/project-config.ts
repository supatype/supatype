import type { SupatypeProjectConfig } from "../../src/project-config.js"

/**
 * A project config as `loadProjectConfig` hands it over: the four sections `validateProjectConfig`
 * requires (project, database, server, app), with `over` replacing whole sections on top.
 *
 * Tests used to cast a partial literal to the config type, which let a section the code under test
 * reads go missing without the compiler saying so. Building from here keeps every fixture a config
 * the loader could actually return.
 */
export function projectConfig(over: Partial<SupatypeProjectConfig> = {}): SupatypeProjectConfig {
  return {
    project: { name: "demo" },
    database: {},
    server: { mode: "dev" },
    app: { mode: "none" },
    ...over,
  }
}
