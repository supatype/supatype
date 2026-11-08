import React, { useRef } from "react"
import { render, type Instance } from "ink"
import { isInteractive } from "../interactive.js"
import { createClackApi, type ClackApi } from "../clack-api.js"
import { FlowApp } from "../flows/FlowApp.js"
import { FlowTranscript } from "./flow-transcript.js"
import { prepareStdinForInk, restoreStdinAfterInk } from "./stdin-after-ink.js"

interface RunClackFlowRootProps<T> {
  run: (api: ClackApi) => Promise<T>
  transcript: FlowTranscript
  onComplete: (value: T) => void
  onError: (err: unknown) => void
}

function RunClackFlowRoot<T>({ run, transcript, onComplete, onError }: RunClackFlowRootProps<T>): React.ReactElement {
  const started = useRef(false)

  return (
    <FlowApp
      bind={(controller) => {
        if (started.current) return
        started.current = true
        void run(createClackApi(transcript.record(controller)))
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

  prepareStdinForInk()
  const transcript = new FlowTranscript()
  return new Promise<T>((resolve, reject) => {
    const instance = render(
      <RunClackFlowRoot
        run={run}
        transcript={transcript}
        onComplete={(value) => {
          teardownInk(instance, transcript.text())
          resolve(value)
        }}
        onError={(err) => {
          teardownInk(instance, transcript.text())
          reject(err)
        }}
      />,
      // A Ctrl+C is the command's own, not Ink's to end the process on (prompt-interrupt.ts).
      { patchConsole: false, exitOnCtrlC: false },
    )
  })
}

/** Clear the chrome, then write what its log pane showed, which the clear took with it (issue 67). */
function teardownInk(instance: Instance, shown: string): void {
  try {
    instance.clear()
  } catch {
    // ignore: terminal may already be reset
  }
  instance.unmount()
  instance.cleanup()
  restoreStdinAfterInk()
  if (shown !== "") process.stdout.write(shown)
}

export { CLACK_CANCEL } from "./cancel.js"
