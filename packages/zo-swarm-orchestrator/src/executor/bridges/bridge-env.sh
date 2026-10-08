#!/usr/bin/env bash
# bridge-env.sh — shared de-Zo environment defaults for swarm executor bridges.
#
# Source AFTER `set -euo pipefail`, BEFORE binary resolution, e.g.:
#   source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bridge-env.sh"
#
# Provides:
#   WORKSPACE_DEFAULT — "$HOME/workspace" (de-Zo fallback workdir)
#   resolve_harness_bin <VAR_NAME> <bin_name>
#     Resolves a harness binary to an explicit path and assigns it to $VAR_NAME.
#     Precedence: existing $VAR_NAME value (if executable) >
#       $HOME/workspace/.local/bin > $HOME/.local/bin > /usr/local/bin > PATH.
#     Prints the resolved path; returns 1 when nothing is found.
#
# Nothing here is Zo-specific: all defaults are $HOME-relative so the same
# file works on any host and in the de-Zo'd public package.

# shellcheck disable=SC2034
WORKSPACE_DEFAULT="${HOME}/workspace"

resolve_harness_bin() {
  local var_name="$1" bin_name="$2"
  local current="${!var_name:-}"
  if [[ -n "$current" && -x "$current" ]]; then
    printf '%s' "$current"
    return 0
  fi
  local dir
  for dir in "${HOME}/workspace/.local/bin" "${HOME}/.local/bin" "/usr/local/bin"; do
    if [[ -x "$dir/$bin_name" ]]; then
      printf -v "$var_name" '%s' "$dir/$bin_name"
      printf '%s' "$dir/$bin_name"
      return 0
    fi
  done
  if command -v "$bin_name" >/dev/null 2>&1; then
    printf -v "$var_name" '%s' "$bin_name"
    printf '%s' "$bin_name"
    return 0
  fi
  return 1
}
