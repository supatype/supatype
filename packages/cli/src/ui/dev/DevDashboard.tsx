import React, { useEffect, useState } from "react"
import { Box, Text, useInput, useStdout } from "ink"
import type { DevLogBus } from "../../dev-log-bus.js"
import { stripAnsi } from "../../dev-log-filter.js"
import { logoRowCount } from "../../dev-logo.js"
import { logInkColor, taskInkColor } from "../../dev-task-colors.js"
import { LogoWordmark } from "../components/LogoWordmark.js"
import { PromptPanel } from "../components/PromptPanel.js"
import { DevReadyPanelView } from "./DevReadyPanelView.js"
import { theme } from "../theme.js"
import { requestDevShutdown } from "../../dev-shutdown.js"
import {
  getActiveDevPrompt,
  resolveDevPrompt,
  subscribeDevPrompts,
} from "../runtime/dev-prompt-queue.js"
import { CLACK_CANCEL } from "../runtime/cancel.js"
import { ActiveFlowPromptView } from "../flows/prompt-fields.js"
import type { ActiveFlowPrompt } from "../flows/types.js"

const TASK_COL_WIDTH = 22
const MIN_WIDTH = 60
const MIN_HEIGHT = 14
const TAGLINE = "local development"

function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, width)
  return `${text.slice(0, width - 1)}…`
}

function padPlain(text: string, width: number): string {
  if (text.length >= width) return text
  return text + " ".repeat(width - text.length)
}

function devPromptToFlowPrompt(prompt: NonNullable<ReturnType<typeof getActiveDevPrompt>>): ActiveFlowPrompt {
  switch (prompt.kind) {
    case "confirm":
      return {
        kind: "confirm",
        message: prompt.message,
        initialValue: typeof prompt.initialValue === "boolean" ? prompt.initialValue : false,
      }
    case "text":
      return {
        kind: "text",
        message: prompt.message,
        ...(prompt.defaultValue !== undefined ? { defaultValue: prompt.defaultValue } : {}),
        ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
        ...(prompt.validate !== undefined ? { validate: prompt.validate } : {}),
      }
    case "password":
      return { kind: "password", message: prompt.message }
    case "select":
      return {
        kind: "select",
        message: prompt.message,
        options: prompt.options ?? [],
        ...(typeof prompt.initialValue === "string" ? { initialValue: prompt.initialValue } : {}),
      }
    default:
      return { kind: "confirm", message: prompt.message, initialValue: false }
  }
}

function scrollHint(scrollFromBottom: number, total: number, visible: number): string {
  if (total <= visible) return "all lines visible"
  if (scrollFromBottom === 0) return "latest"
  if (scrollFromBottom >= total - visible) return "oldest"
  return `${scrollFromBottom} lines up from latest`
}

interface DevDashboardProps {
  bus: DevLogBus
}

