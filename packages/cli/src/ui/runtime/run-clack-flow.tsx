import React, { useRef } from "react"
import { render } from "ink"
import { isInteractive } from "../interactive.js"
import { createClackApi, type ClackApi } from "../clack-api.js"
import { FlowApp } from "../flows/FlowApp.js"

interface RunClackFlowRootProps {
  run: (api: ClackApi) => Promise<unknown>
  onComplete: (value: unknown) => void
  onError: (err: unknown) => void
}

function RunClackFlowRoot({ run, onComplete, onError }: RunClackFlowRootProps): React.ReactElement {
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
        run={run as (api: ClackApi) => Promise<unknown>}
        onComplete={(value) => {
          instance.unmount()
          resolve(value as T)
        }}
        onError={(err) => {
          instance.unmount()
          reject(err)
        }}
      />,
    )
  })
}

export { CLACK_CANCEL } from "./cancel.js"
