// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The service as a whole against the fake bus: syncing a cloud account,
// deleting photos, removing an account, albums, copies, thumbnails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const log = require('../lib/log');
const {Paths} = require('../lib/files');
const {PhotosService} = require('../lib/photos');
const {methods} = require('../lib/methods');
const {FakeBus, FakeThumbnailer, fakeDownload, png, jpeg, tmpRoot} = require('./fake');

log.setQuiet(true);

const TPL = 'com.palm.dropbox';
const GB = 1024 * 1024 * 1024;
const SVC = 'com.palm.service.dropbox';

// A Dropbox-like account with its albums and photos, and the bytes behind the photos' links
function setup(t, {albums, photos} = {}) {
	const root = tmpRoot();
	t.after(root.cleanup);
	const bus = new FakeBus();
	const files = new Map();
	const cloud = {
		albums: albums || [
			{aid: '/Camera Uploads', name: 'Camera Uploads', size: {images: 2, videos: 0}},
			{aid: '/Trips', name: 'Trips', size: {images: 1, videos: 0}}
		],
		photos: photos || {
			'/Camera Uploads': [
				{pid: 'id:1', src_big: 'https://dl.example/t/AAA?token=s3cret', caption: 'one', type: 'image', fileName: 'one.jpg'},
				{pid: 'id:2', src_big: 'https://dl.example/t/BBB?token=s3cret', caption: 'two', type: 'image', fileName: 'two.jpg'}
			],
			'/Trips': [
				{pid: 'id:3', src_big: 'https://dl.example/t/CCC?token=s3cret', caption: 'rome', type: 'image', fileName: 'rome.jpg'}
			]
		},
		deleted: [],
		uploaded: [],
		failDelete: false
	};
	files.set('https://dl.example/t/AAA?token=s3cret', jpeg(4000, 3000, {orientation: 6}));
	// Named .jpg by the service, but a PNG
	files.set('https://dl.example/t/BBB?token=s3cret', png(800, 600));
	files.set('https://dl.example/t/CCC?token=s3cret', jpeg(1024, 768));
	bus.providers[SVC] = {
		listAlbums: () => ({returnValue: true, albums: cloud.albums}),
		listPhotos: p => ({returnValue: true, photos: cloud.photos[p.aid] || []}),
		deletePhoto: p => {
			if (cloud.failDelete) {
				return {returnValue: false, errorCode: 'NETWORK', errorText: 'offline'};
			}
			cloud.deleted.push(p);
			return {returnValue: true};
		},
		upload: p => {
			cloud.uploaded.push(p);
			return {returnValue: true, pid: `id:up${cloud.uploaded.length}`};
		}
	};
	bus.db.handle('put', {objects: [{
		_kind: 'com.palm.account:1', _id: 'acct1', username: 'me@example.org', templateId: TPL, beingDeleted: false,
		capabilityProviders: [{capability: 'DOCUMENTS'}, {capability: 'PHOTO.UPLOAD'}]
	}]});
	const paths = new Paths(root.media);
	const thumbs = new FakeThumbnailer();
	const download = fakeDownload(files);
	// The free space and the time, as the tests set them
	const space = {free: 64 * GB};
	const clock = {t: Date.UTC(2026, 10, 1)};
	const statfs = async () => ({bavail: Math.floor(space.free / 4096), bsize: 4096});
	const svc = new PhotosService({bus, paths, thumbnailer: thumbs, download, statfs, now: () => clock.t});
	t.after(() => svc.stop());
	const api = methods(svc);
	// A sync, and every album it brought opened, as the app opens one: everything comes down
	// (the previews, where there are any), as a sync brought everything before albums were
	// listed only once opened. Answers as syncSingleAccount does.
	const sync = async () => {
		let r = await api.syncSingleAccount({accountId: 'acct1'});
		for (const a of bus.db.live('com.palm.media.image.album:1').filter(x => x.accountId === 'acct1' && x.listed !== true)) {
			try {
				await api.syncAlbum({albumId: a._id});
			} catch (e) {
				if (r.returnValue) {
					r = {returnValue: false, error: e.message};
				}
			}
		}
		return r;
	};
	return {root, bus, cloud, files, paths, thumbs, download, svc, api, sync, space, clock, statfs};
}

const photosOf = (bus, accountId) =>
	bus.db.live('com.palm.media.types:1').filter(p => p.accountId === accountId);
const albumsOf = (bus, accountId) =>
	bus.db.live('com.palm.media.image.album:1').filter(a => a.accountId === accountId);

test('first sync: albums, photos, thumbnails; no link token is kept', async t => {
	const {bus, svc, api, paths, thumbs, sync} = setup(t);
	await svc.start();
	assert.deepEqual((await api.getAccountsCapability()).AccountsCapability[TPL].serviceName, SVC);

	assert.deepEqual(await sync(), {returnValue: true});
	const albums = albumsOf(bus, 'acct1');
	assert.deepEqual(albums.map(a => a.name).sort(), ['Camera Uploads', 'Trips']);
	for (const a of albums) {
		assert.equal(a.type, TPL);
		assert.equal(a.showAlbum, true);
		assert.ok(paths.inCache(a.path), a.path);
	}
	const photos = photosOf(bus, 'acct1');
	assert.equal(photos.length, 3);
	for (const p of photos) {
		assert.equal(p.appCacheComplete, true, 'thumbnail made in the same sync');
		assert.ok(p.appGridThumbnail && p.appGridThumbnail.path.startsWith(paths.generated));
		assert.ok(fs.existsSync(p.path));
		assert.equal(p.path, p.appOriginal);
		assert.ok(p[TPL].pid);
		assert.ok(!JSON.stringify(p).includes('s3cret'), 'no token in the entry');
	}
	const two = photos.find(p => p[TPL].pid === 'id:2');
	assert.equal(path.basename(two.path), 'two.png', 'extension follows the content');
	const one = photos.find(p => p[TPL].pid === 'id:1');
	assert.equal(path.basename(one.path), 'one.jpg', 'fileName used, not the opaque link');
	assert.equal(one.caption, 'one');
	// The size as shown, as the indexer gives the device's own: the sideways JPEG stood up
	assert.deepEqual([one.width, one.height], [3000, 4000]);
	assert.deepEqual([two.width, two.height], [800, 600]);
	const rome = photos.find(p => p[TPL].pid === 'id:3');
	assert.deepEqual([rome.width, rome.height], [1024, 768]);
	assert.equal(thumbs.made.length, 3);
	// The sync state the accounts app shows is gone again
	assert.equal(bus.tempdb.live('com.palm.account.syncstate:1').length, 0);
	assert.equal(bus.callsTo('com.palm.tempdb', 'put').length, 1);
});

test('resync: what the cloud dropped goes here only; renames and captions follow', async t => {
	const {bus, svc, api, cloud, sync} = setup(t);
	await svc.start();
	await sync();
	const before = photosOf(bus, 'acct1');
	const gone = before.find(p => p[TPL].pid === 'id:2');
	const trips = albumsOf(bus, 'acct1').find(a => a.name === 'Trips');

	cloud.photos['/Camera Uploads'] = [
		{pid: 'id:1', src_big: 'https://dl.example/t/AAA?token=s3cret', caption: 'one, edited', type: 'image', fileName: 'one.jpg'},
		{pid: 'id:9', src_big: 'https://dl.example/t/CCC?token=s3cret', caption: 'new', type: 'image', fileName: 'one.jpg'}
	];
	cloud.albums = [{aid: '/Camera Uploads', name: 'Camera Roll', size: {images: 2, videos: 0}}];
	assert.deepEqual(await api.remoteSyncAlbums({}), {returnValue: true, msg: 'Syncing completed successfully'});

	assert.equal(cloud.deleted.length, 0, 'a sync never deletes in the cloud');
	const albums = albumsOf(bus, 'acct1');
	assert.deepEqual(albums.map(a => a.name), ['Camera Roll']);
	assert.ok(!fs.existsSync(trips.path), 'the dropped album directory is gone');
	const photos = photosOf(bus, 'acct1');
	assert.deepEqual(photos.map(p => p[TPL].pid).sort(), ['id:1', 'id:9']);
	assert.ok(!fs.existsSync(gone.path));
	assert.equal(photos.find(p => p[TPL].pid === 'id:1').caption, 'one, edited');
	const nine = photos.find(p => p[TPL].pid === 'id:9');
	assert.notEqual(nine.path, photos.find(p => p[TPL].pid === 'id:1').path, 'same fileName, own file');
	assert.equal(albums[0].total.images, 2);
});

test('an empty placeholder album that becomes a real folder, and back, stays the same album', async t => {
	const {bus, svc, cloud, sync} = setup(t, {
		albums: [{aid: '', name: 'Camera Uploads', size: {images: 0, videos: 0}}, {aid: '', name: 'Ignored twin'}],
		photos: {}
	});
	await svc.start();
	await sync();
	const [placeholder] = albumsOf(bus, 'acct1');
	assert.equal(placeholder.aid, '');

	cloud.albums = [{aid: 'WnJz2ZjA', name: 'Camera Uploads', size: {images: 1, videos: 0}}];
	cloud.photos.WnJz2ZjA = [{pid: 'id:1', src_big: 'https://dl.example/t/AAA?token=s3cret', type: 'image', fileName: 'one.jpg'}];
	assert.equal((await sync()).returnValue, true);
	let albums = albumsOf(bus, 'acct1');
	assert.deepEqual(albums.map(a => [a._id, a.aid]), [[placeholder._id, 'WnJz2ZjA']], 'same entry, new aid');
	assert.deepEqual(photosOf(bus, 'acct1').map(p => [p.albumId, p[TPL].pid]), [[placeholder._id, 'id:1']]);

	cloud.albums = [{aid: '', name: 'Camera Uploads', size: {images: 0, videos: 0}}];
	assert.equal((await sync()).returnValue, true);
	albums = albumsOf(bus, 'acct1');
	assert.deepEqual(albums.map(a => [a._id, a.aid]), [[placeholder._id, '']], 'and back');
	assert.equal(photosOf(bus, 'acct1').length, 0);

	// Another name is another album: the placeholder goes, the folder is new
	cloud.albums = [{aid: '/Trips', name: 'Trips', size: {images: 0, videos: 0}}];
	await sync();
	albums = albumsOf(bus, 'acct1');
	assert.equal(albums.length, 1);
	assert.notEqual(albums[0]._id, placeholder._id);

	// Two real folders of one name are two albums, even when one replaces the other
	const trips = albums[0];
	cloud.albums = [{aid: '/Old/Trips', name: 'Trips', size: {images: 0, videos: 0}}];
	await sync();
	albums = albumsOf(bus, 'acct1');
	assert.deepEqual(albums.map(a => a.aid), ['/Old/Trips']);
	assert.notEqual(albums[0]._id, trips._id);
});

