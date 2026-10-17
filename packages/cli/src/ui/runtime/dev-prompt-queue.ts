/**
 * Imperative prompt queue for the dev dashboard overlay.
 */

import { CLACK_CANCEL } from "./cancel.js"

export type DevPromptKind = "confirm" | "text" | "password" | "select"

export interface DevSelectOption<T extends string = string> {
  value: T
  label: string
  hint?: string
}

/** One queued prompt. Its answer is whatever the prompt view submits; the caller narrows it. */
export interface DevPromptRequest {
  id: number
  kind: DevPromptKind
  message: string
  initialValue?: string | boolean
  defaultValue?: string
  placeholder?: string
  mask?: boolean
  options?: DevSelectOption[]
  validate?: (value: string) => string | undefined
  resolve: (value: unknown) => void
}

let nextId = 0
let active: DevPromptRequest | null = null
const waiters: DevPromptRequest[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeDevPrompts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getActiveDevPrompt(): DevPromptRequest | null {
  return active
}

/** Queue a prompt; resolves with what the view submits, or CLACK_CANCEL. Narrow it with promptAnswer. */
export function enqueueDevPrompt(spec: Omit<DevPromptRequest, "id" | "resolve">): Promise<unknown> {
  return new Promise((resolve) => {
    const request: DevPromptRequest = { ...spec, id: nextId++, resolve }
    waiters.push(request)
    if (!active) {
      active = waiters.shift() ?? null
    }
    notify()
  })
}

export function resolveDevPrompt(value: unknown): void {
  if (!active) return
  const current = active
  active = waiters.shift() ?? null
  current.resolve(value)
  notify()
}

export function clearDevPromptQueue(): void {
  while (active) {
    active.resolve(CLACK_CANCEL)
    active = waiters.shift() ?? null
  }
  for (const pending of waiters.splice(0)) {
    pending.resolve(CLACK_CANCEL)
  }
  notify()
}

/** @internal Tests */
export function resetDevPromptQueueForTests(): void {
  clearDevPromptQueue()
  nextId = 0
}
