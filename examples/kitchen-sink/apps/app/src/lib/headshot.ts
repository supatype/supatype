import type { TableRow } from "@supatype/client"
import { supatype } from "../client.js"

/**
 * A speaker's photo, sized for an avatar `size` pixels across.
 *
 * The `headshot` column is an `ImageAsset`, which stores `{ bucket, path }` and never a URL, so the
 * URL is rebuilt from the reference. `speaker-headshots` is a public bucket, so nothing is signed.
 * It is transformed on read to twice the avatar's size, square and webp, which keeps a sharp image
 * on a high-density screen without sending the original upload.
 *
 * Both screens that show a speaker call this; they previously each read a `url` field off the
 * column that is never there, so every photo rendered as initials.
 */
export function headshotUrl(speaker: Pick<TableRow<"speaker">, "headshot">, size: number): string | null {
  return supatype.storage.publicUrl(speaker.headshot, {
    transform: { width: size * 2, height: size * 2, format: "webp", resize: "cover" },
  })
}