test('a failing download fails the sync but keeps the rest', async t => {
	const {bus, svc, files, sync} = setup(t);
	files.delete('https://dl.example/t/BBB?token=s3cret');
	await svc.start();
	const r = await sync();
	assert.equal(r.returnValue, false);
	assert.match(r.error, /404/);
	assert.deepEqual(photosOf(bus, 'acct1').map(p => p[TPL].pid).sort(), ['id:1', 'id:3']);
	assert.equal(svc.accounts.view('acct1').syncStatus, 'idle');
	files.set('https://dl.example/t/BBB?token=s3cret', png(10, 10));
	assert.equal((await sync()).returnValue, true);
	assert.equal(photosOf(bus, 'acct1').length, 3, 'picked up next time');
});

test('listPhotos is told what the service has; a temporary copy is fetched to be removed', async t => {
	const {bus, svc, cloud, download, sync} = setup(t);
	const asked = [];
	const listPhotos = bus.providers[SVC].listPhotos;
	bus.providers[SVC].listPhotos = p => {
		asked.push(p);
		return listPhotos(p);
	};
	cloud.photos['/Trips'][0].temporary = true;
	await svc.start();
	await sync();
	assert.deepEqual(asked.map(p => [p.aid, p.have]), [['/Camera Uploads', []], ['/Trips', []]], 'new albums: nothing yet');
	assert.deepEqual(download.fetched.map(f => [f.url, f.removeSource]).sort(), [
		['https://dl.example/t/AAA?token=s3cret', false],
		['https://dl.example/t/BBB?token=s3cret', false],
		['https://dl.example/t/CCC?token=s3cret', true]
	]);

	asked.length = 0;
	await sync();
	assert.deepEqual(asked.map(p => [p.aid, [...p.have].sort()]), [['/Camera Uploads', ['id:1', 'id:2']], ['/Trips', ['id:3']]]);
	assert.equal(photosOf(bus, 'acct1').length, 3);
});

test('a download may copy local files from the media root only', async t => {
	const {svc, paths, download, sync} = setup(t);
	await svc.start();
	await sync();
	assert.ok(download.fetched.length);
	assert.ok(download.fetched.every(f => f.localRoot === paths.media));
});

test('something that is no image is kept but never shown, and not fetched again', async t => {
	const {bus, svc, files, download, sync} = setup(t);
	files.set('https://dl.example/t/CCC?token=s3cret', Buffer.from('<html>login page</html>'));
	await svc.start();
	await sync();
	const rome = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:3');
	assert.equal(rome.appCacheComplete, false);
	const fetched = download.fetched.length;
	await sync();
	assert.equal(download.fetched.length, fetched);
});

test('deleting a cloud photo deletes it in the cloud first', async t => {
	const {bus, svc, api, cloud, sync} = setup(t);
	await svc.start();
	await sync();
	const one = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:1');

	cloud.failDelete = true;
	const failed = await api.deletePhotos({specs: [{photos: [one._id]}]});
	assert.equal(failed.returnValue, false);
	assert.ok(fs.existsSync(one.path), 'kept while it is still in the cloud');
	assert.ok(photosOf(bus, 'acct1').some(p => p._id === one._id));

	cloud.failDelete = false;
	assert.deepEqual(await api.deletePhotos({specs: [{photos: [one._id]}]}), {returnValue: true, msg: 'Deleted all photos !'});
	assert.deepEqual(cloud.deleted, [{accountId: 'acct1', pid: 'id:1'}]);
	assert.ok(!fs.existsSync(one.path));
	assert.ok(!fs.existsSync(one.appGridThumbnail.path));
	const album = albumsOf(bus, 'acct1').find(a => a._id === one.albumId);
	assert.deepEqual(album.total, {images: 1, videos: 0}, 'counted again');
});

test('deletePhotos with exclude: all of the album but the listed ones', async t => {
	const {bus, svc, api, cloud, sync} = setup(t);
	await svc.start();
	await sync();
	const cam = albumsOf(bus, 'acct1').find(a => a.name === 'Camera Uploads');
	const keep = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:1');
	await api.deletePhotos({specs: [{sourceAlbum: cam._id, exclude: true, photos: [keep._id]}]});
	assert.deepEqual(cloud.deleted.map(d => d.pid), ['id:2']);
	assert.deepEqual(photosOf(bus, 'acct1').map(p => p[TPL].pid).sort(), ['id:1', 'id:3']);
});

test('removing the account clears what was synced, and nothing in the cloud', async t => {
	const {bus, svc, api, cloud, paths, sync} = setup(t);
	await svc.start();
	await sync();
	const dir = paths.accountDir(TPL, 'me@example.org');
	assert.ok(fs.existsSync(dir));

	assert.deepEqual(await api.onDelete({accountId: 'acct1'}), {returnValue: true});
	assert.equal(cloud.deleted.length, 0);
	assert.equal(albumsOf(bus, 'acct1').length, 0);
	assert.equal(photosOf(bus, 'acct1').length, 0);
	assert.ok(!fs.existsSync(dir));
	assert.ok(!fs.existsSync(path.dirname(dir)), 'the template directory, empty now, too');
	assert.ok(fs.existsSync(paths.cache));
	assert.equal(svc.accounts.has('acct1'), false);
});

test('leftovers of an interrupted removal go before the next sync', async t => {
	const {bus, svc, api, sync} = setup(t);
	await svc.start();
	await sync();
	// What a removal that died after marking the albums leaves
	bus.db.handle('merge', {query: {from: 'com.palm.media.image.album:1',
		where: [{prop: 'accountId', op: '=', val: 'acct1'}]}, props: {toBeDeleted: true}});
	bus.db.handle('del', {ids: ['acct1']});
	await new Promise(r => setTimeout(r, 20));
	await api.remoteSyncAlbums({});
	assert.equal(albumsOf(bus, 'acct1').length, 0);
	assert.equal(photosOf(bus, 'acct1').length, 0);
});

test('turning the photos off hides the albums and stops syncing; on shows them', async t => {
	const {bus, svc, api, sync} = setup(t);
	await svc.start();
	await sync();
	assert.deepEqual(await api.onEnabled({accountId: 'acct1', enabled: false}), {returnValue: true});
	assert.ok(albumsOf(bus, 'acct1').every(a => a.showAlbum === false));
	assert.equal(svc.accounts.view('acct1').isEnabled, false);
	const listed = bus.callsTo(SVC, 'listAlbums').length;
	await api.remoteSyncAlbums({});
	await sync();
	assert.equal(bus.callsTo(SVC, 'listAlbums').length, listed, 'a disabled account is not synced');

	assert.deepEqual(await api.onEnabled({accountId: 'acct1', enabled: true}), {returnValue: true});
	assert.ok(albumsOf(bus, 'acct1').every(a => a.showAlbum === true));
	await svc.syncer.sync('acct1');

	bus.credentials = false;
	await api.onEnabled({accountId: 'acct1', enabled: false});
	const listedBefore = bus.callsTo(SVC, 'listAlbums').length;
	const r = await api.onEnabled({accountId: 'acct1', enabled: true});
	assert.equal(r.returnValue, true, 'never an error: the accounts service would undo the change');
	assert.equal(svc.accounts.view('acct1').isEnabled, true, 'on, though not signed in yet');
	await new Promise(res => setTimeout(res, 20));
	assert.equal(bus.callsTo(SVC, 'listAlbums').length, listedBefore, 'and not synced before it is');
});

test('the account list follows the accounts db', async t => {
	const {bus, svc} = setup(t);
	const seen = [];
	svc.subscribe(p => seen.push(p));
	await svc.start();
	assert.ok(svc.accounts.has('acct1'));
	bus.db.handle('put', {objects: [{
		_kind: 'com.palm.account:1', _id: 'acct2', username: 'two', templateId: 'com.palm.boxnet', beingDeleted: false,
		capabilityProviders: [{capability: 'PHOTO.UPLOAD'}]
	}]});
	await new Promise(r => setTimeout(r, 20));
	assert.ok(svc.accounts.has('acct2'));
	assert.equal(svc.capsMap['com.palm.boxnet'].serviceName, 'com.palm.service.boxnet');
	assert.ok(seen.some(p => p.accounts && p.accounts.acct2));
	// The photo capability turned off: the account drops out of the query
	bus.db.handle('merge', {objects: [{_id: 'acct2', capabilityProviders: [{capability: 'DOCUMENTS'}]}]});
	await new Promise(r => setTimeout(r, 20));
	assert.equal(svc.accounts.view('acct2').isEnabled, false);
});

