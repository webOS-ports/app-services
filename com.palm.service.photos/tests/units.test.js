// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The parts on their own: capabilities, image headers, paths, account
// status, the queue, the download.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const log = require('../lib/log');
const {capabilityFor, capabilitiesFor, serviceNameFor} = require('../lib/capabilities');
const {probe, displaySize} = require('../lib/imageinfo');
const {Paths, segment, albumDirName, removeFile, removeDir, copyInto} = require('../lib/files');
const {AccountsManager} = require('../lib/accounts');
const {SerialQueue} = require('../lib/queue');
const {download} = require('../lib/download');
const {Thumbnailer} = require('../lib/thumbnailer');
const {png, jpeg, tmpRoot} = require('./fake');

log.setQuiet(true);

test('capabilities: the device, the three old services and the cloud connectors', () => {
	const local = capabilityFor('local');
	assert.equal(local.createAlbum, true);
	assert.equal(local.deletePhoto, true);
	assert.equal(local.getAlbums, false);
	assert.equal(local.serviceName, undefined);

	const fb = capabilityFor('com.palm.facebook');
	assert.equal(fb.serviceName, 'com.palm.service.photos.facebook');
	assert.equal(fb.getComments, true);
	assert.equal(fb.videoDownload, false);
	assert.equal(fb.deletePhoto, false);

	const snap = capabilityFor('com.palm.snapfish');
	assert.equal(snap.computeNumFiles, true);
	assert.equal(snap.addCaption, false);

	const box = capabilityFor('com.palm.boxnet');
	assert.equal(box.serviceName, 'com.palm.service.boxnet');
	assert.equal(box.deletePhoto, true);
	assert.equal(box.getComments, false);
	assert.equal(box.videoDownload, false);
	assert.equal(box.photoUpload, true);

	assert.equal(serviceNameFor('com.palm.yandexdisk'), 'com.palm.service.yandexdisk');
	assert.equal(serviceNameFor('org.example.cloud'), null);
	assert.equal(serviceNameFor('com.palm.x/../y'), null);
	const other = capabilityFor('org.example.cloud');
	assert.equal(other.serviceName, undefined);
	assert.equal(other.getAlbums, false);

	const map = capabilitiesFor([{templateId: 'com.palm.dropbox'}, {templateId: 'com.palm.dropbox'}]);
	assert.deepEqual(Object.keys(map).sort(), ['com.palm.dropbox', 'local']);
});

test('imageinfo: sizes and orientation from the header', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const write = (name, bytes) => {
		const p = path.join(root.dir, name);
		fs.writeFileSync(p, bytes);
		return p;
	};

	assert.deepEqual(await probe(write('a.png', png(640, 480))),
		{format: 'png', width: 640, height: 480, ext: 'png', orientation: 1});

	const j = await probe(write('a.jpg', jpeg(4000, 3000, {orientation: 6})));
	assert.equal(j.format, 'jpeg');
	assert.equal(j.width, 4000);
	assert.equal(j.height, 3000);
	assert.equal(j.orientation, 6);
	assert.deepEqual(displaySize(j), {width: 3000, height: 4000});

	const mm = await probe(write('b.jpg', jpeg(10, 20, {orientation: 8, bigEndian: true})));
	assert.equal(mm.orientation, 8);
	assert.equal((await probe(write('c.jpg', jpeg(10, 20)))).orientation, 1);

	const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
	assert.equal((await probe(write('a.gif', gif))).width, 32);

	const bmp = Buffer.alloc(54);
	bmp.write('BM', 0, 'latin1');
	bmp.writeInt32LE(100, 18);
	bmp.writeInt32LE(-50, 22);
	assert.deepEqual(await probe(write('a.bmp', bmp)), {format: 'bmp', width: 100, height: 50, ext: 'bmp', orientation: 1});

	const webp = Buffer.alloc(30);
	webp.write('RIFF', 0, 'latin1');
	webp.write('WEBPVP8X', 8, 'latin1');
	webp.writeUIntLE(1919, 24, 3);
	webp.writeUIntLE(1079, 27, 3);
	assert.equal((await probe(write('a.webp', webp))).height, 1080);

	assert.equal(await probe(write('x.txt', Buffer.from('<html>not a photo</html>'))), null);
	assert.equal(await probe(write('t.jpg', jpeg(10, 20).subarray(0, 40))), null);
	assert.equal(await probe(write('z.png', png(0, 10))), null);
	assert.equal(await probe(path.join(root.dir, 'missing')), null);
});

