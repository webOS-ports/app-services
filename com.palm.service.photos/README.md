com.palm.service.photos
=======================

The photos service of webOS 3.0 (the "Photos & Videos" aggregator),
written anew for LuneOS. It:

* brings the photos of every account with the `PHOTO.UPLOAD` capability
  to the device, as far as they are looked at: each cloud album becomes a
  `com.palm.media.image.album:1` entry, and once it has been opened each
  of its photos a `com.palm.media.image.file:1` entry with the file (or
  its preview) under
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
| `listAlbums` | `accountId` | `albums: [{aid, name, size: {images, videos}, parentAid, cover}]`, `headers` |
| `listPhotos` | `accountId, aid` | `photos: [{pid, src_big, src_small, caption, type, fileName}]`, `headers` |
| `getPhoto` (optional) | `accountId, aid, pid` | `src_big`, `headers`, `fileName` |
| `upload` | `accountId, albumId (the aid), path` | `pid` |
| `deletePhoto` | `accountId, pid` | |

Only what is looked at comes down. A sync lists the albums
(`listAlbums`), not their photos: an album's photos are listed once the
app has opened it (`syncAlbum`; its entry is then `listed: true`), and
with every sync from then on. An album synced by an older service is
taken as listed when it has photos here.

`cover`, when given, is a link to a small picture of the album
(PiGallery2's thumbnail of the photo it shows on the folder). It comes
down, four at a time, for each album that shows no photos of its own
(one not opened yet, or one with only sub-albums), with the listing's
`headers`,
into the album's directory as `.cover-<hash>`, and the entry's
`coverPath` names it: the app shows it on the album until the album's
own photos are here. The link without its query tells one cover from
another, so a token that changes fetches nothing again. A cover that
does not come down, or is no picture, leaves the album without one; it
fails no sync.

Of a photo whose `src_small` is a link of its own (not the same as
`src_big`: PiGallery2's, Immich's and PhotoPrism's thumbnails) only that
preview comes down; the grid thumbnail is made from it, its file is the
entry's `path`, and the entry has `original: "remote"` and no
`appOriginal`. The whole picture comes down when it is wanted: when the
photo is opened (`generateImgForBigView`, whose screen-size copy is then
made from it, never from the preview), shared, printed or made the
wallpaper (`fetchOriginal`), or copied to another album. It replaces the
preview (`original: "local"`, `appOriginal` set). Its link is asked for
then, as links are kept nowhere: with the connector's `getPhoto` when it
has one, else by listing the album again (`have` is then every other
photo of it). A photo whose `src_small` is its `src_big`, or that has
none, comes down whole as it is listed, as before.

How much they take: the whole pictures here (those fetched when opened,
and every photo of a connector with no preview of its own; not videos)
are kept up to a cap, the user's setting (`setStorage`, 200 MB to start
with): 100, 200 or 500 MB, or 1 GB doubling up to 256 GB, of which
`getStorage` offers those that fit in the space there is for them. Past
it, those opened longest ago go back to `original: "remote"`, their grid
thumbnail standing in as `path` until they are wanted again; their
screen-size copy goes with them. Nothing comes down while less than
1 GB is free. An album not opened for 30 days goes back to unopened:
its photos go, and its cover comes down. `clearDownloads` does that to
every opened album at once. Albums kept on the device (`keepAlbum`) are
left out of all of it. The photo entries cannot be searched by when a
photo was opened, so that, and the setting, are in
`.photosApp/.storage.json`.

`src_big` is downloaded with Node's own `fetch` (https). `fileName`, when
given, names the file; otherwise the last part of the URL does, and the
extension is set from what the file turns out to be. The links themselves
are not kept: they often carry an access token. A cloud album's directory
is the service's alone: what is in it without an entry (a download whose
entry was lost) is removed when the album has synced.

`parentAid`, when given, is the aid of the album this one is in (a
folder in a folder). The album's entry keeps it, and the parent's `_id`
as `parentId`, which the Photos app reads to show sub-albums inside their
album; top-level albums have `parentId: ""`. A parent that is not listed,
or a chain of parents that loops, leaves the album at the top. Every album
is synced in its own right, sub-albums too; an album with only sub-albums
is listed with no photos.

`headers`, when given, are sent with each of that listing's downloads,
for a connector whose links work only with its session (PiGallery2's
cookie). Only `Cookie` and `Authorization` are taken, as single-line
strings; with anything else no headers are sent. With headers a download
follows no redirect, so the session goes nowhere else. They are kept
nowhere, as the links are not.

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
| `syncAlbum` | `{albumId}`: the album's photos listed and their previews brought down, now and with every sync after; answers `{photos}` once the thumbnails are made |
| `fetchOriginal` | `{_id}`: the photo's whole picture on the device; answers its `path` |
| `keepAlbum` | `{albumId, keep}`: `keep: true` lists the album and brings every whole picture of it down, none of which counts for the cap or goes; answers `{photos, fetched, failed}` when they are down. `keep: false` counts them again |
| `getStorage` | `{capBytes, capChoices, capNowBytes, floorBytes, freeBytes, expireDays, originals: {count, bytes}, kept: {albums, count, bytes}, otherBytes}`: the whole pictures counted for the cap, those of kept albums, and the rest of `.photosApp` (previews, covers, thumbnails) |
| `setStorage` | `{capBytes}`, one of `capChoices`: answers as `getStorage`, after dropping what is now past it |
| `clearDownloads` | every opened cloud album not kept back to unopened; answers `{cleared: {albums, photos}}` and what `getStorage` does |
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