test('albums: create, rename, delete on the device', async t => {
	const {bus, svc, api, root} = setup(t);
	await svc.start();
	assert.equal((await api.createAlbum({name: '..', accountId: 'local'})).returnValue, false);
	assert.equal((await api.createAlbum({name: 'Hols'})).msg, 'Need a valid account Id for the album');
	assert.equal((await api.createAlbum({name: 'X', accountId: 'acct1'})).returnValue, false, 'the cloud cannot');

	const made = await api.createAlbum({name: 'Holiday', accountId: 'local'});
	assert.equal(made.returnValue, true);
	const album = Object.assign({}, bus.db.objects.get(made.albumId));
	assert.equal(album.type, 'local');
	assert.equal(album.path, path.join(root.media, 'Holiday'));
	assert.ok(fs.statSync(album.path).isDirectory());
	const again = await api.addAlbum({name: 'Holiday', accountId: 'local'});
	assert.notEqual(bus.db.objects.get(again.albumId).path, album.path);

	assert.deepEqual(await api.renameAlbum({albumId: made.albumId, newName: 'Holiday'}),
		{returnValue: false, msg: 'An Album with that name already exists'});
	assert.deepEqual(await api.renameAlbum({albumId: made.albumId, newName: 'Summer'}), {returnValue: true});
	const renamed = bus.db.objects.get(made.albumId);
	assert.equal(renamed.name, 'Summer');
	assert.equal(renamed.path, path.join(root.media, 'Summer'));
	assert.ok(fs.existsSync(renamed.path) && !fs.existsSync(album.path));

	const rootAlbum = (await bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.album:1', name: 'Pictures',
		path: root.media}]})).results[0].id;
	assert.deepEqual(await api.renameAlbum({albumId: rootAlbum, newName: 'Mine'}), {returnValue: false, msg: 'Reserved Album'});
	fs.mkdirSync(path.join(root.media, 'screencaptures'));
	const shots = bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.album:1', name: 'Screen captures',
		path: path.join(root.media, 'screencaptures')}]}).results[0].id;
	assert.deepEqual(await api.renameAlbum({albumId: shots, newName: 'Shots'}), {returnValue: false, msg: 'Reserved Album'});

	fs.writeFileSync(path.join(renamed.path, 'a.jpg'), jpeg(10, 10));
	const photo = bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.file:1', albumId: made.albumId,
		path: path.join(renamed.path, 'a.jpg'), mediaType: 'image', appCacheComplete: true}]}).results[0].id;
	// The app sends the ids as the payload itself
	assert.deepEqual(await api.deleteAlbum([made.albumId]), {returnValue: true, response: {numDeleted: 1}});
	assert.ok(!fs.existsSync(renamed.path));
	assert.ok(bus.db.objects.get(photo)._del);

	await svc.syncer.sync('acct1');
	const cloudAlbum = albumsOf(bus, 'acct1')[0];
	assert.deepEqual(await api.deleteAlbum([cloudAlbum._id]), {returnValue: true, response: {numDeleted: 0}},
		'a cloud album is not deleted this way');
	assert.deepEqual(await api.renameAlbum({albumId: cloudAlbum._id, newName: 'Y'}),
		{returnValue: false, msg: 'Cannot rename a remote Account'});
});

test('copies: to a device album as a file, to a cloud album as an upload', async t => {
	const {bus, svc, api, root, cloud, sync} = setup(t);
	await svc.start();
	await sync();
	const made = await api.createAlbum({name: 'Keep', accountId: 'local'});
	const src = path.join(root.media, 'DCIM');
	fs.mkdirSync(src);
	fs.writeFileSync(path.join(src, 'cat.jpg'), jpeg(640, 480));
	const local = bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.file:1', mediaType: 'image',
		path: path.join(src, 'cat.jpg'), albumId: 'dcim', appCacheComplete: true}]}).results[0].id;
	const cloudPhoto = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:3');

	// cloud -> device, device -> device
	const toDevice = await api.addPhotos({targetAlbum: made.albumId, specs: [{photos: [cloudPhoto._id, local]}]});
	assert.equal(toDevice.returnValue, true);
	assert.deepEqual(fs.readdirSync(path.join(root.media, 'Keep')).sort(), ['cat.jpg', 'rome.jpg']);

	// device -> cloud
	const cam = albumsOf(bus, 'acct1').find(a => a.name === 'Camera Uploads');
	const toCloud = await api.addPhotos({specs: [{targetAlbum: cam._id, photos: [local]}]});
	assert.equal(toCloud.returnValue, true);
	assert.deepEqual(cloud.uploaded, [{accountId: 'acct1', albumId: '/Camera Uploads', path: path.join(src, 'cat.jpg')}]);
	const copy = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:up1');
	assert.ok(copy && fs.existsSync(copy.path) && copy.albumId === cam._id);
	assert.deepEqual([copy.width, copy.height], [640, 480], 'the copy\'s size');
	// The next sync finds the uploaded photo there already
	assert.equal(albumsOf(bus, 'acct1').find(a => a._id === cam._id).total.images, 3, 'counted again');
	cloud.photos['/Camera Uploads'].push({pid: 'id:up1', src_big: 'https://dl.example/none', type: 'image'});
	cloud.albums[0].size = {images: 3, videos: 0};
	await sync();
	assert.equal(photosOf(bus, 'acct1').filter(p => p[TPL].pid === 'id:up1').length, 1);
	assert.equal(albumsOf(bus, 'acct1').find(a => a._id === cam._id).total.images, 3);
});

test('photos synced before entries had a size get it from their files at the next sync', async t => {
	const {bus, svc, download, sync} = setup(t);
	await svc.start();
	await sync();
	const photos = photosOf(bus, 'acct1');
	for (const p of photos) {
		delete p.width;
		delete p.height;
	}
	// One whose file is not there: left without
	const rome = photos.find(p => p[TPL].pid === 'id:3');
	fs.unlinkSync(rome.path);
	const fetched = download.fetched.length;
	const merges = bus.callsTo('com.palm.db', 'merge').length;

	await sync();
	assert.equal(download.fetched.length, fetched, 'nothing downloaded again');
	const sizes = Object.fromEntries(photosOf(bus, 'acct1').map(p => [p[TPL].pid, [p.width, p.height]]));
	assert.deepEqual(sizes, {'id:1': [3000, 4000], 'id:2': [800, 600], 'id:3': [undefined, undefined]});

	// Once they have it, not read again
	const after = bus.callsTo('com.palm.db', 'merge').length;
	await sync();
	const sized = bus.callsTo('com.palm.db', 'merge').slice(after)
		.filter(c => (c.params.objects || []).some(o => o.width !== undefined));
	assert.deepEqual(sized, []);
	assert.ok(after > merges);
});

test('thumbnails: every waiting entry once, also when it cannot be written back', async t => {
	const {bus, svc, api, root, thumbs} = setup(t);
	await svc.start();
	const dir = path.join(root.media, '.photosApp', 'x');
	fs.mkdirSync(dir, {recursive: true});
	const ids = [];
	for (let i = 0; i < 5; i++) {
		fs.writeFileSync(path.join(dir, `${i}.png`), i === 3 ? Buffer.from('nope') : png(300, 200));
		ids.push(bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.file:1', mediaType: 'image',
			path: path.join(dir, `${i}.png`), appCacheComplete: 'unattempted', albumId: 'a'}]}).results[0].id);
	}
	// One entry that is never stored, and one pointing outside the media root
	bus.db.failMerge = objects => objects.some(o => o._id === ids[4]);
	const outside = path.join(root.dir, 'outside.png');
	fs.writeFileSync(outside, png(300, 200));
	const evil = bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.file:1', mediaType: 'image',
		path: outside, appCacheComplete: 'unattempted', albumId: 'a'}]}).results[0].id;

	const r = await api.generateThumbnails({});
	assert.equal(r.returnValue, true);
	assert.equal(bus.db.objects.get(ids[0]).appCacheComplete, true);
	assert.deepEqual(bus.db.objects.get(ids[0]).appGridThumbnail.dimensions,
		{'original-width': 300, 'original-height': 200, 'output-width': 200, 'output-height': 200});
	assert.equal(bus.db.objects.get(ids[3]).appCacheComplete, false);
	assert.equal(bus.db.objects.get(ids[4]).appCacheComplete, 'unattempted');
	assert.equal(bus.db.objects.get(evil).appCacheComplete, false);
	assert.ok(!thumbs.made.some(m => m.src === outside));
	assert.equal(bus.callsTo('com.palm.activitymanager', 'create').length, 1, 'kept awake meanwhile');
	assert.equal(bus.callsTo('com.palm.activitymanager', 'complete').length, 1);

	const big = await api.generateImgForBigView({_id: ids[0]});
	assert.deepEqual(big, {returnValue: true, msg: 'Queuing request'});
	await svc.cache.screenNail(ids[0]);
	assert.ok(bus.db.objects.get(ids[0]).appScreenNail.path.includes('appScreenNail-'));
});

test('subscribeToAccountsInfo answers: the list, then one account at a time', async t => {
	const {svc} = setup(t);
	const seen = [];
	await svc.start();
	svc.subscribe(p => seen.push(p));
	await svc.syncer.sync('acct1');
	assert.deepEqual(seen.map(p => [p.accountId, p.syncStatus]).filter(p => p[0] === 'acct1'),
		[['acct1', 'processing'], ['acct1', 'idle']]);
	assert.deepEqual(Object.keys(svc.accounts.snapshot()).sort(), ['acct1', 'local']);
});

test('comments only where the account has them', async t => {
	const {bus, svc, api, sync} = setup(t);
	await svc.start();
	await sync();
	const p = photosOf(bus, 'acct1')[0];
	assert.equal((await api.facebookGetPhotoComments({_id: p._id})).returnValue, false);
	const fb = bus.db.handle('put', {objects: [{_kind: 'com.palm.media.image.file:1', accountId: 'fb1',
		type: 'com.palm.facebook', 'com.palm.facebook': {pid: 77}}]}).results[0].id;
	bus.providers['com.palm.service.photos.facebook'] = {
		getPhotoComments: () => ({returnValue: true, comments: [{text: 'nice'}]}),
		addPhotoComments: () => ({returnValue: true})
	};
	assert.deepEqual(await api.getPhotoComments({_id: fb}), {returnValue: true, result: {id: fb, comments: [{text: 'nice'}]}});
	assert.equal((await api.addPhotoComments({photo: {_id: fb}, text: 'hi'})).returnValue, true);
	assert.deepEqual(bus.db.objects.get(fb).comments, [{text: 'nice'}]);
});

