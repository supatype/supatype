#!/usr/bin/env bash
#
# Writing one key of a project's .env, for the live-stack scripts. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/env-file.sh"
#
# Three scripts carried their own copy of this, and one of them appended to a file whose last line
# had no newline, which joins the new key onto that line and loses both.

# env_file_set <file> <key> <value> - replaces the key's line, or appends one. Creates the file.
# The value goes through sed, so it must not contain `|`.
env_file_set() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    return
  fi
  if [[ -s "$file" && -n "$(tail -c1 "$file")" ]]; then printf '\n' >> "$file"; fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
}
