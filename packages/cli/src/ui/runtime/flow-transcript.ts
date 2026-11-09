/**
 * What a flow's log pane shows, kept so it outlives the pane.
 *
 * For a command that calls `process.exit` inside its flow: the process goes before Ink can write
 * the frame it holds, so `types check` left only the banner (issue 77). `runClackFlow` then takes
 * Ink's frame off and writes these lines in its place. A flow that ends normally needs none of
 * this: its last frame is the log lines, and stays on screen.
 */

import type { FlowController, FlowLogLevel, FlowLogLine } from "../flows/types.js"
import { plainError, plainInfo, plainSuccess, plainWarn } from "../theme.js"

const PLAIN_LINE: Record<FlowLogLevel, (text: string) => string> = {
  info: plainInfo,
  warn: plainWarn,
  error: plainError,
  success: plainSuccess,
  plain: (text) => text,
}

export class FlowTranscript {
  private lines: FlowLogLine[] = []

  /** `controller`, keeping each line it logs. A prompt clears the pane, so it clears these too. */
  record(controller: FlowController): FlowController {
    return {
      ...controller,
      appendLog: (level, text) => {
        this.lines.push({ level, text })
        controller.appendLog(level, text)
      },
      waitForPrompt: (spec) => {
        this.lines = []
        return controller.waitForPrompt(spec)
      },
    }
  }

  /** The lines as the terminal shows them without the chrome, or "" when there are none. */
  text(): string {
    return this.lines.map((line) => `${PLAIN_LINE[line.level](line.text)}\n`).join("")
  }
}
