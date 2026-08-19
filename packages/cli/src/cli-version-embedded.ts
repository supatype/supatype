/**
 * CLI version, baked in at publish by scripts/set-version.mjs.
 *
 * The standalone binary cannot read its own package.json: pkg carries only files it can
 * find by static analysis, and that path is assembled at runtime, so `--version` inside a
 * published binary would answer 0.0.0 without this. Empty in a source checkout, where
 * cliPackageVersion() falls back to reading package.json.
 */
// Annotated `string`, not left to inference: once a release stamps a value here, the
// inferred literal type makes the `!== ""` test in cliPackageVersion() a compile error
// (TS2367, no overlap), so the build would only fail during a release.
export const EMBEDDED_CLI_VERSION: string = ""
