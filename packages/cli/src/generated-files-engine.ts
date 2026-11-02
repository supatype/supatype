/**
 * The engine that writes a project's generated files (the types, the client's seed builder, the
 * admin config): `supatype generate` and Docker dev's refresh after a push both ask here.
 *
 * The host engine program, resolved as push resolves the one it writes types with: the pin, else
 * this build's default, or `overrides.engine`. Generating needs no database, and running it in the
 * compose image cost two `docker compose run`s and left the project's network and volume behind
 * (local test round 3, N7). The two used to choose differently, so the types a save wrote and the
 * ones `generate` wrote could come from two engines (decision, round 3).
 *
 * Only a host program that cannot be fetched (`BinaryUnavailable`: offline, a platform or libc with
 * no build) falls back, and only for a Docker project with no engine override, to its own compose
 * engine image. A refusal, an engine too old, or a config error is the answer as it is. A failed
 * fetch is remembered for the process, so an offline dev session does not try the download again
 * on every save, and the caller is told why once, after it has written with the image.
 */
import type { ComposeEngine } from "./engine-client.js"
import { hasEngineOverride, pinnedVersion } from "./binary-cache.js"
import { BinaryUnavailable } from "./ensure-binary.js"
import { errorMessage } from "./error-message.js"
import { resolveRuntimeProvider, type SupatypeProjectConfig } from "./project-config.js"

/** How the engine is found, replaceable in tests. */
export interface GeneratedFilesEngineDeps {
  hostEngine: () => Promise<void>
  composeEngine: (cwd: string, config: SupatypeProjectConfig) => Promise<ComposeEngine | undefined>
}

const DEFAULT_DEPS: GeneratedFilesEngineDeps = {
  hostEngine: async () => (await import("./engine-client.js")).ensureEngine(),
  composeEngine: async (cwd, config) => (await import("./dev-compose.js")).projectComposeEngine(cwd, config),
}

/** The engine to write with (undefined: the host program) and, the first time it fell back, why. */
export interface EngineChoice {
  engine: ComposeEngine | undefined
  fellBack?: string
}

/** What a caller says, once it has written with the image, about the fallback. */
export const ENGINE_FALLBACK = "The engine program could not be fetched, so the project's engine image wrote the generated files"

/** Engine versions whose host program could not be fetched in this process. */
const unavailable = new Set<string>()

/** The engine to write generated files with: see the file's comment. */
export async function generatedFilesEngine(
  cwd: string,
  config: SupatypeProjectConfig,
  deps: Partial<GeneratedFilesEngineDeps> = {},
): Promise<EngineChoice> {
  const use = { ...DEFAULT_DEPS, ...deps }
  const version = pinnedVersion("engine", config) ?? "this build's"
  if (unavailable.has(version)) return { engine: await imageOrThrow(cwd, config, use, undefined) }
  try {
    await use.hostEngine()
    return { engine: undefined }
  } catch (err) {
    if (!(err instanceof BinaryUnavailable) || resolveRuntimeProvider(config) !== "docker" || hasEngineOverride(config)) throw err
    const engine = await imageOrThrow(cwd, config, use, err)
    unavailable.add(version)
    return { engine, fellBack: errorMessage(err) }
  }
}

/** The project's engine image, or an error that keeps the host program's reason beside the image's. */
async function imageOrThrow(
  cwd: string,
  config: SupatypeProjectConfig,
  use: GeneratedFilesEngineDeps,
  hostError: unknown,
): Promise<ComposeEngine> {
  const host = hostError === undefined ? "the engine program could not be fetched earlier" : errorMessage(hostError)
  let image: ComposeEngine | undefined
  try {
    image = await use.composeEngine(cwd, config)
  } catch (err) {
    throw new Error(`${host}; the project's engine image could not be used either: ${errorMessage(err)}`, { cause: err })
  }
  if (image === undefined) throw hostError instanceof Error ? hostError : new Error(host)
  return image
}
