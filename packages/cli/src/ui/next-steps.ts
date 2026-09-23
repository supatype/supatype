import { plain } from "./messages.js"

/** Print a numbered or bulleted “next steps” block. */
export function nextSteps(title: string, steps: string[]): void {
  plain(`\n${title}`)
  for (const step of steps) {
    plain(`  ${step}`)
  }
  plain()
}
