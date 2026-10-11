import { createWorld } from "./lib/world.js"

/** One account per person on the stack under test, before any spec runs. */
export default async function globalSetup(): Promise<void> {
  await createWorld()
}
