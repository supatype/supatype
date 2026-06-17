# Supatype agent skills

Shareable skills for AI coding assistants working with Supatype.

## Available skills

| Skill | Description |
|-------|-------------|
| [supatype](supatype/) | Working with Supatype: setup, schema, CLI, client, self-host |

## Install from GitHub

After this directory is on `main`:

```bash
# Cursor / Claude: skill only (no plugin UI)
npx --yes degit supatype/supatype/skills/supatype .cursor/skills/supatype

# Claude Code plugin (after marketplace is published)
# /plugin marketplace add supatype/supatype
# /plugin install supatype@supatype
```

## Plugin marketplace

Manifests live at `.cursor-plugin/` and `.claude-plugin/` (repo root). See [plugins/README.md](../plugins/README.md) for local testing before publish.

## Install for Cursor

**Plugin (recommended):** import this repo in **Settings → Plugins** (team marketplace) or install from the Cursor Marketplace after publish.

**Skill only** into any project:

```bash
mkdir -p .cursor/skills
npx --yes degit supatype/supatype/skills/supatype .cursor/skills/supatype
```

**Personal (all projects):**

```bash
mkdir -p ~/.cursor/skills
cp -r skills/supatype ~/.cursor/skills/
```

## Install for Claude Code

**Plugin:** `/plugin marketplace add supatype/supatype` then `/plugin install supatype@supatype`

**Project skill only:**

```bash
mkdir -p .claude/skills
npx --yes degit supatype/supatype/skills/supatype .claude/skills/supatype
```

## Canonical source

Edit **`skills/supatype/`** only. Do not commit copies under `.cursor/skills/` or `.claude/skills/` — install with degit/copy from `skills/supatype/` instead.
