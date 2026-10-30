/**
 * Pulling a compose stack's images for `supatype update`, and saying which could not be pulled.
 *
 * `update` used to pull with `--ignore-pull-failures` whenever the project might use an image built
 * on this machine. Compose then exits 0 whatever failed, so pulls ending "not found" were followed
 * by "Compose images updated." and exit 0 (local test N6). The pull now runs without it, and when
 * it fails each service is pulled again on its own to learn which did.
 *
 * Only then: the services and their images come from `docker compose config`, a second pass over
 * the whole file, which a pull that worked has no use for. The services pulled again are pulled side
 * by side, since each waits on a registry.
 */
import type { ServiceImage } from "./compose-services.js"
import { isRegistryPullableImageRef } from "./self-host-compose.js"

/** What {@link pullServiceImages} asks of Docker. */
export interface ImagePullSteps {
  /** `docker compose pull` for every service, shown as it runs; its exit status. */
  pullAll: () => number
  /** Each service and the image it runs, as compose resolves the file. */
  images: () => Promise<ServiceImage[]>
  /** `docker compose pull` for one service, quietly: whether it worked, and what it said when not. */
  pullOne: (service: string) => Promise<{ ok: boolean; said: string }>
  /** Whether Docker has `image` on this machine. */
  hasLocal: (image: string) => boolean
}

/** A service whose image was not pulled, and what Docker said about it. */
export interface FailedPull extends ServiceImage {
  said: string
}

/** The services whose images were not pulled, by what that means. */
export interface ImagePulls {
  /** Not pulled, and nothing this machine has stands in for it. */
  failed: FailedPull[]
  /** A tag no registry has and this machine does: an image built here, used as it is. */
  keptLocal: ServiceImage[]
}

/** Pull every image; those that could not be pulled. */
export async function pullServiceImages(steps: ImagePullSteps): Promise<ImagePulls> {
  const pulls: ImagePulls = { failed: [], keptLocal: [] }
  if (steps.pullAll() === 0) return pulls
  // Compose gives one exit status for the lot, so each is asked again on its own. What did pull
  // the first time is current now, and pulling it again costs a manifest check.
  const images = await steps.images()
  const again = await Promise.all(images.map(async (one) => ({ one, ...(await steps.pullOne(one.service)) })))
  for (const { one, ok, said } of again) {
    if (ok) continue
    if (!isRegistryPullableImageRef(one.image) && steps.hasLocal(one.image)) pulls.keptLocal.push(one)
    else pulls.failed.push({ ...one, said })
  }
  return pulls
}

/** What to do about an image that could not be pulled. */
export function imagePullAdvice(one: ServiceImage): string {
  return isRegistryPullableImageRef(one.image)
    ? "Check that each image named exists on its registry and that Docker can reach it, then run `supatype update` again."
    : `${one.image} is on no registry and not on this machine: build it, or remove its tag from .env to use the published image.`
}
