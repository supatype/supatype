import type { ChannelChange, DiffResult } from "./engine-client.js"

/**
 * What a diff says about realtime channels, from the engine's `channels` and `realtimeMode` (plan
 * section 8). Said like model rule changes are: what was added, removed, or changed and on which
 * operation. Two changes also get a warning, because each takes something away from clients that
 * work today: removing a declaration under `declared`, and turning `declared` on.
 */

type ChannelDiff = Pick<DiffResult, "channels" | "realtimeMode">

const MARKS: Readonly<Record<ChannelChange["change"], string>> = { added: "+", removed: "-", changed: "~" }

function changeLine(entry: ChannelChange, nameWidth: number): string {
  const head = `  ${MARKS[entry.change]} ${entry.name.padEnd(nameWidth)}  `
  const operations = entry.operations ?? []
  if (entry.change !== "changed" || operations.length === 0) return `${head}${entry.pattern}`.trimEnd()
  return `${head}${entry.pattern}  (${operations.join(", ")} rule changed)`
}

function removalWarnings(channels: readonly ChannelChange[], mode: ChannelDiff["realtimeMode"]): string[] {
  if (mode?.after !== "declared") return []
  return channels
    .filter((entry) => entry.change === "removed")
    .map(
      (entry) =>
        `Removing ${entry.name}: topics matching ${entry.pattern} lose broadcast and presence, because realtime.channels is "declared".`,
    )
}

function modeWarnings(mode: ChannelDiff["realtimeMode"]): string[] {
  if (mode?.before !== "open" || mode.after !== "declared") return []
  return [
    'realtime.channels goes from "open" to "declared": broadcast and presence on a topic no channel declares will be refused.',
    "Check Studio's realtime inspector for live channels that no declaration matches before you push.",
  ]
}

/** The lines a diff prints about channels, none when the engine sent nothing or nothing changed. */
export function formatChannelChanges(result: ChannelDiff): string[] {
  const channels = result.channels ?? []
  const nameWidth = Math.max(0, ...channels.map((entry) => entry.name.length))
  const listed =
    channels.length === 0 ? [] : ["Realtime channels:", ...channels.map((entry) => changeLine(entry, nameWidth))]
  const warnings = [...removalWarnings(channels, result.realtimeMode), ...modeWarnings(result.realtimeMode)]
  return warnings.length === 0 ? listed : [...listed, ...(listed.length > 0 ? [""] : []), ...warnings]
}

/** Print the channel changes, or nothing for an engine that does not send them. */
export function printChannelChanges(result: ChannelDiff): void {
  const lines = formatChannelChanges(result)
  if (lines.length > 0) console.log(`${lines.join("\n")}\n`)
}
