import React, { useEffect, useRef, useState } from "react"
import { Box } from "ink"
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

export function FlowApp({ bind }: FlowAppProps): React.ReactElement {
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
      waitForPrompt<T>(spec: ActiveFlowPrompt): Promise<T> {
        return new Promise<T>((resolve) => {
          setPrompt(spec)
          setPromptResolver(() => (value: unknown) => {
            setPrompt(null)
            setPromptResolver(null)
            resolve(value as T)
          })
        })
      },
    }
    bind(controller)
  }, [bind])

  return (
    <Box flexDirection="column" paddingX={1}>
      <FlowLogoHeader />
      <FlowLogPane lines={logLines} />
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