test('an account removal that fails part way is finished later', async t => {
	const {bus, svc, api, paths, sync} = setup(t);
	await svc.start();
	await sync();
	const stuck = photosOf(bus, 'acct1')[0];
	bus.db.failDel = ids => ids.includes(stuck._id);
	assert.deepEqual(await api.onDelete({accountId: 'acct1'}), {returnValue: true});
	assert.equal(svc.accounts.has('acct1'), false);
	const left = albumsOf(bus, 'acct1');
	assert.equal(left.length, 1, 'the album of the photo that stayed');
	assert.equal(left[0].toBeDeleted, true);
	assert.equal(left[0].showAlbum, false);

	bus.db.failDel = null;
	assert.equal(await svc.removeLeftovers(), 1);
	assert.equal(albumsOf(bus, 'acct1').length, 0);
	assert.equal(photosOf(bus, 'acct1').length, 0);
	assert.ok(!fs.existsSync(paths.accountDir(TPL, 'me@example.org')));
});

test('cleanupCache: the files of entries that are gone, nothing else', async t => {
	const {bus, svc, api, paths, sync} = setup(t);
	await svc.start();
	await sync();
	const [gone, kept] = photosOf(bus, 'acct1');
	await svc.cache.screenNail(kept._id);
	const keptNail = bus.db.objects.get(kept._id).appScreenNail.path;
	// Deleted behind the service's back, as the indexer does
	bus.db.handle('del', {ids: [gone._id]});
	fs.writeFileSync(path.join(paths.generated, 'notes.txt'), 'mine');
	const stale = path.join(paths.generated, '.tmp-1-2.jpg');
	fs.writeFileSync(stale, 'x');
	const old = new Date(Date.now() - 2 * 3600 * 1000);
	fs.utimesSync(stale, old, old);
	fs.writeFileSync(path.join(paths.generated, '.tmp-1-3.jpg'), 'busy');

	const r = await api.cleanupCache({});
	assert.equal(r.returnValue, true);
	assert.equal(r.count, 2);
	assert.ok(!fs.existsSync(gone.appGridThumbnail.path));
	assert.ok(fs.existsSync(kept.appGridThumbnail.path));
	assert.ok(fs.existsSync(keptNail));
	assert.ok(fs.existsSync(path.join(paths.generated, 'notes.txt')));
	assert.ok(!fs.existsSync(stale));
	assert.ok(fs.existsSync(path.join(paths.generated, '.tmp-1-3.jpg')), 'a fresh one may be in use');
});

test('files whose entries were lost are taken over, and leftovers swept', async t => {
	const {bus, svc, download, sync} = setup(t);
	await svc.start();
	await sync();
	const before = photosOf(bus, 'acct1');
	const cam = albumsOf(bus, 'acct1').find(a => a.name === 'Camera Uploads');
	// The entries gone, as the media indexer at start removed them; the files stay
	bus.db.handle('del', {ids: before.map(p => p._id)});
	fs.writeFileSync(path.join(cam.path, 'stray.jpg'), 'x');
	fs.writeFileSync(path.join(cam.path, 'busy.jpg.part'), 'x');
	const fetched = download.fetched.length;
	await sync();
	const after = photosOf(bus, 'acct1');
	assert.equal(download.fetched.length - fetched, 3, 'downloaded again');
	assert.deepEqual(after.map(p => p.path).sort(), before.map(p => p.path).sort(), 'into the same files');
	assert.deepEqual(fs.readdirSync(cam.path).sort(), ['busy.jpg.part', 'one.jpg', 'two.png']);
});

test('sub-albums: each entry has its parent\'s _id, and follows it when it moves', async t => {
	const {bus, svc, cloud, sync} = setup(t, {
		albums: [
			{aid: 'Trips/Italy/Rome', name: 'Rome', parentAid: 'Trips/Italy', size: {images: 1}},
			{aid: 'Trips/Italy', name: 'Italy', parentAid: 'Trips', size: {images: 1}},
			{aid: 'Trips', name: 'Trips', size: {images: 0}},
			{aid: 'Family', name: 'Family', parentAid: 'Not/Listed', size: {images: 1}},
			{aid: 'Self', name: 'Self', parentAid: 'Self', size: {images: 0}}
		],
		photos: {
			'Trips/Italy/Rome': [{pid: 'r1', src_big: 'https://dl.example/t/AAA?token=s3cret', type: 'image', fileName: 'r.jpg'}],
			'Trips/Italy': [{pid: 'i1', src_big: 'https://dl.example/t/CCC?token=s3cret', type: 'image', fileName: 'i.jpg'}],
			Family: [{pid: 'f1', src_big: 'https://dl.example/t/BBB?token=s3cret', type: 'image', fileName: 'f.jpg'}]
		}
	});
	await svc.start();
	assert.equal((await sync()).returnValue, true);
	const byAid = () => new Map(albumsOf(bus, 'acct1').map(a => [a.aid, a]));
	let albums = byAid();
	assert.equal(albums.get('Trips/Italy/Rome').parentId, albums.get('Trips/Italy')._id, 'a parent listed after its child');
	assert.equal(albums.get('Trips/Italy/Rome').parentAid, 'Trips/Italy');
	assert.equal(albums.get('Trips/Italy').parentId, albums.get('Trips')._id);
	assert.equal(albums.get('Trips').parentId || '', '', 'top level');
	assert.equal(albums.get('Family').parentId || '', '', 'a parent not listed: top level');
	assert.equal(albums.get('Self').parentId || '', '', 'its own parent: top level');
	assert.equal(photosOf(bus, 'acct1').length, 3, 'every album\'s photos, whatever its place');

	// Rome moves to the top, Italy's parent goes away, and two albums point at each other
	cloud.albums = [
		{aid: 'Trips/Italy/Rome', name: 'Rome', size: {images: 1}},
		{aid: 'Trips/Italy', name: 'Italy', parentAid: 'Trips', size: {images: 1}},
		{aid: 'A', name: 'A', parentAid: 'B', size: {images: 0}},
		{aid: 'B', name: 'B', parentAid: 'A', size: {images: 0}},
		{aid: 'C', name: 'C', parentAid: 'A', size: {images: 0}}
	];
	assert.equal((await sync()).returnValue, true);
	albums = byAid();
	assert.equal(albums.get('Trips/Italy/Rome').parentId, '');
	assert.equal(albums.get('Trips/Italy/Rome').parentAid, '');
	assert.equal(albums.get('Trips/Italy').parentId, '', 'its parent is gone');
	assert.equal(albums.get('A').parentId || '', '', 'a loop: top level');
	assert.equal(albums.get('B').parentId || '', '');
	assert.equal(albums.get('C').parentId || '', '', 'below a loop: top level too');
});

test('download headers a listing hands over go with its downloads, and are kept nowhere', async t => {
	const {bus, svc, download, sync} = setup(t);
	const listPhotos = bus.providers[SVC].listPhotos;
	bus.providers[SVC].listPhotos = p => Object.assign(listPhotos(p),
		p.aid === '/Trips' ? {headers: {Cookie: 'session=s3cret'}} : {headers: {Cookie: 'x', Host: 'evil'}});
	await svc.start();
	await sync();
	const sent = new Map(download.fetched.map(f => [f.url, f.headers]));
	assert.deepEqual(sent.get('https://dl.example/t/CCC?token=s3cret'), {Cookie: 'session=s3cret'});
	assert.equal(sent.get('https://dl.example/t/AAA?token=s3cret'), undefined, 'headers it may not ask for: none');
	assert.ok(!JSON.stringify(bus.db.live('com.palm.media.types:1')).includes('session=s3cret'));
	assert.ok(!JSON.stringify(bus.db.live('com.palm.media.image.album:1')).includes('session=s3cret'));
});

test('a sync brings the albums only; an opened album its photos, then every sync', async t => {
	const {bus, svc, api, cloud, download} = setup(t);
	await svc.start();
	assert.deepEqual(await api.syncSingleAccount({accountId: 'acct1'}), {returnValue: true});
	const albums = albumsOf(bus, 'acct1');
	assert.deepEqual(albums.map(a => a.name).sort(), ['Camera Uploads', 'Trips']);
	assert.ok(albums.every(a => a.listed === false));
	assert.equal(photosOf(bus, 'acct1').length, 0);
	assert.equal(bus.callsTo(SVC, 'listPhotos').length, 0, 'no album listed');
	assert.equal(download.fetched.length, 0);

	const cam = albums.find(a => a.name === 'Camera Uploads');
	const r = await api.syncAlbum({albumId: cam._id});
	assert.deepEqual(r, {returnValue: true, photos: 2});
	assert.equal(albumsOf(bus, 'acct1').find(a => a._id === cam._id).listed, true);
	assert.deepEqual(bus.callsTo(SVC, 'listPhotos').map(c => c.params.aid), ['/Camera Uploads']);
	assert.ok(photosOf(bus, 'acct1').every(p => p.appCacheComplete === true), 'thumbnails made before it answers');
	assert.equal(svc.accounts.view('acct1').syncStatus, 'idle');

	cloud.photos['/Camera Uploads'].push({pid: 'id:4', src_big: 'https://dl.example/t/CCC?token=s3cret', type: 'image', fileName: 'new.jpg'});
	cloud.photos['/Trips'].push({pid: 'id:5', src_big: 'https://dl.example/t/CCC?token=s3cret', type: 'image', fileName: 'x.jpg'});
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.deepEqual(photosOf(bus, 'acct1').map(p => p[TPL].pid).sort(), ['id:1', 'id:2', 'id:4'], 'the opened album kept up to date');
	assert.deepEqual(bus.callsTo(SVC, 'listPhotos').map(c => c.params.aid), ['/Camera Uploads', '/Camera Uploads']);

	assert.equal((await api.syncAlbum({})).returnValue, false);
	await assert.rejects(api.syncAlbum({albumId: 'nope'}), /no cloud album/);
	await api.createAlbum({name: 'Mine', accountId: 'local'});
	const local = bus.db.live('com.palm.media.image.album:1').find(x => x.name === 'Mine');
	await assert.rejects(api.syncAlbum({albumId: local._id}), /no cloud album/);
});

