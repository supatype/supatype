#!/usr/bin/env bash
#
# Reading and writing one key of a project's .env, for the live-stack scripts. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/env-file.sh"
#
# Three scripts carried their own copy of this, and one of them appended to a file whose last line
# had no newline, which joins the new key onto that line and loses both. Reads went the same way:
# each script had its own, taking the first line or the last and stripping quotes or not.

# env_file_value <file> <key> - the key's value from its last line, without a carriage return or
# one pair of enclosing quotes. Empty when the key is absent. Reads `KEY=value` lines as the CLI
# writes them, not every form a hand-written .env allows (`export`, inline comments). A missing
# file is said on stderr and fails, so a caller is not handed an empty value for no reason.
env_file_value() {
  if [[ ! -f "$1" ]]; then
    echo "env_file_value: no such file: $1" >&2
    return 1
  fi
  sed -n "s/^$2=//p" "$1" | tail -1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# env_file_set <file> <key> <value> - replaces the key's line, or appends one. Creates the file.
# The value is escaped for sed, so `&`, `\` and `|` in a secret arrive as written.
env_file_set() {
  local file="$1" key="$2" value="$3" escaped
  if [[ "$value" == *$'\n'* ]]; then
    echo "env_file_set: $key holds a newline, which one .env line cannot" >&2
    return 1
  fi
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    escaped="$(printf '%s' "$value" | sed -e 's/[&\\|]/\\&/g')"
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
    return
  fi
  if [[ -s "$file" && -n "$(tail -c1 "$file")" ]]; then printf '\n' >> "$file"; fi
  printf '%s=%s\n' "$key" "$value" >> "$file"
}