test('thumbnail size fits the box and turns with the orientation', () => {
	assert.deepEqual(Thumbnailer.fit({width: 4000, height: 3000, orientation: 1}, 200, 200), {width: 200, height: 150});
	assert.deepEqual(Thumbnailer.fit({width: 4000, height: 3000, orientation: 6}, 200, 200), {width: 150, height: 200});
	assert.deepEqual(Thumbnailer.fit({width: 100, height: 60, orientation: 1}, 200, 200), {width: 100, height: 60});
	assert.deepEqual(Thumbnailer.fit({width: 5000, height: 10, orientation: 1}, 1024, 768), {width: 1024, height: 2});
});

test('thumbnailer: the pipeline it runs and what it hands GStreamer', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const src = path.join(root.media, 'My Photo! (1).jpg');
	fs.writeFileSync(src, jpeg(4000, 3000, {orientation: 6}));
	let seen = null;
	const spawnImpl = (cmd, args) => {
		seen = {cmd, args};
		const {EventEmitter} = require('events');
		const child = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		const out = args[args.length - 1].replace(/^location=/, '');
		setImmediate(() => {
			fs.writeFileSync(out, 'jpeg');
			child.emit('close', 0);
		});
		return child;
	};
	const thumbs = new Thumbnailer({tmpDir: path.join(root.media, '.photosApp', 'Generated', '.in'), spawnImpl});
	const dst = path.join(root.media, '.photosApp', 'Generated', 'appGridThumbnail-id1-My_Photo.jpg');
	const dims = await thumbs.make(src, dst, 200, 200);
	assert.equal(seen.cmd, 'gst-launch-1.0');
	const line = seen.args.join(' ');
	assert.match(line, /video\/x-raw,width=200,height=150/, 'scaled while still sideways');
	assert.match(line, /videoflip method=clockwise/);
	assert.ok(!line.includes('My Photo'), 'the source name never reaches the pipeline parser');
	assert.deepEqual(dims, {'original-width': 4000, 'original-height': 3000, 'output-width': 150, 'output-height': 200});
	assert.equal(fs.readFileSync(dst, 'utf8'), 'jpeg');
	assert.deepEqual(fs.readdirSync(path.join(root.media, '.photosApp', 'Generated', '.in')), [], 'link removed');
});

test('paths: what may be touched, and names', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const paths = new Paths(root.media);
	assert.equal(paths.inMedia(path.join(root.media, 'a.jpg')), true);
	assert.equal(paths.inMedia(root.media), false);
	assert.equal(paths.inMedia(path.join(root.media, '..', 'etc')), false);
	assert.equal(paths.inMedia('/etc/passwd'), false);
	assert.equal(paths.inMedia(`${root.media}x/a`), false);
	assert.equal(paths.inMedia(null), false);
	assert.equal(paths.inCache(path.join(paths.cache, 'com.palm.dropbox')), true);

	assert.equal(segment('../../etc'), 'etc');
	assert.equal(segment('Camera Uploads/2024'), 'Camera_Uploads_2024');
	assert.equal(segment(''), 'x');
	assert.equal(segment('.hidden'), 'hidden');
	assert.equal(albumDirName('  Holiday / 2024 '), 'Holiday _ 2024');
	assert.equal(albumDirName('..'), null);
	assert.equal(albumDirName('.secret'), null);
	assert.equal(albumDirName('   '), null);
	assert.equal(albumDirName(42), null);

	const a = paths.cloudAlbumDir('com.palm.dropbox', 'me@x', '/Camera Uploads', 'Camera Uploads');
	const b = paths.cloudAlbumDir('com.palm.dropbox', 'me@x', '/Camera_Uploads', 'Camera Uploads');
	assert.notEqual(a, b, 'two albums with one name get two directories');
	assert.equal(paths.inCache(a), true);
});

