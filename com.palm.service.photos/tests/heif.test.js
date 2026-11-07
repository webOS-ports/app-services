// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// heif.js: telling HEIC by its ftyp box, and heif-dec's JPEG kept in its
// place. heif-dec and heif-info are played by a stand-in; with HEIF_DEC (a heif-dec to run;
// HEIF_INFO its heif-info, if not beside it)
// and HEIC_SAMPLE (a .heic file) set, the last test runs the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');
const {HeifDecoder, isHeic, heicBrand, readable} = require('../lib/heif');
const {probe} = require('../lib/imageinfo');
const {png, jpeg, heic, tmpRoot} = require('./fake');

// A spawn that plays heif-dec, which writes the given pictures as out.jpg or out-N.jpg, then exits
// with code; and heif-info, which prints info (null: exits with 1)
function fakeSpawn(pictures, {code = 0, stderr = '', hang = false, info = null} = {}) {
	const calls = [];
	const fn = (cmd, args, opts) => {
		const child = new EventEmitter();
		calls.push({cmd, args, opts, child});
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		if (/heif-info$/.test(cmd)) {
			setImmediate(() => {
				if (info !== null) {
					child.stdout.emit('data', Buffer.from(info));
				}
				child.emit('close', info === null ? 1 : 0);
			});
			return child;
		}
		child.killed = null;
		child.kill = signal => {
			child.killed = signal;
			setImmediate(() => child.emit('close', null));
		};
		if (!hang) {
			setImmediate(() => {
				const out = args[args.length - 1];
				pictures.forEach((b, i) => fs.writeFileSync(pictures.length > 1 ? out.replace(/\.jpg$/, `-${i + 1}.jpg`) : out, b));
				if (stderr) {
					child.stderr.emit('data', Buffer.from(stderr));
				}
				child.emit('close', code);
			});
		}
		return child;
	};
	fn.calls = calls;
	return fn;
}

test('heif: HEIC told by its ftyp brands; AVIF, other HEIF and other pictures not', async t => {
	assert.equal(heicBrand(heic()), true);
	assert.equal(heicBrand(heic('mif1', ['heic'])), true, 'a compatible brand counts');
	assert.equal(heicBrand(heic('msf1', ['hevc'])), true, 'a sequence');
	assert.equal(heicBrand(heic('heix', [])), true);
	assert.equal(heicBrand(heic('avif', ['mif1', 'miaf'])), false, 'AV1: not decoded here');
	assert.equal(heicBrand(heic('mif1', ['avif'])), false);
	assert.equal(heicBrand(heic('mif1', [])), false, 'HEIF of nothing known');
	assert.equal(heicBrand(heic('isom', ['mp41'])), false, 'an MP4');
	assert.equal(heicBrand(jpeg(10, 10)), false);
	assert.equal(heicBrand(png(10, 10)), false);
	assert.equal(heicBrand(Buffer.alloc(0)), false);
	// a brand past the box's own size is not in it
	const b = heic('mif1', ['heic']);
	b.writeUInt32BE(16, 0);
	assert.equal(heicBrand(b), false);

	const root = tmpRoot();
	t.after(root.cleanup);
	const f = path.join(root.media, 'a.bin');
	fs.writeFileSync(f, heic());
	assert.equal(await isHeic(f), true);
	assert.equal(await isHeic(path.join(root.media, 'none')), false);
});

const decCall = spawnImpl => spawnImpl.calls.find(c => /heif-dec$/.test(c.cmd));

