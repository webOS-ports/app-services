#!/bin/sh
# Copyright (c) 2026 Herman van Hazendonk
# SPDX-License-Identifier: Apache-2.0
#
# jshint over the service and its tests (.jshintrc: Node 22, as the messaging service has it).
#
# jshint is not vendored, so this reports what it could not run rather than failing over a
# missing tool. The syntax check below runs either way: node parses every module.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SVC=$(cd "$HERE/.." && pwd)
fail=0

JSHINT=${JSHINT:-$(command -v jshint || true)}
if [ -n "$JSHINT" ]; then
	if "$JSHINT" --config "$SVC/.jshintrc" "$SVC/service.js" "$SVC/lib" "$SVC/tests"; then
		echo "PASS jshint"
	else
		echo "FAIL jshint"; fail=1
	fi
else
	echo "SKIP jshint (not installed; npm i -g jshint, or set JSHINT)"
fi

# Every module parses. node --check only parses, so nothing in them runs.
n=0
for f in "$SVC/service.js" "$SVC"/lib/*.js "$SVC"/tests/*.js; do
	node --check "$f" || { echo "FAIL parse $f"; fail=1; }
	n=$((n + 1))
done
echo "PASS parse ($n modules)"

exit $fail