test('albums synced before they were listed only when opened: listed when they have photos', async t => {
	const {bus, svc, api, cloud, sync} = setup(t);
	await svc.start();
	await sync();
	// As an older service left them: no "listed"; Trips with no photos here
	const albums = albumsOf(bus, 'acct1');
	for (const a of albums) {
		delete bus.db.objects.get(a._id).listed;
	}
	const trips = albums.find(a => a.name === 'Trips');
	for (const p of photosOf(bus, 'acct1').filter(x => x.albumId === trips._id)) {
		bus.db.handle('del', {ids: [p._id]});
	}
	cloud.photos['/Camera Uploads'].push({pid: 'id:4', src_big: 'https://dl.example/t/CCC?token=s3cret', type: 'image', fileName: 'new.jpg'});
	await api.syncSingleAccount({accountId: 'acct1'});
	const after = albumsOf(bus, 'acct1');
	assert.equal(after.find(a => a.name === 'Camera Uploads').listed, true);
	assert.equal(after.find(a => a.name === 'Trips').listed, false);
	assert.deepEqual(photosOf(bus, 'acct1').map(p => p[TPL].pid).sort(), ['id:1', 'id:2', 'id:4']);
});

test('covers: one per album not opened yet, with the listing\'s headers, kept nowhere but its file', async t => {
	const {bus, svc, api, cloud, files, download} = setup(t, {
		albums: [
			{aid: 'A', name: 'A', size: {images: 2}, cover: 'https://g.example/A/a.jpg/240?t=1'},
			{aid: 'B', name: 'B', size: {images: 1}, cover: 'https://g.example/B/b.jpg/240'},
			{aid: 'C', name: 'C', size: {images: 1}, cover: 'https://g.example/C/gone.jpg/240'},
			{aid: 'D', name: 'D', size: {images: 1}, cover: 'https://g.example/D/text/240'},
			{aid: 'E', name: 'E', size: {images: 1}},
			{aid: 'Y', name: 'Y', size: {images: 0}, cover: 'https://g.example/Y/m/y.jpg/240'}
		],
		photos: {A: [{pid: 'A/a.jpg', src_big: 'https://g.example/A/a.jpg', type: 'image', fileName: 'a.jpg'}]}
	});
	files.set('https://g.example/A/a.jpg/240?t=1', jpeg(240, 180));
	files.set('https://g.example/A/a.jpg/240?t=2', jpeg(240, 180));
	files.set('https://g.example/A/z.jpg/240', png(240, 180));
	files.set('https://g.example/B/b.jpg/240', png(240, 180));
	files.set('https://g.example/D/text/240', Buffer.from('<html>no</html>'));
	files.set('https://g.example/Y/m/y.jpg/240', jpeg(240, 180));
	files.set('https://g.example/Y/m/z.jpg/240', jpeg(240, 180));
	files.set('https://g.example/A/a.jpg', jpeg(4000, 3000));
	const listAlbums = bus.providers[SVC].listAlbums;
	bus.providers[SVC].listAlbums = p => Object.assign(listAlbums(p), {headers: {Cookie: 's=cover'}});
	await svc.start();
	assert.deepEqual(await api.syncSingleAccount({accountId: 'acct1'}), {returnValue: true}, 'a cover that fails fails no sync');
	const byName = () => new Map(albumsOf(bus, 'acct1').map(a => [a.name, a]));
	let albums = byName();
	const a = albums.get('A');
	assert.equal(path.dirname(a.coverPath), a.path);
	assert.match(path.basename(a.coverPath), /^\.cover-[0-9a-f]{10}\.jpg$/);
	assert.ok(fs.existsSync(a.coverPath) && fs.existsSync(albums.get('B').coverPath));
	assert.equal(albums.get('C').coverPath, undefined, 'one that does not come down: none');
	assert.equal(albums.get('D').coverPath, undefined, 'one that is no picture: none');
	assert.deepEqual(fs.readdirSync(albums.get('D').path), [], 'and nothing left of it');
	assert.equal(albums.get('E').coverPath, undefined);
	assert.ok(download.fetched.every(f => f.headers && f.headers.Cookie === 's=cover'));
	assert.ok(!JSON.stringify(bus.db.live('com.palm.media.image.album:1')).includes('s=cover'));
	assert.ok(!JSON.stringify(bus.db.live('com.palm.media.image.album:1')).includes('g.example'), 'no link kept');

	// Its token changed: the same cover, not fetched again
	let n = download.fetched.length;
	cloud.albums[0].cover = 'https://g.example/A/a.jpg/240?t=2';
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.deepEqual(download.fetched.slice(n).map(f => f.url).filter(u => !/\/(C|D)\//.test(u)), [],
		'only those that did not come down are tried again');
	// Gone from the disk: fetched again
	fs.unlinkSync(albums.get('B').coverPath);
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.ok(fs.existsSync(albums.get('B').coverPath));

	// Another cover: it replaces the one before
	const first = a.coverPath;
	cloud.albums[0].cover = 'https://g.example/A/z.jpg/240';
	await api.syncSingleAccount({accountId: 'acct1'});
	albums = byName();
	assert.notEqual(albums.get('A').coverPath, first);
	assert.ok(fs.existsSync(albums.get('A').coverPath) && !fs.existsSync(first));

	// Opened, the album's photos show: the sweep leaves its cover, and no sync fetches another
	await api.syncAlbum({albumId: a._id});
	assert.ok(fs.existsSync(albums.get('A').coverPath), 'not swept');
	n = download.fetched.length;
	cloud.albums[0].cover = 'https://g.example/A/a.jpg/240?t=1';
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.ok(download.fetched.slice(n).every(f => !/\/A\/.*\/240/.test(f.url)), 'an opened album: no cover');
	// An opened album with only sub-albums: its cover still follows
	const y = albums.get('Y');
	await api.syncAlbum({albumId: y._id});
	const yFirst = byName().get('Y').coverPath;
	assert.ok(yFirst && fs.existsSync(yFirst));
	cloud.albums[cloud.albums.length - 1].cover = 'https://g.example/Y/m/z.jpg/240';
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.notEqual(byName().get('Y').coverPath, yFirst);
	assert.ok(fs.existsSync(byName().get('Y').coverPath));

	// Gone from the cloud: its directory and cover with it
	const bDir = albums.get('B').path;
	cloud.albums.splice(1, 1);
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.ok(!fs.existsSync(bDir));
});

test('covers: four at a time', async t => {
	const albums = [];
	for (let i = 0; i < 11; i++) {
		albums.push({aid: `M${i}`, name: `M${i}`, size: {images: 1}, cover: `https://g.example/M${i}/c.jpg/240`});
	}
	const {svc, api, files, bus} = setup(t, {albums, photos: {}});
	for (const a of albums) {
		files.set(a.cover, jpeg(240, 180));
	}
	const download = svc.syncer.download;
	let active = 0;
	let most = 0;
	svc.syncer.download = async (...args) => {
		active++;
		most = Math.max(most, active);
		await new Promise(r => setTimeout(r, 5));
		active--;
		return download(...args);
	};
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(most, 4);
	assert.equal(albumsOf(bus, 'acct1').filter(a => a.coverPath).length, 11);
});

test('an opened album\'s photos: four at a time, each written as it comes; one name twice, two files', async t => {
	const photos = [];
	for (let i = 0; i < 10; i++) {
		photos.push({pid: `Big/p${i}`, src_big: `https://g.example/p${i}.jpg`, type: 'image', fileName: `p${i}.jpg`,
			createdTime: 1700000000 + (i % 2 ? i : 20 - i) * 60});
	}
	// Two photos of one name, which come down together (no time: shown first)
	photos.push({pid: 'Big/x/same', src_big: 'https://g.example/x/same.jpg', type: 'image', fileName: 'same.jpg'});
	photos.push({pid: 'Big/y/same', src_big: 'https://g.example/y/same.jpg', type: 'image', fileName: 'same.jpg'});
	const {svc, api, files, bus} = setup(t, {albums: [{aid: 'Big', name: 'Big', size: {images: photos.length}}], photos: {Big: photos}});
	for (const p of photos) {
		files.set(p.src_big, jpeg(640, 480));
	}
	const download = svc.syncer.download;
	let active = 0;
	let most = 0;
	const writtenAtStart = [];
	const order = [];
	const fetchPhoto = svc.syncer.fetchPhoto.bind(svc.syncer);
	svc.syncer.fetchPhoto = (account, album, p, ...rest) => {
		order.push(p.src_big.replace('https://g.example/', ''));
		return fetchPhoto(account, album, p, ...rest);
	};
	svc.syncer.download = async (url, ...rest) => {
		active++;
		most = Math.max(most, active);
		writtenAtStart.push(photosOf(bus, 'acct1').length);
		// The two of one name finish together
		await new Promise(r => setTimeout(r, /same/.test(url) ? 20 : 5));
		active--;
		return download(url, ...rest);
	};
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	const big = albumsOf(bus, 'acct1').find(a => a.name === 'Big');
	assert.deepEqual(await api.syncAlbum({albumId: big._id}), {returnValue: true, photos: photos.length});
	assert.equal(most, 4);
	// In the app's order: no time first (by name), then newest first
	const newestFirst = photos.slice(0, 10).sort((a, b) => b.createdTime - a.createdTime).map(p => p.src_big.replace('https://g.example/', ''));
	assert.deepEqual(order, ['x/same.jpg', 'y/same.jpg'].concat(newestFirst));
	assert.notDeepEqual(newestFirst, photos.slice(0, 10).map(p => p.src_big.replace('https://g.example/', '')).reverse(), 'not the listing\'s order turned round');
	assert.ok(writtenAtStart[writtenAtStart.length - 1] > 0, 'the first written while the rest come down');
	const got = photosOf(bus, 'acct1');
	assert.equal(got.length, photos.length);
	const same = got.filter(p => /same/.test(p[TPL].pid));
	assert.equal(same.length, 2);
	assert.notEqual(same[0].path, same[1].path, 'each its own file');
	assert.ok(same.every(p => fs.existsSync(p.path)));
	assert.equal(svc.syncer.writing.size, 0, 'nothing left claimed');
});

test('an opened album\'s photos: out of space stops the rest; a failing one not', async t => {
	const photos = [];
	for (let i = 0; i < 9; i++) {
		photos.push({pid: `Big/p${i}`, src_big: `https://g.example/p${i}.jpg`, type: 'image', fileName: `p${i}.jpg`});
	}
	const {svc, api, files, bus} = setup(t, {albums: [{aid: 'Big', name: 'Big', size: {images: photos.length}}], photos: {Big: photos}});
	for (const p of photos) {
		files.set(p.src_big, jpeg(640, 480));
	}
	files.delete('https://g.example/p0.jpg');            // that one fails to come down
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	const big = albumsOf(bus, 'acct1').find(a => a.name === 'Big');
	await assert.rejects(api.syncAlbum({albumId: big._id}), /HTTP 404/, 'the failing one fails the sync');
	assert.equal(photosOf(bus, 'acct1').length, 8, 'but the rest came down');
	// Out of space after the third: none is begun after it
	svc.db.del(photosOf(bus, 'acct1').map(p => p._id));
	const ensure = svc.storage.ensureRoom.bind(svc.storage);
	let asked = 0;
	svc.storage.ensureRoom = async () => {
		if (++asked > 3) {
			const {NoSpaceError} = require('../lib/storage');
			throw new NoSpaceError(0);
		}
		return ensure();
	};
	await assert.rejects(api.syncAlbum({albumId: big._id}), /not enough free space/);
	assert.equal(asked, 4, 'the four under way, and none begun after the first that had no room');
	assert.equal(svc.syncer.writing.size, 0);
});

// A gallery whose photos have a preview of their own (PiGallery2, Immich, PhotoPrism)
function withPreviews(t, {getPhoto} = {}) {
	const ctx = setup(t, {
		albums: [{aid: 'Holidays', name: 'Holidays', size: {images: 2}}],
		photos: {Holidays: [
			{pid: 'Holidays/a.jpg', src_big: 'https://g.example/a.jpg', src_small: 'https://g.example/a.jpg/320', type: 'image', fileName: 'a.jpg'},
			{pid: 'Holidays/b.jpg', src_big: 'https://g.example/b.jpg', src_small: 'https://g.example/b.jpg/320', type: 'image', fileName: 'b.jpg'}
		]}
	});
	ctx.files.set('https://g.example/a.jpg/320', jpeg(320, 240));
	ctx.files.set('https://g.example/b.jpg/320', jpeg(320, 240));
	ctx.files.set('https://g.example/a.jpg', jpeg(4000, 3000));
	ctx.files.set('https://g.example/b.jpg', png(4000, 3000));
	const provider = ctx.bus.providers[SVC];
	provider.listPhotos = p => ({returnValue: true, photos: ctx.cloud.photos[p.aid] || [], headers: {Cookie: 's=1'}});
	if (getPhoto) {
		provider.getPhoto = getPhoto;
	}
	return ctx;
}

test('previews: only src_small comes down; the whole picture when the photo is opened', async t => {
	const {bus, svc, api, paths, thumbs, download, sync} = withPreviews(t);
	await svc.start();
	await sync();
	assert.deepEqual(download.fetched.map(f => f.url).sort(), ['https://g.example/a.jpg/320', 'https://g.example/b.jpg/320']);
	const photos = photosOf(bus, 'acct1');
	for (const p of photos) {
		assert.equal(p.original, 'remote');
		assert.equal(p.appOriginal, undefined, 'no original yet');
		assert.ok(fs.existsSync(p.path) && paths.inCache(p.path));
		assert.equal(p.appCacheComplete, true, 'the grid thumbnail from the preview');
		assert.deepEqual([p.width, p.height], [320, 240], 'the preview\'s size: the shape, until the picture is here');
	}
	const a = photos.find(p => p[TPL].pid === 'Holidays/a.jpg');
	const preview = a.path;
	thumbs.made.length = 0;

	assert.deepEqual(await api.generateImgForBigView({_id: a._id}), {returnValue: true, msg: 'Queuing request'});
	await svc.bigView(a._id);     // what the call queued, awaited
	const [after] = await svc.db.get([a._id]);
	assert.equal(after.original, 'local');
	assert.equal(after.appOriginal, after.path);
	assert.deepEqual([after.width, after.height], [4000, 3000], 'the whole picture\'s size');
	assert.notEqual(after.path, preview);
	assert.ok(!fs.existsSync(preview), 'the preview is gone');
	assert.ok(fs.existsSync(after.path));
	assert.ok(after.appScreenNail && after.appScreenNail.path, 'the screen copy made');
	assert.deepEqual(thumbs.made.map(m => m.src), [after.path], 'from the whole picture, not the preview');
	const fetched = download.fetched.find(f => f.url === 'https://g.example/a.jpg');
	assert.deepEqual(fetched.headers, {Cookie: 's=1'}, 'the listing\'s session along');
	// No getPhoto: the album listed again, and told it has the rest
	const relist = bus.callsTo(SVC, 'listPhotos').pop();
	assert.deepEqual(relist.params.have, ['Holidays/b.jpg']);
	assert.ok(!JSON.stringify(after).includes('g.example'), 'no link kept');

	// A sync later leaves it be
	await api.syncSingleAccount({accountId: 'acct1'});
	const [again] = await svc.db.get([a._id]);
	assert.equal(again.path, after.path);
	assert.ok(fs.existsSync(after.path), 'not swept');
});

test('fetchOriginal: once per photo, at once when it is here whole; a gone photo keeps its preview', async t => {
	const {bus, svc, api, cloud, download, sync} = withPreviews(t);
	await svc.start();
	await sync();
	const [a, b] = ['Holidays/a.jpg', 'Holidays/b.jpg'].map(pid => photosOf(bus, 'acct1').find(p => p[TPL].pid === pid));
	const before = download.fetched.length;
	const [r1, r2] = await Promise.all([api.fetchOriginal({_id: a._id}), api.fetchOriginal({_id: a._id})]);
	assert.equal(r1.returnValue, true);
	assert.deepEqual(r1, r2);
	assert.equal(download.fetched.length - before, 1, 'one download for both');
	assert.equal(path.extname(r1.path), '.jpg');
	assert.deepEqual(await api.fetchOriginal({_id: a._id}), r1, 'here now: no download');
	assert.equal(download.fetched.length - before, 1);
	assert.equal((await api.fetchOriginal({})).returnValue, false);

	// The cloud has it no more: an error, and the preview stays the photo's
	cloud.photos.Holidays = cloud.photos.Holidays.filter(p => p.pid !== 'Holidays/b.jpg');
	await assert.rejects(api.fetchOriginal({_id: b._id}), /not in Holidays any more/);
	const [bAfter] = await svc.db.get([b._id]);
	assert.equal(bAfter.original, 'remote');
	assert.equal(bAfter.path, b.path);
	assert.ok(fs.existsSync(b.path));
	// Nor does the big view make a screen copy of the preview
	await assert.rejects(svc.bigView(b._id));
	await svc.cache.screenNail(b._id);
	assert.equal((await svc.db.get([b._id]))[0].appScreenNail, undefined);
});

test('a whole picture that fails to come down leaves nothing behind', async t => {
	const {bus, svc, api, files, sync} = withPreviews(t);
	await svc.start();
	await sync();
	const a = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'Holidays/a.jpg');
	const dir = path.dirname(a.path);
	const before = fs.readdirSync(dir).sort();
	files.delete('https://g.example/a.jpg');
	await assert.rejects(api.fetchOriginal({_id: a._id}), /404/);
	assert.deepEqual(fs.readdirSync(dir).sort(), before);
	// Down, but its entry cannot be written: the file goes again
	files.set('https://g.example/a.jpg', jpeg(4000, 3000));
	bus.db.failMerge = objects => objects.some(o => o.original === 'local');
	await assert.rejects(api.fetchOriginal({_id: a._id}), /merge failed/);
	assert.deepEqual(fs.readdirSync(dir).sort(), before);
	const [after] = await svc.db.get([a._id]);
	assert.equal(after.original, 'remote');
	assert.equal(after.path, a.path);
});