test('files: nothing outside the media root is removed, through symlinks neither', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const paths = new Paths(root.media);
	const outside = path.join(root.dir, 'outside');
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
	fs.symlinkSync(outside, path.join(root.media, 'link'));

	assert.equal(await removeFile(paths, path.join(outside, 'keep.txt')), false);
	assert.equal(await removeFile(paths, path.join(root.media, 'link', 'keep.txt')), false);
	assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));

	fs.mkdirSync(paths.cache, {recursive: true});
	fs.symlinkSync(outside, path.join(paths.cache, 'evil'));
	fs.mkdirSync(path.join(outside, 'sub'));
	await assert.rejects(removeDir(paths, path.join(paths.cache, 'evil', 'sub'), {recursive: true}));
	assert.ok(fs.existsSync(path.join(outside, 'sub')));
	// The symlink as the directory itself: the link goes, not what it points at
	await removeDir(paths, path.join(paths.cache, 'evil'), {recursive: true});
	assert.ok(!fs.existsSync(path.join(paths.cache, 'evil')));
	await assert.rejects(removeDir(paths, path.join(root.media, 'DCIM'), {recursive: true}));
	await assert.rejects(removeDir(paths, paths.generated, {recursive: true}), /thumbnail directory/);
	assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));

	const inside = path.join(root.media, 'a.jpg');
	fs.writeFileSync(inside, 'x');
	assert.equal(await removeFile(paths, inside), true);
	assert.equal(await removeFile(paths, inside), false, 'gone already is fine');

	const album = path.join(root.media, 'Album');
	fs.mkdirSync(album);
	fs.writeFileSync(path.join(root.media, 'p.jpg'), 'one');
	const first = await copyInto(path.join(root.media, 'p.jpg'), album, 'p.jpg');
	const second = await copyInto(path.join(root.media, 'p.jpg'), album, 'p.jpg');
	assert.equal(path.basename(first), 'p.jpg');
	assert.equal(path.basename(second), 'p-1.jpg');
});

test('accounts: status follows the work, an error is handed out once', async () => {
	const m = new AccountsManager();
	const seen = [];
	m.on('changed', p => seen.push(p));
	m.upsert([{accountId: 'a1', username: 'me', templateId: 'com.palm.dropbox'}]);
	assert.deepEqual(Object.keys(seen[0].accounts).sort(), ['a1', 'local']);

	const endSync = m.begin('a1', 'sync');
	const endCopy = m.begin('a1', 'copy');
	endSync();
	assert.equal(m.view('a1').syncStatus, 'processing', 'still copying');
	endCopy(new Error('quota'));
	const last = seen[seen.length - 1];
	assert.deepEqual(last, {accountId: 'a1', syncStatus: 'idle', isEnabled: true, username: 'me',
		templateId: 'com.palm.dropbox', error: 'quota'});
	assert.equal(m.view('a1').error, undefined);

	await assert.rejects(m.track('local', 'cacheNsync', async () => {
		throw new Error('x');
	}));
	assert.equal(m.view('local').syncStatus, 'idle');

	m.setEnabled('a1', false);
	assert.equal(seen[seen.length - 1].isEnabled, false);
	m.remove('a1');
	m.remove('local');
	assert.deepEqual(Object.keys(m.snapshot()), ['local']);
});

test('queue: one at a time, a waiting key is not queued twice', async () => {
	const q = new SerialQueue();
	const order = [];
	let running = 0;
	const job = name => async () => {
		running++;
		assert.equal(running, 1);
		await new Promise(r => setTimeout(r, 5));
		order.push(name);
		running--;
		return name;
	};
	const a = q.run('a', job('a'));
	const b = q.run('b', job('b'));
	const a2 = q.run('a', job('a-again'));
	const failing = q.run(null, async () => {
		throw new Error('boom');
	});
	const c = q.run(null, job('c'));
	assert.equal(a, a2);
	await assert.rejects(failing);
	assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c']);
	assert.deepEqual(order, ['a', 'b', 'c']);
	await new Promise(r => setImmediate(r));
	assert.equal(q.busy, false);
});

