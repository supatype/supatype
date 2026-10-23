import React, { useEffect, useRef, useState } from "react"
import { Box, useStdin } from "ink"
import { PromptPanel } from "../components/PromptPanel.js"
import { CLACK_CANCEL } from "../runtime/cancel.js"
import {
  ActiveFlowPromptView,
  FlowLogPane,
  FlowLogoHeader,
  FlowSpinnerLine,
} from "./prompt-fields.js"
import type { ActiveFlowPrompt, FlowController, FlowLogLine } from "./types.js"

interface FlowAppProps {
  bind: (controller: FlowController) => void
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

export function FlowApp({ bind }: FlowAppProps): React.ReactElement {
  useHeldRawMode()
  const [logLines, setLogLines] = useState<FlowLogLine[]>([])
  const [spinner, setSpinner] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<ActiveFlowPrompt | null>(null)
  const [promptResolver, setPromptResolver] = useState<((value: unknown) => void) | null>(null)
  const bound = useRef(false)

  useEffect(() => {
    if (bound.current) return
    bound.current = true
    const controller: FlowController = {
      appendLog(level, text) {
        setLogLines((lines) => [...lines, { level, text }])
      },
      appendPlain(text) {
        setLogLines((lines) => [...lines, { level: "plain", text }])
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
    }
    bind(controller)
  }, [bind])

  return (
    <Box flexDirection="column" paddingX={1}>
      <FlowLogoHeader />
      {prompt ? null : <FlowLogPane lines={logLines} />}
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
