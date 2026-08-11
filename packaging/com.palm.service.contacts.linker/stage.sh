#!/bin/bash
# stage.sh — package the WHOLE com.palm.service.contacts.linker service as its own ipk. This repo
# is the single source of truth; postinst replaces /usr/palm/services/com.palm.service.contacts.linker
# wholesale (backing up stock first) rather than patching individual files.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STAGE="$1"
# shellcheck source=/dev/null
source "$REPO/packaging/lib/common.sh"

stage_whole "$REPO/com.palm.service.contacts.linker" /usr/palm/services/com.palm.service.contacts.linker com.palm.service.contacts.linker \
  db tempdb desktop-support files tests backup filecache_types watches activities ls2

# db/kinds and db/permissions are excluded from the whole-directory payload above (they're static
# schema, not the LIVE runtime data the rest of the exclude list protects -- see stage_db8_schema's
# comment in common.sh). Provision them to their real, system-wide db8 location instead.
stage_db8_schema "$REPO/com.palm.service.contacts.linker/db/kinds" \
  "$REPO/com.palm.service.contacts.linker/db/permissions" com.palm.service.contacts.linker

# LS2 hub activation files -- byte-identical copies of what the STOCK com.palm.service.contacts.linker
# ipk always shipped (verified against a pristine stock rootfs image; see stage_extra_file's comment
# in common.sh for why this matters -- same "upgrade silently deletes files the new ipk doesn't
# declare" mechanism that broke com.palm.service.accounts). Note the public-bus role is genuinely
# MORE RESTRICTIVE than private (empty allowedNames/permissions) -- this service is private-bus-only
# by design, and stock never shipped a public dbus/services activation file for it either.
stage_extra_file "$REPO/com.palm.service.contacts.linker/ls2/roles/prv/com.palm.service.contacts.linker.json" \
  /usr/share/ls2/roles/prv/com.palm.service.contacts.linker.json com.palm.service.contacts.linker
stage_extra_file "$REPO/com.palm.service.contacts.linker/ls2/roles/pub/com.palm.service.contacts.linker.json" \
  /usr/share/ls2/roles/pub/com.palm.service.contacts.linker.json com.palm.service.contacts.linker
stage_extra_file "$REPO/com.palm.service.contacts.linker/ls2/services/com.palm.service.contacts.linker.service" \
  /usr/share/dbus-1/system-services/com.palm.service.contacts.linker.service com.palm.service.contacts.linker

# Activity Manager watch that kicks off the linker on contact db changes -- also stock-shipped
# outside $DST, also tracked in-repo already, also never actually deployed until now.
stage_extra_file "$REPO/com.palm.service.contacts.linker/activities/com.palm.service.contacts.linker/com.palm.service.contacts.linker.json" \
  /etc/palm/activities/com.palm.service.contacts.linker/com.palm.service.contacts.linker.json com.palm.service.contacts.linker

# filecache_types CONFIG (loWatermark/hiWatermark sizing, not the runtime cache blobs -- those live
# under $DST/filecache_types and are protected by the preserve-subpath exclude above instead).
stage_extra_file "$REPO/com.palm.service.contacts.linker/filecache_types/contactphoto" \
  /etc/palm/filecache_types/contactphoto com.palm.service.contacts.linker
stage_extra_file "$REPO/com.palm.service.contacts.linker/filecache_types/contactvcard" \
  /etc/palm/filecache_types/contactvcard com.palm.service.contacts.linker

echo "com.palm.service.contacts.linker stage complete: $STAGE"
