#!/usr/bin/env bash
# $1 = temp dir. Uses $SETUP_ENGINE_CLI / $SETUP_HOME_VAR from the harness.
T="$1"
CLI="${SETUP_ENGINE_CLI:-/home/workspace/Integrations/canny/dist/cli.js}"
HVAR="${SETUP_HOME_VAR:-CANNY_HOME}"
mkdir -p "$T/proj"
printf '%s' '{"releaseValve":true}' > "$T/proj/.verity.json"
(cd "$T/proj" && env -u TYPESAFE_API_KEY "$HVAR"="$T/home" timeout 10 node "$CLI" trust >/dev/null 2>&1)