test('getPhoto when the connector has it; asked no more of one that has none', async t => {
	const asked = [];
	const {bus, svc, api, cloud, download, sync} = withPreviews(t, {getPhoto: p => {
		asked.push(p);
		return {returnValue: true, src_big: `https://g.example/${p.pid.split('/').pop()}`, headers: {Cookie: 'fresh=1'}};
	}});
	await svc.start();
	await sync();
	const a = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'Holidays/a.jpg');
	const lists = bus.callsTo(SVC, 'listPhotos').length;
	await api.fetchOriginal({_id: a._id});
	assert.deepEqual(asked, [{accountId: 'acct1', aid: 'Holidays', pid: 'Holidays/a.jpg'}]);
	assert.equal(bus.callsTo(SVC, 'listPhotos').length, lists, 'no listing');
	assert.deepEqual(download.fetched.pop().headers, {Cookie: 'fresh=1'});

	// One without getPhoto ("Unknown method"): listed, and getPhoto not tried again
	delete bus.providers[SVC].getPhoto;
	const b = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'Holidays/b.jpg');
	await api.fetchOriginal({_id: b._id});
	assert.equal(bus.callsTo(SVC, 'listPhotos').length, lists + 1);
	assert.equal(bus.callsTo(SVC, 'getPhoto').length, 2);
	cloud.photos.Holidays.push({pid: 'Holidays/c.jpg', src_big: 'https://g.example/a.jpg', src_small: 'https://g.example/a.jpg/320',
		type: 'image', fileName: 'c.jpg'});
	await api.syncSingleAccount({accountId: 'acct1'});
	const c = photosOf(bus, 'acct1').find(p => p.original === 'remote');
	assert.equal(c[TPL].pid, 'Holidays/c.jpg');
	await api.fetchOriginal({_id: c._id});
	assert.equal(bus.callsTo(SVC, 'getPhoto').length, 2, 'not asked again');
});

test('a copy of a photo of which only the preview is here copies the whole picture', async t => {
	const {bus, svc, api, download, sync} = withPreviews(t);
	await svc.start();
	await sync();
	const a = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'Holidays/a.jpg');
	const target = await api.createAlbum({name: 'Mine', accountId: 'local'});
	const mine = bus.db.live('com.palm.media.image.album:1').find(x => x.name === 'Mine');
	assert.ok(target.returnValue !== false && mine);
	const r = await api.addPhotos({targetAlbum: mine._id, specs: [{sourceAlbum: a.albumId, photos: [a._id], targetAlbum: mine._id}]});
	assert.notEqual(r.returnValue, false);
	assert.ok(download.fetched.some(f => f.url === 'https://g.example/a.jpg'), 'the whole picture fetched');
	const copied = fs.readdirSync(mine.path);
	assert.equal(copied.length, 1);
	assert.ok(fs.readFileSync(path.join(mine.path, copied[0])).length > 4096, 'not the preview');
});

