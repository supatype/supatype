/**
 * Read and change one `versions` pin in a project config file's source, touching real code only.
 *
 * `supatype init` writes a commented example (`// versions: { ... postgres: "17.2" ... }`) above
 * where a real block goes. `update` used to replace the first `postgres: "..."` in the file, which
 * was that comment, and then said the config was updated while the real pin was unchanged. Read
 * through the parser `supatype app` already edits the config with, a comment is never code.
 */
import { Node, Project, type NoSubstitutionTemplateLiteral, type ObjectLiteralExpression, type StringLiteral } from "ts-morph"
import { getRootConfigObject } from "./app-config.js"

/** What a file's exported config holds for one pin, or that its exported config cannot be found. */
type PinLookup =
  | { kind: "missing" }
  | { kind: "computed" }
  | { kind: "unreadable" }
  | { kind: "literal"; node: StringLiteral | NoSubstitutionTemplateLiteral }

/**
 * What {@link withPinnedVersion} found: the file with the pin changed, the pin already at that
 * version, no such pin in it (it is in a comment only, or not there at all), a pin built in code,
 * or no exported config it can read.
 */
export type PinEdit = Exclude<PinLookup, { kind: "literal" }> | { kind: "edited"; text: string } | { kind: "current" }

/** `text` with `versions.<key>` set to `to`, or why it is not changed. */
export function withPinnedVersion(text: string, key: string, to: string): PinEdit {
  const pin = findPin(text, key)
  if (pin.kind !== "literal") return pin
  if (pin.node.getLiteralValue() === to) return { kind: "current" }
  // Inside the quotes, so the file keeps the quote style it was written with.
  return { kind: "edited", text: text.slice(0, pin.node.getStart() + 1) + to + text.slice(pin.node.getEnd() - 1) }
}

/**
 * Whether `text`'s exported config sets `versions.<key>`: as a string or in code ("set"), not at
 * all ("unset"), or "unreadable" when its exported config cannot be found, which may set it.
 */
export function pinState(text: string, key: string): "set" | "unset" | "unreadable" {
  const pin = findPin(text, key)
  if (pin.kind === "unreadable") return "unreadable"
  return pin.kind === "missing" ? "unset" : "set"
}

function findPin(text: string, key: string): PinLookup {
  const source = new Project({ useInMemoryFileSystem: true }).createSourceFile("supatype.config.ts", text)
  let root: ObjectLiteralExpression
  try {
    root = getRootConfigObject(source)
  } catch {
    return { kind: "unreadable" }
  }
  const versions = propertyValue(root, "versions")
  if (versions === undefined) return { kind: "missing" }
  if (!Node.isObjectLiteralExpression(versions)) return { kind: "computed" }
  const pin = propertyValue(versions, key)
  if (pin === undefined) return { kind: "missing" }
  if (Node.isStringLiteral(pin) || Node.isNoSubstitutionTemplateLiteral(pin)) return { kind: "literal", node: pin }
  return { kind: "computed" }
}

/** The value of `object`'s `key: value` entry, whether the key is written bare or quoted. */
function propertyValue(object: ObjectLiteralExpression, key: string): Node | undefined {
  for (const property of object.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue
    const name = property.getNameNode()
    const written = Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText()
    if (written === key) return property.getInitializer()
  }
  return undefined
}
