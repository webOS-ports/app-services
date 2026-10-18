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
	const svc = new PhotosService({bus, paths, thumbnailer: thumbs, download});
	t.after(() => svc.stop());
	return {root, bus, cloud, files, paths, thumbs, download, svc, api: methods(svc)};
}

const photosOf = (bus, accountId) =>
	bus.db.live('com.palm.media.types:1').filter(p => p.accountId === accountId);
const albumsOf = (bus, accountId) =>
	bus.db.live('com.palm.media.image.album:1').filter(a => a.accountId === accountId);

test('first sync: albums, photos, thumbnails; no link token is kept', async t => {
	const {bus, svc, api, paths, thumbs} = setup(t);
	await svc.start();
	assert.deepEqual((await api.getAccountsCapability()).AccountsCapability[TPL].serviceName, SVC);

	assert.deepEqual(await api.syncSingleAccount({accountId: 'acct1'}), {returnValue: true});
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
	assert.equal(thumbs.made.length, 3);
	// The sync state the accounts app shows is gone again
	assert.equal(bus.tempdb.live('com.palm.account.syncstate:1').length, 0);
	assert.equal(bus.callsTo('com.palm.tempdb', 'put').length, 1);
});

test('resync: what the cloud dropped goes here only; renames and captions follow', async t => {
	const {bus, svc, api, cloud} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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

test('a failing download fails the sync but keeps the rest', async t => {
	const {bus, svc, api, files} = setup(t);
	files.delete('https://dl.example/t/BBB?token=s3cret');
	await svc.start();
	const r = await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(r.returnValue, false);
	assert.match(r.error, /404/);
	assert.deepEqual(photosOf(bus, 'acct1').map(p => p[TPL].pid).sort(), ['id:1', 'id:3']);
	assert.equal(svc.accounts.view('acct1').syncStatus, 'idle');
	files.set('https://dl.example/t/BBB?token=s3cret', png(10, 10));
	assert.equal((await api.syncSingleAccount({accountId: 'acct1'})).returnValue, true);
	assert.equal(photosOf(bus, 'acct1').length, 3, 'picked up next time');
});

test('something that is no image is kept but never shown, and not fetched again', async t => {
	const {bus, svc, api, files, download} = setup(t);
	files.set('https://dl.example/t/CCC?token=s3cret', Buffer.from('<html>login page</html>'));
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	const rome = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:3');
	assert.equal(rome.appCacheComplete, false);
	const fetched = download.fetched.length;
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(download.fetched.length, fetched);
});

test('deleting a cloud photo deletes it in the cloud first', async t => {
	const {bus, svc, api, cloud} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api, cloud} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	const cam = albumsOf(bus, 'acct1').find(a => a.name === 'Camera Uploads');
	const keep = photosOf(bus, 'acct1').find(p => p[TPL].pid === 'id:1');
	await api.deletePhotos({specs: [{sourceAlbum: cam._id, exclude: true, photos: [keep._id]}]});
	assert.deepEqual(cloud.deleted.map(d => d.pid), ['id:2']);
	assert.deepEqual(photosOf(bus, 'acct1').map(p => p[TPL].pid).sort(), ['id:1', 'id:3']);
});

test('removing the account clears what was synced, and nothing in the cloud', async t => {
	const {bus, svc, api, cloud, paths} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.deepEqual(await api.onEnabled({accountId: 'acct1', enabled: false}), {returnValue: true});
	assert.ok(albumsOf(bus, 'acct1').every(a => a.showAlbum === false));
	assert.equal(svc.accounts.view('acct1').isEnabled, false);
	const listed = bus.callsTo(SVC, 'listAlbums').length;
	await api.remoteSyncAlbums({});
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api, root, cloud} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	// The next sync finds the uploaded photo there already
	assert.equal(albumsOf(bus, 'acct1').find(a => a._id === cam._id).total.images, 3, 'counted again');
	cloud.photos['/Camera Uploads'].push({pid: 'id:up1', src_big: 'https://dl.example/none', type: 'image'});
	cloud.albums[0].size = {images: 3, videos: 0};
	await api.syncSingleAccount({accountId: 'acct1'});
	assert.equal(photosOf(bus, 'acct1').filter(p => p[TPL].pid === 'id:up1').length, 1);
	assert.equal(albumsOf(bus, 'acct1').find(a => a._id === cam._id).total.images, 3);
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
	const {bus, svc, api} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api, paths} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api, paths} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
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
	const {bus, svc, api, download} = setup(t);
	await svc.start();
	await api.syncSingleAccount({accountId: 'acct1'});
	const before = photosOf(bus, 'acct1');
	const cam = albumsOf(bus, 'acct1').find(a => a.name === 'Camera Uploads');
	// The entries gone, as the media indexer at start removed them; the files stay
	bus.db.handle('del', {ids: before.map(p => p._id)});
	fs.writeFileSync(path.join(cam.path, 'stray.jpg'), 'x');
	fs.writeFileSync(path.join(cam.path, 'busy.jpg.part'), 'x');
	const fetched = download.fetched.length;
	await api.syncSingleAccount({accountId: 'acct1'});
	const after = photosOf(bus, 'acct1');
	assert.equal(download.fetched.length - fetched, 3, 'downloaded again');
	assert.deepEqual(after.map(p => p.path).sort(), before.map(p => p.path).sort(), 'into the same files');
	assert.deepEqual(fs.readdirSync(cam.path).sort(), ['busy.jpg.part', 'one.jpg', 'two.png']);
});