test('a photo the connector gives one link for comes down whole, as before', async t => {
	const {bus, svc, download, sync} = setup(t, {
		albums: [{aid: '/A', name: 'A', size: {images: 1}}],
		photos: {'/A': [{pid: 'id:1', src_big: 'https://dl.example/t/AAA?token=s3cret', src_small: 'https://dl.example/t/AAA?token=s3cret', type: 'image', fileName: 'one.jpg'}]}
	});
	await svc.start();
	await sync();
	const [p] = photosOf(bus, 'acct1');
	assert.equal(p.original, undefined);
	assert.equal(p.appOriginal, p.path);
	assert.equal(download.fetched.length, 1);
});

test('turning the photos off stops an album being listed', async t => {
	const {bus, svc, api} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	const cam = albumsOf(bus, 'acct1').find(a => a.name === 'Camera Uploads');
	let release;
	const gate = new Promise(r => { release = r; });
	const list = bus.providers[SVC].listPhotos;
	bus.providers[SVC].listPhotos = async p => { await gate; return list(p); };
	const opening = api.syncAlbum({albumId: cam._id});
	while (!bus.callsTo(SVC, 'listPhotos').length) {
		await new Promise(r => setImmediate(r));
	}
	const off = api.onEnabled({accountId: 'acct1', enabled: false});
	release();
	await assert.rejects(opening, /cancelled/);
	await off;
	assert.equal(photosOf(bus, 'acct1').length, 0);
	assert.deepEqual(await api.syncAlbum({albumId: cam._id}), {returnValue: true, skipped: 'disabled'});
});

// ---- storage -------------------------------------------------------------------------------

// A JPEG of `bytes` bytes (its header, then padding)
const sizedJpeg = bytes => Buffer.concat([jpeg(4000, 3000), Buffer.alloc(Math.max(0, bytes - jpeg(4000, 3000).length))]);

// A gallery with previews, three photos of 10 KB whole; the cap set (as only a test may) to 25 KB
function withBudget(t, opts) {
	const ctx = withPreviews(t, opts);
	ctx.cloud.photos.Holidays.push({pid: 'Holidays/c.jpg', src_big: 'https://g.example/c.jpg', src_small: 'https://g.example/c.jpg/320',
		type: 'image', fileName: 'c.jpg'});
	ctx.cloud.albums[0].size = {images: 3};
	ctx.files.set('https://g.example/c.jpg/320', jpeg(320, 240));
	for (const n of ['a', 'b', 'c']) {
		ctx.files.set(`https://g.example/${n}.jpg`, sizedJpeg(10000));
	}
	ctx.svc.storage.settings.capBytes = 25000;
	const byPid = pid => photosOf(ctx.bus, 'acct1').find(p => p[TPL].pid === `Holidays/${pid}.jpg`);
	return Object.assign(ctx, {byPid});
}

test('storage: whole pictures past the cap go back to their preview, those opened longest ago first', async t => {
	const {svc, api, sync, clock, byPid, download} = withBudget(t);
	await svc.start();
	await sync();
	const thumbA = byPid('a').appGridThumbnail.path;
	await api.fetchOriginal({_id: byPid('a')._id});
	clock.t += 1000;
	await svc.bigView(byPid('a')._id);          // its screen-size copy made
	const screenA = byPid('a').appScreenNail.path;
	const wholeA = byPid('a').path;
	clock.t += 1000;
	await api.fetchOriginal({_id: byPid('b')._id});
	clock.t += 1000;
	assert.equal(byPid('a').original, 'local');
	assert.equal(byPid('b').original, 'local', 'two fit');

	await api.fetchOriginal({_id: byPid('c')._id});
	const a = byPid('a');
	assert.equal(a.original, 'remote', 'the one opened longest ago goes');
	assert.equal(a.path, thumbA, 'its grid thumbnail stands in');
	assert.equal(a.appOriginal, null);
	assert.equal(a.appScreenNail, null);
	assert.ok(!fs.existsSync(wholeA) && !fs.existsSync(screenA) && fs.existsSync(thumbA));
	assert.equal(byPid('b').original, 'local');
	assert.equal(byPid('c').original, 'local');

	// Opened, b is the newest: fetching a again drops c, and leaves a's thumbnail
	clock.t += 1000;
	await svc.bigView(byPid('b')._id);
	clock.t += 1000;
	const n = download.fetched.length;
	await svc.bigView(byPid('a')._id);
	assert.deepEqual(download.fetched.slice(n).map(f => f.url), ['https://g.example/a.jpg']);
	assert.equal(byPid('a').original, 'local');
	assert.ok(fs.existsSync(thumbA), 'the thumbnail is no preview to remove');
	assert.equal(byPid('b').original, 'local');
	assert.equal(byPid('c').original, 'remote');

	const info = await api.getStorage({});
	assert.equal(info.returnValue, true);
	assert.deepEqual(info.originals, {count: 2, bytes: 20000});
	assert.equal(info.capBytes, 25000);
	assert.equal(info.capNowBytes, 25000);
	assert.equal(info.freeBytes, 64 * GB);
	assert.equal(info.floorBytes, 1024 * 1024 * 1024);
	assert.equal(info.expireDays, 30);
	assert.ok(info.otherBytes > 0, 'previews and thumbnails');
});

test('storage: a whole-file connector\'s photos past the cap keep only their thumbnails, and come back when opened', async t => {
	const whole = n => ({pid: `id:${n}`, src_big: `https://dl.example/t/${n}`, type: 'image', fileName: `${n}.jpg`});
	const {bus, svc, api, sync, files, cloud, clock} = setup(t, {albums: [{aid: '/Cam', name: 'Cam', size: {images: 2}}],
		photos: {'/Cam': [whole('p1'), whole('p2')]}});
	for (const n of ['p1', 'p2', 'p3', 'p4']) {
		files.set(`https://dl.example/t/${n}`, sizedJpeg(10000));
	}
	svc.storage.settings.capBytes = 15000;
	await svc.start();
	// The second is past the cap before any thumbnail is made: dropped once they are
	await sync();
	const onDisk = () => photosOf(bus, 'acct1').filter(p => p.original !== 'remote');
	assert.equal(onDisk().length, 1, 'once the album is listed');
	// New photos at a sync: the same
	clock.t += 1000;
	cloud.photos['/Cam'].push(whole('p3'), whole('p4'));
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(onDisk().length, 1, 'once the sync is done');
	assert.equal(onDisk()[0][TPL].pid, 'id:p4', 'the newest');
	const photos = photosOf(bus, 'acct1');
	const kept = photos.filter(p => p.original !== 'remote');
	const dropped = photos.filter(p => p.original === 'remote');
	assert.ok(dropped.length >= 1, 'past the cap: dropped');
	assert.ok(kept.reduce((s, p) => s + fs.statSync(p.path).size, 0) <= 15000);
	for (const p of dropped) {
		assert.equal(p.path, p.appGridThumbnail.path);
	}
	// Opened again: listed for its link (Dropbox has no getPhoto), and whole
	const again = await api.fetchOriginal({_id: dropped[0]._id});
	assert.ok(fs.statSync(again.path).size > 1000);
	assert.equal(photosOf(bus, 'acct1').find(p => p._id === dropped[0]._id).original, 'local');
});

test('storage: nothing comes down while less than 1 GB is free', async t => {
	const {bus, svc, api, sync, space, byPid, download} = withBudget(t);
	await svc.start();
	await sync();
	space.free = 900 * 1024 * 1024;
	svc.storage.freeAt = 0;
	const n = download.fetched.length;
	await assert.rejects(api.fetchOriginal({_id: byPid('a')._id}), /not enough free space/);
	assert.equal(download.fetched.length, n);
	// A new album: listed, and nothing fetched
	bus.providers[SVC].listAlbums = () => ({returnValue: true, albums: [{aid: 'More', name: 'More', size: {images: 1}}]});
	bus.providers[SVC].listPhotos = () => ({returnValue: true, photos: [{pid: 'More/x.jpg', src_big: 'https://g.example/x.jpg', type: 'image'}]});
	await api.syncSingleAccount({accountId: 'acct1'});
	const more = albumsOf(bus, 'acct1').find(a => a.name === 'More');
	await assert.rejects(api.syncAlbum({albumId: more._id}), /not enough free space/);
	assert.equal(download.fetched.length, n);
});

test('storage: the sizes offered double up to 256 GB, those that fit; the one set is the cap', async t => {
	const {svc, api, sync, space, byPid} = withBudget(t);
	await svc.start();
	await sync();
	const MBs = r => r.capChoices.map(b => b / 1024 / 1024);
	// 64 GB free: what fits in it less the 1 GB kept free
	assert.deepEqual(MBs(await api.getStorage({})), [100, 200, 500, 1024, 2048, 4096, 8192, 16384, 32768]);
	// Room for a whole size counts: free and what the pictures take now, less the floor
	await api.fetchOriginal({_id: byPid('a')._id});
	const taken = svc.storage.usage(new Set()).originals.bytes;
	// (the disk counts in blocks of 4096)
	const fits = Math.ceil((3 * GB - taken) / 4096) * 4096;
	space.free = fits;
	svc.storage.freeAt = 0;
	assert.deepEqual(MBs(await api.getStorage({})), [100, 200, 500, 1024, 2048]);
	space.free = fits - 4096;
	svc.storage.freeAt = 0;
	assert.deepEqual(MBs(await api.getStorage({})), [100, 200, 500, 1024]);
	// No room at all: the smallest still; one set that no longer fits: still shown, and the cap
	space.free = 900 * 1024 * 1024;
	svc.storage.freeAt = 0;
	assert.deepEqual(MBs(await api.getStorage({})), [100]);
	await api.setStorage({capBytes: 256 * GB});
	const info = await api.getStorage({});
	assert.deepEqual(MBs(info), [100, 256 * 1024]);
	assert.equal(info.capNowBytes, 256 * GB, 'no share of the space: what is set');
});

