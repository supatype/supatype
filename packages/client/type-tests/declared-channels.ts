/**
 * What generated code does to the client's channel names, checked in a project of its own.
 *
 * This file augments `SupatypeChannels` the way `supatype generate` does, so it must not share a
 * TypeScript project with the other tests: there `ChannelName` has to stay a plain string. It is
 * checked by `tsc --project type-tests/tsconfig.json` (part of `pnpm typecheck`), and each
 * `@ts-expect-error` fails that check if the line stops being an error.
 */
import type { DeclaredTopic, RealtimeClient } from "../src/index.js"

declare module "../src/index.js" {
  interface SupatypeChannels {
    "lot:{id}": { params: { id: string } }
    "lobby:*": { params: {} }
    "room:{n}": { params: { n: number } }
  }
}

export const accepted: DeclaredTopic[] = ["lot:abc", "lobby:x", "room:5"]

// @ts-expect-error an Integer parameter takes a number, not words
export const wrongParam: DeclaredTopic = "room:abc"
// @ts-expect-error no declaration has this prefix
export const undeclared: DeclaredTopic = "auction:1"

/** `channel()` offers the declared topics but still takes any string, which an open server admits. */
export function open(realtime: RealtimeClient): void {
  realtime.channel("lot:abc")
  realtime.channel("something:else")
}
