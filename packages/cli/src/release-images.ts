/**
 * The exact images a CLI release runs, and the binary versions it downloads, when a project names
 * none: never `:latest`.
 *
 * `:latest` moved under stacks that had not changed, and a machine holding an old `:latest` ran it
 * without pulling. Now:
 *  - the engine, server and Postgres, built in other repositories, are the releases pinned in
 *    release/images.json (generated into ./generated/release-images.ts), which the release train
 *    tested and `scripts/pin.sh check` verified before the release published;
 *  - Studio, storage, realtime, functions-worker and the control plane, built here, carry the CLI's
 *    own version, which the release workflow publishes them under.
 *
 * Only a release has images of its own version. A release build is one `scripts/set-version.mjs`
 * stamped (the release workflows do, a source checkout does not) with a version that is not a
 * `-dev` or `-local` build; any other build runs `:latest` for the five in-repo images and still the
 * exact pins for the other three. Config `versions` pins and `SUPATYPE_*_IMAGE` still win over all
 * of this.
 */
import { EMBEDDED_CLI_VERSION } from "./cli-version-embedded.js"
import type { Component } from "./components.js"
import { PINNED_IMAGES } from "./generated/release-images.js"

export type PinnedComponent = keyof typeof PINNED_IMAGES

/** The images built in this repository, published under the CLI's version. */
type InRepoImage = "studio" | "storage" | "realtime" | "functions-worker" | "control-plane"

type ReleaseImageName = PinnedComponent | InRepoImage

function isPinnedComponent(component: string): component is PinnedComponent {
  return Object.hasOwn(PINNED_IMAGES, component)
}

/** Whether a stamped CLI version has images of its own on Docker Hub. */
export function isReleaseVersion(version: string): boolean {
  return version !== "" && !/-(?:dev|local)\b/.test(version)
}

function pinnedImage(component: PinnedComponent): string {
  return `${PINNED_IMAGES[component].image}:${PINNED_IMAGES[component].tag}`
}

/** Every Supatype image, by name, for a CLI of `version` (empty: not stamped by a release). */
export function releaseImages(version: string = EMBEDDED_CLI_VERSION): Record<ReleaseImageName, string> {
  const tag = isReleaseVersion(version) ? version : "latest"
  const own = (name: InRepoImage): string => `supatype/${name}:${tag}`
  return {
    engine: pinnedImage("engine"),
    server: pinnedImage("server"),
    postgres: pinnedImage("postgres"),
    studio: own("studio"),
    storage: own("storage"),
    realtime: own("realtime"),
    "functions-worker": own("functions-worker"),
    "control-plane": own("control-plane"),
  }
}

/** The images this CLI runs when nothing names one. */
export const RELEASE_IMAGES = releaseImages()

/** A pinned component's version as the CDN and `versions` spell it: the tag without its `v`. */
export function pinnedComponentVersion(component: PinnedComponent): string {
  return PINNED_IMAGES[component].tag.replace(/^v/, "")
}

/**
 * The binary version `supatype dev` downloads for a component the project does not pin, or
 * undefined to ask the CDN for its latest (Deno, which has its own pin, and realtime in a build
 * that is not a release, whose own version was never published).
 */
export function defaultComponentVersion(component: Component, version: string = EMBEDDED_CLI_VERSION): string | undefined {
  if (isPinnedComponent(component)) return pinnedComponentVersion(component)
  if (component === "realtime" && isReleaseVersion(version)) return version
  return undefined
}