test('download: to the final name only when complete', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const dest = path.join(root.dir, 'p.jpg');
	const body = Buffer.from('hello photo');
	const ok = async () => new Response(body, {status: 200, headers: {'content-length': String(body.length)}});
	assert.equal(await download('https://x.example/p.jpg?token=1', dest, {fetchImpl: ok}), body.length);
	assert.equal(fs.readFileSync(dest, 'utf8'), 'hello photo');

	await assert.rejects(download('file:///etc/passwd', dest + '2', {fetchImpl: ok}), /not fetching/);
	await assert.rejects(download('not a url', dest + '2', {fetchImpl: ok}), /not a URL/);
	await assert.rejects(download('https://x.example/a', dest + '3',
		{fetchImpl: async () => new Response('no', {status: 404})}), /HTTP 404/);
	await assert.rejects(download('https://x.example/a', dest + '4', {fetchImpl: ok, maxBytes: 3}), /more than/);
	await assert.rejects(download('https://x.example/a', dest + '5',
		{fetchImpl: async () => new Response(new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(10));
				c.error(new Error('reset'));
			}
		}))}), /reset/);
	assert.deepEqual(fs.readdirSync(root.dir).sort(), ['media', 'p.jpg'], 'no .part left behind');
});

test('download: copies a file:// photo from inside the media root only', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const noFetch = async () => {
		throw new Error('fetched');
	};
	const store = path.join(root.media, '.mega-photos');
	fs.mkdirSync(store);
	const src = path.join(store, 'j7Bx-photo.jpg');
	fs.writeFileSync(src, 'plain photo');
	const out = path.join(root.media, 'out');
	fs.mkdirSync(out);
	const dest = path.join(out, 'p.jpg');
	const opts = {fetchImpl: noFetch, localRoot: root.media};

	assert.equal(await download(`file://${src}`, dest, opts), 'plain photo'.length);
	assert.equal(fs.readFileSync(dest, 'utf8'), 'plain photo');
	assert.ok(fs.existsSync(src), 'the connector\'s copy is left alone');

	// Without a root, as before: never
	await assert.rejects(download(`file://${src}`, dest + '1', {fetchImpl: noFetch}), /not fetching/);
	// Outside the root, directly, through .. and through a symlink
	const outside = path.join(root.dir, 'secret');
	fs.writeFileSync(outside, 'secret');
	await assert.rejects(download(`file://${outside}`, dest + '2', opts), /outside/);
	await assert.rejects(download(`file://${store}/../../secret`, dest + '3', opts), /outside/);
	fs.symlinkSync(outside, path.join(store, 'link.jpg'));
	await assert.rejects(download(`file://${store}/link.jpg`, dest + '4', opts), /outside/);
	// Not a file, missing, empty, too big
	await assert.rejects(download(`file://${store}`, dest + '5', opts), /not a file/);
	await assert.rejects(download(`file://${store}/gone.jpg`, dest + '6', opts), /no file/);
	fs.writeFileSync(path.join(store, 'empty.jpg'), '');
	await assert.rejects(download(`file://${store}/empty.jpg`, dest + '7', opts), /empty/);
	await assert.rejects(download(`file://${src}`, dest + '8', {...opts, maxBytes: 3}), /more than/);
	assert.deepEqual(fs.readdirSync(out), ['p.jpg'], 'nothing else written');

	// A temporary copy goes once copied, and only then
	await assert.rejects(download(`file://${src}`, dest + '9', {...opts, removeSource: true, maxBytes: 3}), /more than/);
	assert.ok(fs.existsSync(src), 'kept when the copy failed');
	assert.equal(await download(`file://${src}`, dest + '9', {...opts, removeSource: true}), 'plain photo'.length);
	assert.equal(fs.readFileSync(dest + '9', 'utf8'), 'plain photo');
	assert.ok(!fs.existsSync(src), 'removed');
});
