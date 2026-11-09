import React, { useEffect, useRef, useState } from "react"
import { Box, useApp, useInput, useStdin } from "ink"
import { PromptPanel } from "../components/PromptPanel.js"
import { CLACK_CANCEL } from "../runtime/cancel.js"
import { interruptFromPrompt } from "../runtime/prompt-interrupt.js"
import { restoreStdinAfterInk } from "../runtime/stdin-after-ink.js"
import {
  ActiveFlowPromptView,
  FlowLogPane,
  FlowLogoHeader,
  FlowSpinnerLine,
} from "./prompt-fields.js"
import type { ActiveFlowPrompt, FlowController, FlowLogLine } from "./types.js"

interface FlowAppProps {
  bind: (controller: FlowController) => void
  /** Called as a Ctrl+C ends the flow, before Ink unmounts and the process exits. */
  onRelease?: () => void
}

/**
 * Hold raw mode for as long as the flow is mounted. Without this, Ink turns raw mode off whenever
 * no prompt is on screen (init scans Docker and ports between two prompts) and on again for the
 * next one, and the Windows console swallows the first key typed after that switch: a port typed
 * as 18700 was saved as 8700.
 */
function useHeldRawMode(): void {
  const { isRawModeSupported, setRawMode } = useStdin()
  useEffect(() => {
    if (!isRawModeSupported) return undefined
    setRawMode(true)
    return () => setRawMode(false)
  }, [isRawModeSupported, setRawMode])
}

export function FlowApp({ bind, onRelease }: FlowAppProps): React.ReactElement {
  useHeldRawMode()
  // Raw mode turns Ctrl+C into a key; it is handed on as the command's own Ctrl+C. A command that is
  // not dev exits at once, so the terminal is given back first: raw mode off now, as an unmount's
  // effects would only turn it off on a later tick, and the flow ended.
  const { exit } = useApp()
  const { stdin } = useStdin()
  useInput((input, key) => {
    if (!((key.ctrl && input === "c") || input === "\x03")) return
    interruptFromPrompt(() => {
      restoreStdinAfterInk({ isTTY: stdin.isTTY, isRaw: true, setRawMode: (mode) => stdin.setRawMode(mode), pause: () => stdin.pause() })
      onRelease?.()
      exit()
    })
  })
  const [logLines, setLogLines] = useState<FlowLogLine[]>([])
  const [spinner, setSpinner] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<ActiveFlowPrompt | null>(null)
  const [promptResolver, setPromptResolver] = useState<((value: unknown) => void) | null>(null)
  const [finished, setFinished] = useState<(() => void) | null>(null)
  const bound = useRef(false)

  useEffect(() => {
    if (bound.current) return
    bound.current = true
    const controller: FlowController = {
      appendLog(level, text) {
        setLogLines((lines) => [...lines, { level, text }])
      },
      setSpinner(message) {
        setSpinner(message)
      },
      waitForPrompt(spec: ActiveFlowPrompt): Promise<unknown> {
        return new Promise<unknown>((resolve) => {
          setLogLines([])
          setSpinner(null)
          setPrompt(spec)
          setPromptResolver(() => (value: unknown) => {
            setPrompt(null)
            setPromptResolver(null)
            resolve(value)
          })
        })
      },
      finish(): Promise<void> {
        return new Promise<void>((resolve) => {
          setSpinner(null)
          setPrompt(null)
          setFinished(() => resolve)
        })
      },
    }
    bind(controller)
  }, [bind])

  // Called once the finished frame is committed, which is what `finish` waits for.
  useEffect(() => finished?.(), [finished])

  // Finished, the frame is the log lines alone: `finish` took the spinner and prompt away.
  return (
    <Box flexDirection="column" paddingX={1}>
      {finished ? null : <FlowLogoHeader />}
      {prompt ? null : <FlowLogPane lines={logLines} gapBelow={finished === null} />}
      {spinner ? <FlowSpinnerLine message={spinner} /> : null}
      {prompt && promptResolver ? (
        <PromptPanel>
          <ActiveFlowPromptView
            prompt={prompt}
            onSubmit={(value) => promptResolver(value)}
            onCancel={() => promptResolver(CLACK_CANCEL)}
          />
        </PromptPanel>
      ) : null}
    </Box>
  )
}
