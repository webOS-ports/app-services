#!/bin/bash
# common.sh — shared staging helper for packaging/*/stage.sh scripts in this repo.
set -euo pipefail

# stage_whole <src-dir> <dest-absolute-path> <pkg-name> [preserve-subpath ...]
# Stages an entire app/framework directory as the package payload (excluding dev-only cruft:
# tests, CI/build scripts, Ruby bundler files -- not part of the running app/framework), plus a
# dest.txt naming the real absolute path postinst/prerm replace. One ipk == one whole-directory
# replacement (not a surgical per-file patch): the repo is the single source of truth for this
# component, so shipping everything (not just recently-touched files) keeps a fresh install and an
# upgrade identical instead of depending on accumulated history.
#
# <pkg-name> scopes the staging path per package (/media/cryptofs/app-services-overwrite/<pkg-name>/...) --
# without this, every package's payload/appinfo.json, payload/depends.js, dest.txt etc. would all
# land at the exact same shared path, and ipkg treats two packages both shipping the same tracked
# filename as a hard conflict (confirmed live installing accounts then phone).
#
# [preserve-subpath ...]: relative subpaths (e.g. "filecache_types") that hold LIVE RUNTIME DATA
# collocated in the same directory as the code (e.g. contacts.linker's on-device
# filecache_types/{contactphoto,contactvcard} cache) rather than tracked source -- postinst/prerm
# must carry these across the rm -rf/replace instead of deleting them. Written to preserve.txt so
# postinst/prerm (which only see the staged payload, not this script) know what to protect.
stage_whole() {
  local src="$1" dst="$2" name="$3"; shift 3 || true
  [ -d "$src" ] || { echo "!! stage_whole: $src missing" >&2; exit 1; }
  local ov="$STAGE/media/cryptofs/app-services-overwrite/$name"
  mkdir -p "$ov"
  echo "$dst" > "$ov/dest.txt"
  : > "$ov/preserve.txt"
  local excludes=(--exclude=spec --exclude=mock --exclude=test --exclude=Gemfile
    --exclude=Gemfile.lock --exclude=Rakefile --exclude=ci_build.sh --exclude=run_tests.sh
    --exclude=all-tests.json --exclude='.rvmrc' --exclude='.project' --exclude='.git')
  local p
  for p in "$@"; do
    excludes+=(--exclude="$p")
    echo "$p" >> "$ov/preserve.txt"
  done

  # Symlinks can't be staged through the payload at all: /media/cryptofs is a FUSE mount that
  # rejects symlink() outright ("Operation not permitted", confirmed live packaging
  # messaging.library's version/1.0 -> ../submission/1.3). Record them separately and exclude
  # their paths from the tar; postinst recreates them with a real ln -s at the final (root-fs,
  # symlink-capable) destination after copying the rest of the payload there.
  : > "$ov/symlinks.txt"
  local link relpath target
  while IFS= read -r -d '' link; do
    relpath="${link#"$src"/}"
    target="$(readlink "$link")"
    printf '%s\t%s\n' "$relpath" "$target" >> "$ov/symlinks.txt"
    excludes+=(--exclude="$relpath")
  done < <(find "$src" -type l -print0)

  # --owner=0 --group=0: built on a dev machine under a regular user account, and GNU tar
  # on-device tries to restore the archive's recorded ownership on extraction as root by default --
  # confirmed live (core-apps packaging) this fails per-file on cryptofs and measurably slows
  # extraction. Store everything as root instead (postinst's --no-same-owner belt-and-suspenders
  # the same fix on the extraction side). Ship the payload as ONE tarball, not thousands of loose
  # files in data.tar.gz: confirmed live that ipkg's own offline-root extraction of ~2800 loose
  # files took ~139s, vs ~13s for a single-file data.tar.gz -- ipkg's own per-file bookkeeping (not
  # raw cryptofs FUSE throughput) is the bottleneck.
  tar -C "$src" "${excludes[@]}" --owner=0 --group=0 -czf "$ov/payload.tar.gz" .
}

