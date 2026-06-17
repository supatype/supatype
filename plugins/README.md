# Supatype plugin (local testing)

This repo ships the **supatype** agent skill as an installable plugin for Cursor and Claude Code.

- Skill source: `skills/supatype/`
- Cursor manifest: `.cursor-plugin/plugin.json`
- Claude Code manifest: `.claude-plugin/plugin.json`

## Test in Cursor (local)

1. Symlink this repo as a local plugin:

   ```bash
   mkdir -p ~/.cursor/plugins/local
   ln -sfn "$(pwd)" ~/.cursor/plugins/local/supatype
   ```

   On Windows (PowerShell):

   ```powershell
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.cursor\plugins\local" | Out-Null
   if (Test-Path "$env:USERPROFILE\.cursor\plugins\local\supatype") {
     Remove-Item "$env:USERPROFILE\.cursor\plugins\local\supatype" -Force -Recurse
   }
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.cursor\plugins\local\supatype" -Target "C:\path\to\supatype"
   ```

   On Windows (Git Bash) or macOS/Linux:

   ```bash
   mkdir -p ~/.cursor/plugins/local
   ln -sfn "$(pwd)" ~/.cursor/plugins/local/supatype
   ```

2. **Developer: Reload Window** in Cursor (Command Palette).

3. Open **Settings → Rules** (or Plugins). Confirm the **supatype** skill appears.

4. In Agent chat, try: "Set up a new Supatype project called demo" and confirm the skill loads.

5. Remove when done:

   ```bash
   rm ~/.cursor/plugins/local/supatype   # or rmdir on Windows junction
   ```

**Alternative (project-only, no plugin manifest):**

```bash
npx --yes degit supatype/supatype/skills/supatype .cursor/skills/supatype
```

## Test in Claude Code (local)

From this repo root:

```bash
claude plugin validate .
```

Add the local marketplace:

```text
/plugin marketplace add .
/plugin install supatype@supatype
```

Verify the skill is listed:

```text
/plugin
```

Try a prompt: “Scaffold a Supatype project and explain the dev workflow.”

Remove:

```text
/plugin uninstall supatype@supatype
/plugin marketplace remove supatype
```

## Publish (after testing)

| Target | Action |
|--------|--------|
| **Cursor public** | Submit `https://github.com/supatype/supatype` at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) |
| **Cursor team** | Settings → Plugins → Team Marketplaces → Import → paste GitHub repo URL |
| **Claude Code users** | `/plugin marketplace add supatype/supatype` then `/plugin install supatype@supatype` |
| **Claude community** | Submit via Claude Code plugin submission flow (see [Create plugins](https://code.claude.com/docs/en/plugins)) |

Commit and push only after local testing passes.