test('heif: heif-dec into a folder of its own; with no word from heif-info, the largest picture replaces the file', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const tmpDir = path.join(root.media, '.photosApp', 'Generated', '.heif');
	const src = path.join(root.media, '-IMG 1.HEIC');
	fs.writeFileSync(src, heic());
	const spawnImpl = fakeSpawn([jpeg(320, 240), jpeg(4032, 3024), png(5000, 5000)]);
	const dec = new HeifDecoder({tmpDir, spawnImpl, quality: 88});
	// named relative to here, the name would begin with '-': heif-dec is given it absolute
	const info = await dec.toJpeg(path.relative(process.cwd(), src));
	assert.deepEqual([info.format, info.width, info.height], ['jpeg', 4032, 3024]);
	assert.deepEqual(fs.readFileSync(src), jpeg(4032, 3024), 'the largest JPEG, in the file\'s place');
	const {cmd, args, opts} = decCall(spawnImpl);
	assert.equal(cmd, 'heif-dec');
	assert.deepEqual(spawnImpl.calls[0].cmd, 'heif-info');
	assert.deepEqual(spawnImpl.calls[0].args, [path.resolve(src)]);
	assert.deepEqual(args.slice(0, 3), ['--quiet', '-q', '88']);
	assert.equal(args[3], path.resolve(src), 'an absolute path: never an option');
	assert.ok(args[4].startsWith(tmpDir + path.sep) && args[4].endsWith(`${path.sep}out.jpg`));
	assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe']);
	assert.deepEqual(fs.readdirSync(tmpDir), [], 'its folder removed');

	// one picture: out.jpg
	fs.writeFileSync(src, heic());
	assert.equal((await new HeifDecoder({tmpDir, spawnImpl: fakeSpawn([jpeg(100, 50)])}).toJpeg(src)).width, 100);
	// heif-info beside a heif-dec named with its folder
	const named = fakeSpawn([jpeg(10, 10)]);
	fs.writeFileSync(src, heic());
	await new HeifDecoder({bin: '/opt/x/heif-dec', tmpDir, spawnImpl: named}).toJpeg(src);
	assert.deepEqual(named.calls.map(c => c.cmd), ['/opt/x/heif-info', '/opt/x/heif-dec']);
});

test('heif: the primary image heif-info names is kept, not the largest', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const tmpDir = path.join(root.media, '.heif');
	const src = path.join(root.media, 'a.heic');
	const info = 'MIME type: image/heif\nmain brand: mif1\n\nimage: 1280x720 (id=1002)\nimage: 1280x720 (id=1005)\n' +
		'  transformations:\n    angle (ccw): 90\nimage: 300x300 (id=1006), primary\n  colorspace: YCbCr, 4:2:0\n';
	const pictures = [jpeg(1280, 720), jpeg(720, 1280), jpeg(300, 300)];
	fs.writeFileSync(src, heic());
	let got = await new HeifDecoder({tmpDir, spawnImpl: fakeSpawn(pictures, {info})}).toJpeg(src);
	assert.deepEqual([got.width, got.height], [300, 300]);
	assert.deepEqual(fs.readFileSync(src), jpeg(300, 300));
	// the second of three
	fs.writeFileSync(src, heic());
	got = await new HeifDecoder({tmpDir, spawnImpl: fakeSpawn(pictures, {info: info.replace(', primary', '').replace('(id=1005)', '(id=1005), primary')})}).toJpeg(src);
	assert.deepEqual([got.width, got.height], [720, 1280]);
	// the primary unreadable, or none named: the largest
	fs.writeFileSync(src, heic());
	got = await new HeifDecoder({tmpDir, spawnImpl: fakeSpawn([jpeg(1280, 720), jpeg(2000, 1000), Buffer.from('x')], {info})}).toJpeg(src);
	assert.deepEqual([got.width, got.height], [2000, 1000]);
	fs.writeFileSync(src, heic());
	got = await new HeifDecoder({tmpDir, spawnImpl: fakeSpawn(pictures, {info: 'image: 1x1 (id=1)\n'})}).toJpeg(src);
	assert.deepEqual([got.width, got.height], [1280, 720]);
	assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('heif: a heif-dec that fails, makes nothing, hangs or is not there leaves the file as it was', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const tmpDir = path.join(root.media, '.heif');
	const src = path.join(root.media, 'a.heic');
	const before = heic();
	fs.writeFileSync(src, before);
	const cases = [
		[{spawnImpl: fakeSpawn([], {code: 1, stderr: 'Could not decode\nInvalid input: No ftyp box\n'})}, /exited with 1: Invalid input: No ftyp box/],
		[{spawnImpl: fakeSpawn([Buffer.from('not a jpeg')])}, /made no picture/],
		[{spawnImpl: fakeSpawn([png(10, 10)])}, /made no picture/],
		[{spawnImpl: fakeSpawn([], {hang: true}), timeoutMs: 20}, /took longer than 20 ms/],
		[{bin: path.join(root.dir, 'no-such-heif-dec')}, /ENOENT/],
		[{spawnImpl: () => { throw new Error('spawn refused'); }}, /spawn refused/]
	];
	for (const [opts, error] of cases) {
		await assert.rejects(new HeifDecoder(Object.assign({tmpDir}, opts)).toJpeg(src), error);
		assert.deepEqual(fs.readFileSync(src), before);
		assert.deepEqual(fs.readdirSync(tmpDir), [], 'nothing left behind');
	}
	const hung = fakeSpawn([], {hang: true});
	await assert.rejects(new HeifDecoder({tmpDir, spawnImpl: hung, timeoutMs: 20}).toJpeg(src));
	assert.equal(hung.calls.filter(c => c.cmd === 'heif-dec').length, 1);
	assert.equal(decCall(hung).child.killed, 'SIGKILL', 'a heif-dec that hangs is killed');
});

