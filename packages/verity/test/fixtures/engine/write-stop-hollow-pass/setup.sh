#!/usr/bin/env bash
# $1 = temp dir. A scannable project with no test files: the "test": "echo ok"
# shape. The anchor must withhold the npm test pass.
T="$1"
mkdir -p "$T/proj"
printf '%s' '{"name":"demo","scripts":{"test":"echo ok"}}' > "$T/proj/package.json"
