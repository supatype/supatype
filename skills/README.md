# Supatype agent skills

Shareable skills for AI coding assistants working with Supatype.

## Available skills

| Skill | Description |
|-------|-------------|
| [supatype](supatype/) | Working with Supatype: setup, schema, CLI, client, self-host |

## Install (recommended)

From any project:

```bash
# Claude Code
npx skills add supatype/supatype --skill supatype -a claude-code

# Cursor (global)
npx skills add supatype/supatype --skill supatype -g -a cursor

# List without installing
npx skills add supatype/supatype --list
```

The CLI clones `skills/supatype/` from this repo and installs into agent-specific paths (e.g. `~/.claude/skills/supatype`, `~/.cursor/skills/supatype`).

## Install from GitHub (manual)

```bash
# Cursor / Claude: skill only (no plugin UI)
npx --yes degit supatype/supatype/skills/supatype .cursor/skills/supatype

# Claude Code project skill
mkdir -p .claude/skills
npx --yes degit supatype/supatype/skills/supatype .claude/skills/supatype
```

## Plugin marketplace

Manifests live at `.cursor-plugin/` and `.claude-plugin/` (repo root). See [plugins/README.md](../plugins/README.md) for local testing before publish.

```bash
# Claude Code plugin (after marketplace is published)
# /plugin marketplace add supatype/supatype
# /plugin install supatype@supatype
```

## Monorepo contributors

Edit **`skills/supatype/`** only — do not commit copies under `.cursor/skills/` or `.claude/skills/supatype/`.

Install the user skill locally for Claude Code in this repo:

```bash
pnpm skills:install
```

This symlinks `skills/supatype` → `.claude/skills/supatype`. Contributor-only **`supatype-dev`** stays at `.claude/skills/supatype-dev/` (not published).

## Personal (all projects)

```bash
mkdir -p ~/.cursor/skills
cp -r skills/supatype ~/.cursor/skills/

# or
npx skills add supatype/supatype -g -a claude-code -a cursor
```

## Canonical source

**`skills/supatype/`** is the single source of truth for the published `supatype` skill. End users install via `npx skills add`, degit, copy, or the Claude/Cursor plugin.
