/**
 * What a flow's log pane shows, kept so it outlives the pane.
 *
 * The Ink chrome is cleared when a command ends, and the log pane with it, so a command that logged
 * a short report and ended left nothing on screen: `seed --status` showed no line (issue 67). Piped
 * output has no chrome, which is why it showed. Once the chrome is gone, `runClackFlow` writes the
 * lines the pane showed last.
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
      appendPlain: (text) => {
        this.lines.push({ level: "plain", text })
        controller.appendPlain(text)
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
