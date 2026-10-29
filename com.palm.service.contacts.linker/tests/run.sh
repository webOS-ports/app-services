#!/bin/sh
# Copyright (c) 2026 Herman van Hazendonk
# SPDX-License-Identifier: Apache-2.0
#
# tests/run.sh: the unit tests, then the static analysis.
#
# The tests that link need the device's globalization and phonenumberlib (see tests/boot.js):
# LINKER_FRAMEWORKS=<a copy of a device's /usr/palm/frameworks> tests/run.sh. Without them those
# tests are skipped, and say so.
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