# stage_db8_schema <kinds-dir> <permissions-dir> <pkg-name>
# Provisions db8 kind/permission definitions to their real, SYSTEM-WIDE location
# (/etc/palm/db/kinds, /etc/palm/db/permissions) -- NOT inside this service's own
# /usr/palm/services/<id>/db/ directory that stage_whole ships (confirmed live: db8 never scans
# that path at all; a permissions file sitting there is completely inert, which is exactly why
# com.palm.person's caller list silently never took effect no matter how it was edited here).
# Reuses the SAME per-package OV subdir stage_whole uses for this <pkg-name> (adds db8-kinds/ and
# db8-permissions/ subtrees to it) so postinst applies both in one pass, right after the main
# payload. See postinst for the putKind/putPermissions calls that actually register these with
# the running db8 daemon -- dropping the files alone is not enough for an already-booted device
# to pick them up (matches the proven mechanism in webos-synergy-revival/carddav's
# provision-cdav-db.sh).
stage_db8_schema() {
  local kinds_dir="$1" perms_dir="$2" name="$3"
  local ov="$STAGE/media/cryptofs/app-services-overwrite/$name"
  mkdir -p "$ov/db8-kinds" "$ov/db8-permissions"
  local f
  if [ -d "$kinds_dir" ]; then
    for f in "$kinds_dir"/*; do
      [ -f "$f" ] || continue
      cp "$f" "$ov/db8-kinds/$(basename "$f")"
    done
  fi
  if [ -d "$perms_dir" ]; then
    for f in "$perms_dir"/*; do
      [ -f "$f" ] || continue
      cp "$f" "$ov/db8-permissions/$(basename "$f")"
    done
  fi
}

# stage_tempdb_schema <kinds-dir> <permissions-dir> <pkg-name>
# Same as stage_db8_schema, but for kinds/permissions that live in the SEPARATE tempdb mojodb
# instance (/etc/palm/tempdb/{kinds,permissions}, luna service com.palm.tempdb -- NOT com.palm.db).
# Confirmed live (2026-08-04, com.palm.account.syncstate/com.palm.signaling): this is the exact same
# category of gap as stage_db8_schema originally fixed, one level further down -- these files were
# tracked in-repo (byte-identical to stock) but NEVER shipped anywhere by this packaging tree at
# all, so mojodb-luna's tempdb instance never had them, producing a permanent
# "kind not registered: 'com.palm.account.syncstate:1' (-3970)" log-spam loop from every caller that
# watches it (com.palm.app.accounts, com.palm.systemui) regardless of how many times
# com.palm.service.accounts itself gets reinstalled.
stage_tempdb_schema() {
  local kinds_dir="$1" perms_dir="$2" name="$3"
  local ov="$STAGE/media/cryptofs/app-services-overwrite/$name"
  mkdir -p "$ov/tempdb-kinds" "$ov/tempdb-permissions"
  local f
  if [ -d "$kinds_dir" ]; then
    for f in "$kinds_dir"/*; do
      [ -f "$f" ] || continue
      cp "$f" "$ov/tempdb-kinds/$(basename "$f")"
    done
  fi
  if [ -d "$perms_dir" ]; then
    for f in "$perms_dir"/*; do
      [ -f "$f" ] || continue
      cp "$f" "$ov/tempdb-permissions/$(basename "$f")"
    done
  fi
}

# stage_extra_file <src-file> <dest-absolute-path> <pkg-name>
# Ships a single file to an absolute destination OUTSIDE the one directory stage_whole replaces.
# Real webOS service packages fan out to several absolute paths beyond their own service directory
# -- LS2 hub activation (/usr/share/ls2/roles/{prv,pub}/<name>.json,
# /usr/share/dbus-1/system-services/<name>.service), Activity Manager watches
# (/etc/palm/activities/<name>/*.json), filecache_types config, etc. stage_whole's own ipk manifest
# only ever lists paths under its one $DST, so none of those ever get (re-)shipped by it.
#
# THIS IS NOT OPTIONAL METADATA -- confirmed live and root-caused (2026-08-04,
# com.palm.service.accounts): the STOCK ipk for that service shipped exactly these 4 extra files
# (verified against a pristine stock rootfs image), and the service worked fine for as long as they
# were present. The custom whole-directory-replace ipk this packaging/ tree builds does NOT declare
# them in ITS OWN file manifest -- and standard ipkg upgrade semantics DELETE any file the OLD
# installed package listed that the NEW package doesn't. Installing our repackaged
# com.palm.service.accounts as an upgrade over the stock package silently deleted its LS2 role +
# dbus activation files, permanently breaking on-demand launch (survives even a full reboot: nothing
# else creates these files). com.palm.service.contacts.linker's stock ipk has the equivalent gap
# (LS2 role/service files it never got called out here before, plus an /etc/palm/activities watch
# and /etc/palm/filecache_types config already tracked in this repo but never actually deployed).
# Whenever a package here replaces something that used to be a stock-shipped ipk, check that stock
# ipk's own file list for anything outside the one directory stage_whole targets, and ship it via
# this helper instead of silently dropping it on install.
stage_extra_file() {
  local src="$1" dest="$2" name="$3"
  [ -f "$src" ] || { echo "!! stage_extra_file: $src missing" >&2; exit 1; }
  local ov="$STAGE/media/cryptofs/app-services-overwrite/$name"
  mkdir -p "$ov/extra-files"
  local idx
  idx="$(find "$ov/extra-files" -maxdepth 1 -name '*.dest' 2>/dev/null | wc -l)"
  cp "$src" "$ov/extra-files/$idx.content"
  printf '%s' "$dest" > "$ov/extra-files/$idx.dest"
}
