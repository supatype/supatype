import React, { useRef } from "react"
import { render, type Instance } from "ink"
import { isInteractive } from "../interactive.js"
import { createClackApi, type ClackApi } from "../clack-api.js"
import { FlowApp } from "../flows/FlowApp.js"
import { restoreStdinAfterInk } from "./stdin-after-ink.js"

interface RunClackFlowRootProps<T> {
  run: (api: ClackApi) => Promise<T>
  onComplete: (value: T) => void
  onError: (err: unknown) => void
}

function RunClackFlowRoot<T>({ run, onComplete, onError }: RunClackFlowRootProps<T>): React.ReactElement {
  const started = useRef(false)

  return (
    <FlowApp
      bind={(controller) => {
        if (started.current) return
        started.current = true
        void run(createClackApi(controller))
          .then(onComplete)
          .catch(onError)
      }}
    />
  )
}

/** Mount a single Ink flow session (init wizard, standalone confirm, etc.). */
export async function runClackFlow<T>(run: (api: ClackApi) => Promise<T>): Promise<T> {
  if (!isInteractive()) {
    throw new Error("Interactive Ink flow requires a TTY.")
  }

  return new Promise<T>((resolve, reject) => {
    const instance = render(
      <RunClackFlowRoot
        run={run}
        onComplete={(value) => {
          teardownInk(instance)
          resolve(value)
        }}
        onError={(err) => {
          teardownInk(instance)
          reject(err)
        }}
      />,
      { patchConsole: false },
    )
  })
}

function teardownInk(instance: Instance): void {
  try {
    instance.clear()
  } catch {
    // ignore: terminal may already be reset
  }
  instance.unmount()
  instance.cleanup()
  restoreStdinAfterInk()
}

export { CLACK_CANCEL } from "./cancel.js"
