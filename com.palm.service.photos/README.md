com.palm.service.photos
=======================

The photos service of webOS 3.0 (the "Photos & Videos" aggregator),
written anew for LuneOS. It:

* brings the photos of every account with the `PHOTO.UPLOAD` capability
  down to the device: each cloud album becomes a
  `com.palm.media.image.album:1` entry, each photo a
  `com.palm.media.image.file:1` entry with the file under
  `/media/internal/.photosApp/<templateId>/<user>/<album>/`;
* makes the grid thumbnail of each photo it writes, and the screen-size
  copy of any photo on request;
* does the album and photo work the Photos app asks for: create, rename
  and delete albums, copy photos between albums (device to cloud is an
  upload), delete photos (a cloud photo in the cloud as well);
* keeps the app informed of which account is busy.

The files the device has itself are indexed, and thumbnailed, by the media
indexer (`org.webosports.service.mediaindexer`). This service only makes
thumbnails for the entries it writes (`appCacheComplete: "unattempted"`).

Cloud accounts
--------------

Each cloud account's own service does the talking to the cloud; this
service calls it. Its name comes from the account template id:
`com.palm.<x>` is served by `com.palm.service.<x>` (`com.palm.boxnet` ->
`com.palm.service.boxnet`), so a new connector needs no change here. The
three services webOS 3.0 shipped (Facebook, Photobucket, Snapfish) keep
their own names and capabilities.

A connector's service answers:

| method | parameters | answer |
|---|---|---|
| `listAlbums` | `accountId` | `albums: [{aid, name, size: {images, videos}}]` |
| `listPhotos` | `accountId, aid` | `photos: [{pid, src_big, src_small, caption, type, fileName}]` |
| `upload` | `accountId, albumId (the aid), path` | `pid` |
| `deletePhoto` | `accountId, pid` | |

`src_big` is downloaded with Node's own `fetch` (https). `fileName`, when
given, names the file; otherwise the last part of the URL does, and the
extension is set from what the file turns out to be. The links themselves
are not kept: they often carry an access token. A cloud album's directory
is the service's alone: what is in it without an entry (a download whose
entry was lost) is removed when the album has synced.

The connectors from webos-synergy-revival follow this contract. Their
`photos-integration/patches` for the old service are part of this one:
the service name from the template id, `fileName`, https downloads, and a
cloud photo being deleted in the cloud first (and kept when that fails).
One thing differs from that patch: only a delete the user asks for
(`deletePhotos`) goes to the cloud. A sync removing what the cloud no
longer has, or removing an account, only clears the device.

Methods
-------

Every method of the webOS 3.0 service is here under its old name and with
its old answers, the `facebook*` ones included, as the Photos app still
calls those:

| method | what |
|---|---|
| `subscribeToAccountsInfo` | first `{accounts: {<id>: {syncStatus, isEnabled, ...}}}`, then one account at a time as its `syncStatus` changes; subscribing syncs everything |
| `getAccountsCapability` | `{AccountsCapability: {local: {...}, <templateId>: {...}}}` |
| `remoteSyncAlbums`, `facebookSyncAlbums` | sync every enabled cloud account |
| `syncSingleAccount` | `{accountId}` |
| `onEnabled`, `onCredentialsChanged`, `onDelete`, `facebookClearCache` | the account capability hooks (`onDelete` removes what was synced) |
| `generateThumbnails`, `cacheThumbnails` | thumbnails for every entry waiting for one |
| `generateImgForBigView`, `facebookGenerateImgForBigView` | `{_id}`: the screen-size copy (`appScreenNail`) |
| `getPhotoComments`, `facebookGetPhotoComments` | `{_id}` |
| `addPhotoComments`, `facebookAddPhotoComments` | `{photo: {_id}, text}` |
| `createAlbum`, `addAlbum` | `{name, accountId: "local", specs}` |
| `renameAlbum` | `{albumId, newName}` (device albums) |
| `deleteAlbum` | `[albumId, ...]` (device albums, with their photos) |
| `addPhotos` | `{targetAlbum, specs: [{sourceAlbum, exclude, photos, targetAlbum}]}` |
| `deletePhotos` | `{specs: [{sourceAlbum, exclude, photos}]}` |
| `cleanupCache` | the thumbnails of entries deleted without them |
| `rmLeftOvers` | what an interrupted account removal left |
| `hello`, `quit` | |

A spec names photos by id; with `exclude` it means every photo of
`sourceAlbum` except those.

Differences from webOS 3.0
--------------------------

* Thumbnails are made with `gst-launch-1.0` (jpeg, png and gdk-pixbuf
  decoders, `videoconvertscale`, `videoflip` for the EXIF orientation), as
  LuneOS has no extractfs. Very wide or tall pictures are scaled to fit,
  not cropped.
* Image types are read from the file header (`lib/imageinfo.js`), not
  asked of fileparserd.
* There is no USB mass-storage mode on LuneOS, so nothing waits for it.
* `hackAddFiles`, a debugging aid, is gone.
* Times are seconds since the epoch in UTC.
* Every path the service deletes, renames or reads for a thumbnail must be
  inside `/media/internal` (resolved through symlinks): the entries come
  from the media database, which other apps write too, and the service
  runs as root.

The grants on the media kinds, which the media indexer owns, are the
`db/permissions/com.palm.service.photos-*` files. They have to be at the
top of `/etc/palm/db/permissions`: the configurator applies the files in a
service's own subdirectory as that service, and only a kind's owner may
grant on it.

The service is a Node module (`package.json`); run-js-service starts it
when it is called and it exits after five idle minutes. It talks to the
bus through palmbus directly.

Tests
-----

    node --test --test-timeout=30000 tests/*.test.js

They run on the build host, against an in-memory db8 and fake cloud
services (`tests/fake.js`); GStreamer is not needed.
