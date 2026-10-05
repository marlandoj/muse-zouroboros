#!/usr/bin/env bash
set -u
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
out="$(timeout 3 python3 "$SCRIPT_DIR/sift.py" hook "$1" 2>/dev/null)" || out=''
if [ "$1" != kimi ]; then printf '%s\n' "${out:-\{\}}"; fi
