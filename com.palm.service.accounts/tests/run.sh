#!/bin/sh
# Copyright (c) 2026 Herman van Hazendonk
# SPDX-License-Identifier: GPL-3.0-or-later
#
# tests/run.sh: the unit tests, then the static analysis.
#
# Not run here, and why: there is no C or C++ in this service, so the sanitizer, valgrind,
# sparse and cross-compiler passes the native services get have nothing to act on.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
fail=0

echo "== unit"
node --test "$HERE"/*.test.js || fail=1

echo
echo "== static analysis"
"$HERE/static-analysis.sh" || fail=1

exit $fail