test('heif: readable - a picture as it is; HEIC decoded only when there is a decoder; a failure logged', async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const asked = [];
	const decoder = {fail: false, toJpeg: async file => {
		asked.push(file);
		if (decoder.fail) {
			throw new Error('broken');
		}
		fs.writeFileSync(file, jpeg(30, 20));
		return probe(file);
	}};
	const warned = [];
	const log = {warn: m => warned.push(m)};
	const f = name => path.join(root.media, name);
	fs.writeFileSync(f('a.jpg'), jpeg(10, 10));
	fs.writeFileSync(f('b.heic'), heic());
	fs.writeFileSync(f('c.txt'), 'text');
	assert.equal((await readable(f('a.jpg'), decoder, log)).width, 10);
	assert.equal(await readable(f('c.txt'), decoder, log), null);
	assert.equal(await readable(f('b.heic'), null, log), null, 'no decoder: unreadable, as before');
	assert.deepEqual(asked, []);
	assert.equal((await readable(f('b.heic'), decoder, log)).width, 30);
	assert.deepEqual(asked, [f('b.heic')]);
	fs.writeFileSync(f('b.heic'), heic());
	decoder.fail = true;
	assert.equal(await readable(f('b.heic'), decoder, log), null);
	assert.deepEqual(warned, ['could not turn b.heic into JPEG: broken']);
});

const REAL = process.env.HEIF_DEC && process.env.HEIC_SAMPLE;
test('heif: the real heif-dec on a real HEIC', {skip: REAL ? false : 'HEIF_DEC and HEIC_SAMPLE not set'}, async t => {
	const root = tmpRoot();
	t.after(root.cleanup);
	const src = path.join(root.media, 'sample.heic');
	fs.copyFileSync(process.env.HEIC_SAMPLE, src);
	assert.equal(await isHeic(src), true);
	assert.equal(await probe(src), null);
	const info = await new HeifDecoder({bin: process.env.HEIF_DEC, infoBin: process.env.HEIF_INFO,
		tmpDir: path.join(root.media, '.heif')}).toJpeg(src);
	assert.equal(info.format, 'jpeg');
	assert.equal(info.orientation, 1, 'upright, and its EXIF says so');
	assert.ok(info.width > 0 && info.height > 0);
	assert.deepEqual(await probe(src), info);
	if (process.env.HEIC_SAMPLE_SIZE) {
		assert.deepEqual(`${info.width}x${info.height}`, process.env.HEIC_SAMPLE_SIZE);
	}
});
