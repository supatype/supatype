/** Windows fires several events per save; one call covers them all. */
export const SAVE_BURST_MS = 300

/**
 * `fn` called once, `ms` after the last `trigger` of a burst. `cancel` drops a call still waiting,
 * for a watcher being closed.
 */
export function debounce(fn: () => void, ms: number = SAVE_BURST_MS): { trigger: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const trigger = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
  }
  return { trigger, cancel }
}
