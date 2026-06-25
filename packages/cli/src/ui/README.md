# CLI terminal UI (`packages/cli/src/ui/`)

Shared output layer for `supatype` commands (not `supatype dev` TUI).

| Module | Use for |
|--------|---------|
| `messages.ts` | `info` / `warn` / `error` (Clack log in TTY; `[supatype]` in CI), `file`, `step`, `plain` |
| `fatal.ts` | `fatalError`, `reportCliFatal` — branded fatals + global catch helper |
| `confirm.ts` | Yes/no prompts (Clack in TTY; respects `--yes` / non-TTY) |
| `progress.ts` | `withSpinner` for long async work |
| `prompts.ts` | Logo, Clack wizard helpers, `promptText` |
| `next-steps.ts` | Bulleted follow-up commands |
| `brand.ts` | ANSI colours + logo styling (shared with dev TUI) |

**`supatype dev`** keeps its own alt-screen TUI (`dev-tui.ts`). Do not route dev logs through Clack.

**Convention:** interactive multi-step flows use Clack (`init`, `add`, `link`); one-shot commands use `info` + optional `withSpinner`.
