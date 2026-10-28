#!/usr/bin/env bash
#
# Reading and writing one key of a project's .env, for the live-stack scripts. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/env-file.sh"
#
# Three scripts carried their own copy of this, and one of them appended to a file whose last line
# had no newline, which joins the new key onto that line and loses both. Six read it their own way,
# taking the first line or the last, and stripping quotes or not.

# env_file_value <file> <key> - the key's value from its last line, as Compose reads it, without
# quotes or a carriage return. Empty when the key or the file is absent.
env_file_value() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tr -d '"\r' | tail -1
}

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
