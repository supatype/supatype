/**
 * The model hook events, in one module with no imports, so the schema extractor and the hook
 * generators can share them without the extractor loading the generators' dependencies.
 */

/** Every event a model's `hooks` may declare. */
export const HOOK_EVENTS = ["beforeChange", "afterChange", "beforeDelete", "afterDelete"] as const

/** The after-hook events, the only ones `columns` applies to. */
export type AfterHookEvent = "afterChange" | "afterDelete"

/** Whether a hook event runs after the write, from the change log, rather than before it. */
export function isAfterHookEvent(event: string): event is AfterHookEvent {
  return event === "afterChange" || event === "afterDelete"
}
