/**
 * The schema engine's service, as the generated compose file describes it and as a run of its image
 * alone repeats it (compose-engine-run.ts). Both read it from here, so the two cannot drift. The
 * environment is the caller's in either: each passes its variables as bare `-e NAME`.
 */
import { RELEASE_IMAGES } from "./release-images.js"

export const ENGINE_SERVICE = {
  /** The variable naming the image, read from the shell, then `.env`. */
  imageVariable: "SUPATYPE_ENGINE_IMAGE",
  /** The image when none is named: the one this CLI release was tested with. */
  defaultImage: RELEASE_IMAGES.engine,
  entrypoint: "supatype-engine",
  /** Where the project is mounted, writable, and where the engine runs. */
  projectDir: "/project",
} as const