test('storage: setStorage takes one of the sizes offered; a smaller one drops pictures at once', async t => {
	const {svc, api, sync, clock, byPid} = withBudget(t);
	await svc.start();
	await sync();
	for (const n of ['a', 'b']) {
		clock.t += 1000;
		await api.fetchOriginal({_id: byPid(n)._id});
	}
	assert.equal((await api.setStorage({})).returnValue, false);
	await assert.rejects(api.setStorage({capBytes: 12345}), /capBytes: one of/);
	const r = await api.setStorage({capBytes: 100 * 1024 * 1024});
	assert.equal(r.capBytes, 100 * 1024 * 1024);
	assert.deepEqual(r.capChoices.slice(0, 4).map(b => b / 1024 / 1024), [100, 200, 500, 1024]);
	assert.equal((await api.setStorage({capBytes: 256 * GB})).capBytes, 256 * GB, 'up to 256 GB');
	await assert.rejects(api.setStorage({capBytes: 512 * GB}), /capBytes: one of/);
	await api.setStorage({capBytes: 100 * 1024 * 1024});
	// Kept across a restart of the service
	const again = new (require('../lib/storage').Storage)({paths: svc.paths, statfs: svc.storage.statfs});
	await again.load();
	assert.equal(again.settings.capBytes, 100 * 1024 * 1024);
	assert.deepEqual([...again.originals.keys()].sort(), [byPid('a')._id, byPid('b')._id].sort());
	// Smaller than what is here: the oldest goes now
	svc.storage.settings.capBytes = 15000;
	await svc.syncer.budget();
	assert.equal(byPid('a').original, 'remote');
	assert.equal(byPid('b').original, 'local');
});

test('storage: an album kept on the device comes down whole, counts for no cap, and never goes', async t => {
	const {bus, svc, api, byPid, clock} = withBudget(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(albumsOf(bus, 'acct1')[0].listed, false, 'not opened: keeping it lists it');
	svc.storage.settings.capBytes = 15000;
	const album = albumsOf(bus, 'acct1')[0];
	assert.equal((await api.keepAlbum({albumId: album._id})).returnValue, false, 'keep: true or false');
	await assert.rejects(api.keepAlbum({albumId: 'nope', keep: true}), /no cloud album/);
	const r = await api.keepAlbum({albumId: album._id, keep: true});
	assert.deepEqual(r, {returnValue: true, keep: true, photos: 3, fetched: 3, failed: 0});
	assert.ok(['a', 'b', 'c'].every(n => byPid(n).original === 'local'), 'all whole, past the cap');
	assert.equal(albumsOf(bus, 'acct1')[0].keep, true);
	let info = await api.getStorage({});
	assert.deepEqual(info.kept, {albums: 1, count: 3, bytes: 30000});
	assert.deepEqual(info.originals, {count: 0, bytes: 0});
	// Not opened for long: kept, it stays
	clock.t += 40 * 86400 * 1000;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(albumsOf(bus, 'acct1')[0].listed, true);
	assert.equal(photosOf(bus, 'acct1').length, 3);
	// No longer kept: they count again, and go down to the cap
	assert.deepEqual(await api.keepAlbum({albumId: album._id, keep: false}), {returnValue: true, keep: false});
	info = await api.getStorage({});
	assert.ok(info.originals.bytes <= 15000);
	assert.equal(['a', 'b', 'c'].filter(n => byPid(n).original === 'local').length, 1);
});

test('storage: an album not opened for 30 days goes back to unopened; its cover comes down', async t => {
	const {bus, svc, api, sync, clock, files, cloud, byPid} = withBudget(t);
	cloud.albums[0].cover = 'https://g.example/cover.jpg/240';
	cloud.albums.push({aid: 'Other', name: 'Other', size: {images: 1}});
	cloud.photos.Other = [{pid: 'Other/o.jpg', src_big: 'https://g.example/o.jpg', type: 'image', fileName: 'o.jpg'}];
	files.set('https://g.example/o.jpg', jpeg(800, 600));
	files.set('https://g.example/cover.jpg/240', jpeg(240, 180));
	await svc.start();
	await sync();
	await api.fetchOriginal({_id: byPid('a')._id});
	const holidays = () => albumsOf(bus, 'acct1').find(a => a.name === 'Holidays');
	const other = () => albumsOf(bus, 'acct1').find(a => a.name === 'Other');
	assert.equal(holidays().openedTime, Math.floor(clock.t / 1000));
	const files0 = photosOf(bus, 'acct1').filter(p => p.albumId === holidays()._id).map(p => p.path);

	clock.t += 20 * 86400 * 1000;
	await api.syncAlbum({albumId: other()._id});            // opened again: from now
	clock.t += 11 * 86400 * 1000;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(holidays().listed, false, '31 days: unopened');
	assert.equal(photosOf(bus, 'acct1').filter(p => p.albumId === holidays()._id).length, 0);
	assert.ok(files0.every(f => !fs.existsSync(f)));
	assert.ok(holidays().coverPath && fs.existsSync(holidays().coverPath), 'its cover instead');
	assert.equal(other().listed, true, '11 days: still opened');
	assert.equal((await api.getStorage({})).originals.count, 1, 'Other\'s whole picture only');

	// One opened before openedTime was kept: from now
	delete bus.db.objects.get(other()._id).openedTime;
	clock.t += 60 * 86400 * 1000;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(other().listed, true);
	assert.equal(other().openedTime, Math.floor(clock.t / 1000));
});

test('storage: how long an album stays opened is a setting: 7 to 90 days, or never', async t => {
	const {bus, svc, api, sync, clock, byPid} = withBudget(t);
	await svc.start();
	await sync();
	await api.fetchOriginal({_id: byPid('a')._id});
	const holidays = () => albumsOf(bus, 'acct1').find(a => a.name === 'Holidays');
	let info = await api.getStorage({});
	assert.equal(info.expireDays, 30, '30 to start with');
	assert.deepEqual(info.expireChoices, [7, 14, 30, 60, 90, 0]);
	await assert.rejects(api.setStorage({expireDays: 10}), /expireDays: one of/);
	assert.equal((await api.setStorage({expireDays: 'x'})).returnValue, false);
	// Set alone, the cap stays
	info = await api.setStorage({expireDays: 0});
	assert.equal(info.expireDays, 0);
	assert.equal(info.capBytes, 25000, 'the cap as it was');
	// Never: still opened after a year
	clock.t += 365 * 86400 * 1000;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(holidays().listed, true, 'never: a year on, still opened');
	// 7 days: 6 days on still opened, 8 days on not
	await api.syncAlbum({albumId: holidays()._id});
	await api.setStorage({expireDays: 7});
	clock.t += 6 * 86400 * 1000;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(holidays().listed, true, '6 days');
	clock.t += 2 * 86400 * 1000;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(holidays().listed, false, '8 days: unopened');
	// Kept across a restart of the service, with the cap
	await api.setStorage({capBytes: 500 * 1024 * 1024});
	const again = new (require('../lib/storage').Storage)({paths: svc.paths, statfs: svc.storage.statfs});
	await again.load();
	assert.equal(again.settings.expireDays, 7, 'not changed by setting the cap');
	assert.equal(again.settings.capBytes, 500 * 1024 * 1024);
});

test('storage: clearDownloads takes every opened album not kept back to unopened', async t => {
	const {bus, svc, api, sync, cloud, files, byPid} = withBudget(t);
	cloud.albums.push({aid: 'Other', name: 'Other', size: {images: 1}});
	cloud.photos.Other = [{pid: 'Other/o.jpg', src_big: 'https://g.example/o.jpg', type: 'image', fileName: 'o.jpg'}];
	files.set('https://g.example/o.jpg', jpeg(800, 600));
	await svc.start();
	await sync();
	const other = albumsOf(bus, 'acct1').find(a => a.name === 'Other');
	await api.keepAlbum({albumId: other._id, keep: true});
	await api.fetchOriginal({_id: byPid('a')._id});
	const r = await api.clearDownloads({});
	assert.equal(r.returnValue, true);
	assert.deepEqual(r.cleared, {albums: 1, photos: 3});
	assert.deepEqual(r.originals, {count: 0, bytes: 0});
	assert.equal(albumsOf(bus, 'acct1').find(a => a.name === 'Holidays').listed, false);
	assert.equal(albumsOf(bus, 'acct1').find(a => a.name === 'Other').listed, true, 'kept: stays');
	assert.equal(photosOf(bus, 'acct1').length, 1);
});

test('storage: whole pictures here before there was a ledger are counted; removed photos no longer', async t => {
	const {bus, svc, sync, paths} = setup(t);
	await svc.start();
	await sync();
	fs.unlinkSync(path.join(paths.cache, '.storage.json'));
	const svc2 = new PhotosService({bus, paths, thumbnailer: new FakeThumbnailer(), download: svc.syncer.download,
		statfs: svc.storage.statfs, now: svc.storage.now});
	t.after(() => svc2.stop());
	const api2 = methods(svc2);
	await svc2.start();
	await api2.syncSingleAccount({accountId: 'acct1'});
	const photos = photosOf(bus, 'acct1');
	assert.equal((await api2.getStorage({})).originals.count, photos.length);
	await api2.deletePhotos({specs: [{photos: [photos[0]._id]}]});
	assert.equal((await api2.getStorage({})).originals.count, photos.length - 1);
	assert.ok(!svc2.storage.originals.has(photos[0]._id));
});

test('storage: a picture bigger than the cap is kept while it is the one just opened', async t => {
	const {svc, api, sync, byPid} = withBudget(t);
	await svc.start();
	await sync();
	svc.storage.settings.capBytes = 5000;
	const r = await api.fetchOriginal({_id: byPid('a')._id});
	assert.ok(fs.existsSync(r.path));
	assert.equal(byPid('a').original, 'local');
	await api.fetchOriginal({_id: byPid('b')._id});
	assert.equal(byPid('a').original, 'remote', 'the next one opened: it goes');
	assert.equal(byPid('b').original, 'local');
});
