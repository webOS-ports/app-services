#!/bin/bash
# stage.sh — package the WHOLE com.palm.service.accounts service as its own ipk. This repo is the
# single source of truth; postinst replaces /usr/palm/services/com.palm.service.accounts wholesale
# (backing up stock first) rather than patching individual files.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STAGE="$1"
# shellcheck source=/dev/null
source "$REPO/packaging/lib/common.sh"

stage_whole "$REPO/com.palm.service.accounts" /usr/palm/services/com.palm.service.accounts com.palm.service.accounts \
  db tempdb desktop-support files tests backup ls2

# db/kinds and db/permissions are excluded from the whole-directory payload above (static schema,
# not live runtime data) -- provision them to their real, system-wide db8 location instead. See
# stage_db8_schema's comment in common.sh. One level deeper than contacts.linker's layout: the
# actual kind/permission files sit under a com.palm.service.accounts/ subdirectory, not directly
# in db/kinds and db/permissions.
stage_db8_schema "$REPO/com.palm.service.accounts/db/kinds/com.palm.service.accounts" \
  "$REPO/com.palm.service.accounts/db/permissions/com.palm.service.accounts" com.palm.service.accounts

# Same gap, one level deeper: com.palm.account.syncstate and com.palm.signaling live in the SEPARATE
# tempdb mojodb instance (com.palm.tempdb, not com.palm.db). Tracked in-repo (byte-identical to
# stock) but never shipped or provisioned by this packaging tree at all until now -- confirmed live
# as a permanent "kind not registered: 'com.palm.account.syncstate:1' (-3970)" log-spam loop from
# com.palm.app.accounts/com.palm.systemui. See stage_tempdb_schema's comment in common.sh.
stage_tempdb_schema "$REPO/com.palm.service.accounts/tempdb/kinds/com.palm.service.accounts" \
  "$REPO/com.palm.service.accounts/tempdb/permissions/com.palm.service.accounts" com.palm.service.accounts

# LS2 hub activation files -- byte-identical copies of what the STOCK com.palm.service.accounts ipk
# always shipped (verified against a pristine stock rootfs image). Our own whole-directory-replace
# ipk never declared these in its manifest, so installing it as an upgrade over stock silently
# deleted them via normal ipkg upgrade semantics (files in the old package's list but not the new
# one get removed) -- permanently breaking on-demand launch, even across a full reboot, the moment
# the resident process happened to die. See stage_extra_file's comment in common.sh.
stage_extra_file "$REPO/com.palm.service.accounts/ls2/roles/com.palm.service.accounts.json" \
  /usr/share/ls2/roles/prv/com.palm.service.accounts.json com.palm.service.accounts
stage_extra_file "$REPO/com.palm.service.accounts/ls2/roles/com.palm.service.accounts.json" \
  /usr/share/ls2/roles/pub/com.palm.service.accounts.json com.palm.service.accounts
stage_extra_file "$REPO/com.palm.service.accounts/ls2/services/com.palm.service.accounts.service" \
  /usr/share/dbus-1/services/com.palm.service.accounts.service com.palm.service.accounts
stage_extra_file "$REPO/com.palm.service.accounts/ls2/services/com.palm.service.accounts.service" \
  /usr/share/dbus-1/system-services/com.palm.service.accounts.service com.palm.service.accounts

echo "com.palm.service.accounts stage complete: $STAGE"
