#!/usr/bin/env bash
# Trust a .canny.json carrying ignore globs.
set -u
T="$1"
mkdir -p "$T/p"
printf '{"ignore":["*.log"]}' > "$T/p/.canny.json"
(cd "$T/p" && env -u TYPESAFE_API_KEY "$SETUP_HOME_VAR"="$T/home" timeout 10 node "$SETUP_ENGINE_CLI" trust >/dev/null)
