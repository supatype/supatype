/**
 * Pulling a compose stack's images for `supatype update`, and saying which could not be pulled.
 *
 * `update` used to pull with `--ignore-pull-failures` whenever the project might use an image built
 * on this machine. Compose then exits 0 whatever failed, so pulls ending "not found" were followed
 * by "Compose images updated." and exit 0 (local test N6). The pull now runs without it, and when
 * it fails each service is pulled again on its own to learn which did.
 */
import type { ServiceImage } from "./compose-services.js"
import { isRegistryPullableImageRef } from "./self-host-compose.js"

/** What {@link pullServiceImages} asks of Docker. */
export interface ImagePullSteps {
  /** `docker compose pull` for `services`, quietly when `quiet`; its exit status. */
  pull: (services: readonly string[], quiet: boolean) => number
  /** Whether Docker has `image` on this machine. */
  hasLocal: (image: string) => boolean
}

/** The services whose images were not pulled, by what that means. */
export interface ImagePulls {
  /** Not pulled, and nothing this machine has stands in for it. */
  failed: ServiceImage[]
  /** A tag no registry has and this machine does: an image built here, used as it is. */
  keptLocal: ServiceImage[]
}

/** Pull every image; those that could not be pulled. */
export function pullServiceImages(images: readonly ServiceImage[], steps: ImagePullSteps): ImagePulls {
  if (images.length === 0 || steps.pull(images.map((one) => one.service), false) === 0) {
    return { failed: [], keptLocal: [] }
  }
  // Compose gives one exit status for the lot, so each is asked again on its own. What did pull
  // the first time is current now, and pulling it again costs a manifest check.
  const pulls: ImagePulls = { failed: [], keptLocal: [] }
  for (const one of images.filter((image) => steps.pull([image.service], true) !== 0)) {
    const builtHere = !isRegistryPullableImageRef(one.image) && steps.hasLocal(one.image)
    ;(builtHere ? pulls.keptLocal : pulls.failed).push(one)
  }
  return pulls
}

/** What to do about an image that could not be pulled. */
export function imagePullAdvice(one: ServiceImage): string {
  return isRegistryPullableImageRef(one.image)
    ? "Check that each image named exists on its registry and that Docker can reach it, then run `supatype update` again."
    : `${one.image} is on no registry and not on this machine: build it, or remove its tag from .env to use the published image.`
}
