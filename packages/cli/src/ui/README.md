# CLI terminal UI (`packages/cli/src/ui/`)

Shared Ink-based design system for the Supatype CLI.

| Module | Use for |
|--------|---------|
| `theme.ts` | Brand + semantic colours (Ink + plain ANSI) |
| `messages.ts` | `info` / `warn` / `error` / `success`, `file`, `step`, `plain` |
| `fatal.ts` | `fatalError`, `reportCliFatal` |
| `confirm.ts` | Yes/no prompts (Ink overlay in dev, Ink flow in TTY) |
| `progress.ts` | `withSpinner` + `runCommandChrome` for one-shot commands |
| `runtime/command-chrome.ts` | Ink shell (logo, logs, spinner) — applied globally via `wrapProgramActionsWithChrome` in `cli.ts` |
| `prompts.ts` | Logo, `promptText`, `promptPassword`, `ensureNotCancelled` |
| `clack.ts` | Clack-compatible `p.*` API + `runClackFlow()` for wizards |
| `flows/` | Ink flow shell + prompt fields |
| `dev/DevDashboard.tsx` | `supatype dev` task list + log pane + prompt overlay |
| `next-steps.ts` | Bulleted follow-up commands |

**Convention:** interactive wizards use `runClackFlow(async (p) => …)` (`init`, `link`, `add domain`); one-shot commands get branded chrome automatically in `cli.ts` via `wrapProgramActionsWithChrome`. **`supatype dev`** keeps a persistent Ink dashboard (excluded from auto-wrap).

**Plain profile:** when `!isInteractive()` (CI, pipes), helpers fall back to `[supatype]`-prefixed lines.