export function DevDashboard({ bus }: DevDashboardProps): React.ReactElement {
  const { stdout } = useStdout()
  const cols = Math.max(MIN_WIDTH, stdout.columns ?? 80)
  const rows = Math.max(MIN_HEIGHT, stdout.rows ?? 24)
  const [, tick] = useState(0)
  const [scrollFromBottom, setScrollFromBottom] = useState(0)
  const [activePrompt, setActivePrompt] = useState(getActiveDevPrompt())

  useEffect(() => {
    const offBus = bus.onUpdate(() => tick((n) => n + 1))
    const offPrompt = subscribeDevPrompts(() => setActivePrompt(getActiveDevPrompt()))
    return () => {
      offBus()
      offPrompt()
    }
  }, [bus])

  const promptOpen = activePrompt !== null
  const focusedId = bus.getFocusedTaskId()
  const taskIds = bus.getTaskOrder()
  const readyPanel = bus.getReadyPanel()
  const readyRows = readyPanel ? bus.readyPanelRowCount() : 0
  const logoRows = logoRowCount() + 1 // figlet + tagline
  const chromeRows = logoRows + readyRows + 2 // separator + keybindings line
  const logHeight = Math.max(4, rows - chromeRows - (promptOpen ? 6 : 0) - 1)
  const logWidth = cols - TASK_COL_WIDTH - 1

  useInput((input, key) => {
    if (promptOpen) return

    if ((key.ctrl && input === "c") || input === "\x03") {
      requestDevShutdown()
      return
    }

    if (key.downArrow || input === "j") {
      bus.focusNext()
      setScrollFromBottom(0)
      return
    }
    if (key.upArrow || input === "k") {
      bus.focusPrevious()
      setScrollFromBottom(0)
      return
    }
    if (input === "u") {
      setScrollFromBottom((s) =>
        Math.min(s + 3, Math.max(0, (bus.getTask(focusedId)?.lines.length ?? 0) - logHeight)),
      )
      return
    }
    if (input === "d") {
      setScrollFromBottom((s) => Math.max(s - 3, 0))
      return
    }
    if (input === "g") {
      setScrollFromBottom(Math.max(0, (bus.getTask(focusedId)?.lines.length ?? 0) - logHeight))
      return
    }
    if (input === "G") {
      setScrollFromBottom(0)
    }
  })

  const taskLines = bus.getTask(focusedId)?.lines ?? []
  const totalLines = taskLines.length
  const end = totalLines - scrollFromBottom
  const start = Math.max(0, end - logHeight)

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <LogoWordmark maxWidth={cols} tagline={TAGLINE} />
      {readyPanel ? <DevReadyPanelView panel={readyPanel} width={cols} /> : null}
      <Text dimColor>{"─".repeat(cols)}</Text>
      <Text dimColor>
        {truncate(" ↑/k ↓/j task  u/d scroll  g/G top/bottom  Ctrl+C quit", cols)}
      </Text>

      {Array.from({ length: logHeight }, (_, row) => {
        const taskId = taskIds[row]
        const task = taskId ? bus.getTask(taskId) : undefined
        let left = " ".repeat(TASK_COL_WIDTH)
        if (task && taskId) {
          const marker = taskId === focusedId ? "▶" : " "
          const unread = task.unread ? " •" : "  "
          const label = truncate(`${marker} ${task.title}${unread}`, TASK_COL_WIDTH - 1)
          left = padPlain(label, TASK_COL_WIDTH)
        }

        const index = start + row
        const rawFull = index >= end || index >= totalLines ? "" : (taskLines[index] ?? "")
        const raw = stripAnsi(rawFull)
        const logLine = padPlain(truncate(raw, logWidth), logWidth)

        return (
          <Box key={`row-${row}`}>
            <Text
              {...(taskId === focusedId ? { bold: true } : {})}
              color={taskId ? taskInkColor(taskId) : theme.dim}
            >
              {left}
            </Text>
            <Text dimColor>│</Text>
            <Text
              {...(raw
                ? { color: logInkColor(focusedId, raw) }
                : { dimColor: true })}
            >
              {logLine}
            </Text>
          </Box>
        )
      })}

      <Text dimColor>{"─".repeat(cols)}</Text>
      <Text>
        <Text dimColor> focused </Text>
        <Text color={taskInkColor(focusedId)} bold>
          {bus.getTask(focusedId)?.title ?? focusedId}
        </Text>
        <Text dimColor>{` · ${scrollHint(scrollFromBottom, totalLines, logHeight)}`}</Text>
      </Text>

      {promptOpen && activePrompt ? (
        <PromptPanel>
          <ActiveFlowPromptView
            prompt={devPromptToFlowPrompt(activePrompt)}
            onSubmit={(value) => resolveDevPrompt(value)}
            onCancel={() => resolveDevPrompt(CLACK_CANCEL)}
          />
        </PromptPanel>
      ) : null}
    </Box>
  )
}
