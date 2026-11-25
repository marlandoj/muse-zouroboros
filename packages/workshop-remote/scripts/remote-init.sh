#!/usr/bin/env bash
# remote-init.sh — create the operator secret that remote mode requires.
#
# Writes a random 256-bit secret to ~/.config/zouroboros/remote-operator.secret
# (mode 600, directory 700) and prints only its fingerprint. You type the
# secret on the consent page when you approve a web client (ChatGPT, Claude.ai,
# Muse) — keep it in your password manager. Re-running refuses to overwrite;
# pass --rotate to replace it (existing tokens stay valid until they expire or
# you delete ~/.zo/remote/oauth.db).
set -euo pipefail
DIR="${ZO_CONFIG_DIR:-$HOME/.config/zouroboros}"
FILE="${ZO_REMOTE_OPERATOR_SECRET_FILE:-$DIR/remote-operator.secret}"
mkdir -p "$(dirname "$FILE")"; chmod 700 "$(dirname "$FILE")"
if [ -e "$FILE" ] && [ "${1:-}" != "--rotate" ]; then
  echo "remote-init: $FILE already exists (use --rotate to replace it)" >&2
  exit 1
fi
umask 077
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$FILE.tmp"
chmod 600 "$FILE.tmp"; mv "$FILE.tmp" "$FILE"
FP="sha256:$(tr -d '\n' < "$FILE" | sha256sum | cut -c1-16)"
echo "operator secret written: $FILE (mode 600)"
echo "fingerprint: $FP"
echo "read it once with:  cat $FILE   (then store it in your password manager)"
