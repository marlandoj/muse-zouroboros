#!/usr/bin/env bash
# Template bridge script — copy and customize for new executors
#
# Bridge Protocol:
#   - Invocation: bash <bridge> "<prompt>" [workdir]
#   - Input:  $1 = prompt text (required), $2 = working directory (optional)
#   - Output: stdout = clean text response (no chrome, no banners)
#   - Errors: stderr = diagnostics and error messages
#   - Exit:   0 = success, non-zero = failure
#   - Env:    full parent environment is inherited
#   - Shell:  #!/usr/bin/env bash, set -euo pipefail, must be executable
#
# Usage:
#   ./my-executor-bridge.sh "Your prompt here"
#   ./my-executor-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   MY_EXECUTOR_TIMEOUT — timeout in seconds (default: 300)

set -euo pipefail

PROMPT="${1:?Usage: my-executor-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/home/workspace}"
TIMEOUT="${MY_EXECUTOR_TIMEOUT:-300}"

# --- Prerequisite checks ---
# Verify the executor binary/runtime is available
# if ! command -v my-executor &>/dev/null; then
#   echo "ERROR: my-executor not found" >&2
#   exit 1
# fi

# --- Execute ---
cd "$WORKDIR"

# Replace this with your executor invocation.
# Key requirements:
#   1. Only clean response text on stdout
#   2. Diagnostics/errors on stderr
#   3. Exit 0 on success, non-zero on failure
#   4. Respect timeout

# Example:
# timeout "$TIMEOUT" my-executor --prompt "$PROMPT" --format text 2>/tmp/bridge-stderr-$$.log
# EXIT_CODE=$?

# --- Placeholder (remove when implementing) ---
echo "ERROR: template-bridge.sh is a scaffold — copy and implement for your executor" >&2
exit 1
