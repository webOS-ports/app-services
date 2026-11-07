// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// HEIC (HEIF with HEVC, what iPhones take) turned into JPEG with libheif's
// heif-dec. Neither the web view the Photos app shows pictures in nor
// GStreamer, which makes the thumbnails, reads HEIC, so a photo that comes
// down as HEIC is kept as the JPEG heif-dec makes of it: upright (heif-dec
// applies the rotation and mirroring HEIF stores beside the picture) and
// with the EXIF Orientation set to 1 to match, so nothing turns it again.
//
// heif-dec writes every top-level image a file holds (out-1.jpg, out-2.jpg,
// ... when there is more than one) and has no option for the primary one
// only. So it writes into a folder of its own, and the one kept is the
// primary image, which heif-info names: both list the top-level images in
// the same order (heif_context_get_list_of_top_level_image_IDs). Where
// heif-info says nothing usable, the largest picture is kept.
//
// Without heif-dec on the device (no libheif), a HEIC photo stays what it
// was before: a file this service cannot read.

const {spawn} = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {probe} = require('./imageinfo');

const HEAD = 64;
// The ftyp brands of HEIF holding HEVC: still images, sequences, and their
// multi-layer variants. mif1/msf1 alone say only "HEIF", which AVIF is too.
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

// Whether the file is HEIF holding HEVC, from its ftyp box
async function isHeic(file) {
	let fh;
	try {
		fh = await fsp.open(file, 'r');
	} catch (e) {
		return false;
	}
	try {
		const b = Buffer.alloc(HEAD);
		const {bytesRead} = await fh.read(b, 0, HEAD, 0);
		return heicBrand(b.subarray(0, bytesRead));
	} catch (e) {
		return false;
	} finally {
		await fh.close();
	}
}

function heicBrand(b) {
	if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') {
		return false;
	}
	const size = Math.min(b.readUInt32BE(0), b.length);
	if (size < 16) {
		return false;
	}
	// the major brand, then the compatible ones after the minor version
	const brands = [b.toString('latin1', 8, 12)];
	for (let o = 16; o + 4 <= size; o += 4) {
		brands.push(b.toString('latin1', o, o + 4));
	}
	return brands.some(brand => HEVC_BRANDS.has(brand));
}

let serial = 0;

class HeifDecoder {
	// infoBin: heif-info, by default the one beside bin
	constructor({bin = 'heif-dec', infoBin, tmpDir, timeoutMs = 120000, quality = 90, spawnImpl = spawn} = {}) {
		this.bin = bin;
		this.infoBin = infoBin || (path.dirname(bin) === '.' ? 'heif-info' : path.join(path.dirname(bin), 'heif-info'));
		this.tmpDir = tmpDir;
		this.timeoutMs = timeoutMs;
		this.quality = quality;
		this.spawn = spawnImpl;
	}

	// Replaces file, a HEIC picture, with the JPEG of it. Resolves with what
	// probe says of the JPEG; rejects (the file left as it was) if it cannot.
	async toJpeg(file) {
		await fsp.mkdir(this.tmpDir, {recursive: true});
		const dir = path.join(this.tmpDir, `heif-${process.pid}-${++serial}`);
		await fsp.mkdir(dir, {mode: 0o700});
		try {
			// An absolute path never reads as an option.
			const source = path.resolve(file);
			const primary = await this.primaryIndex(source);
			await this.run(this.bin, ['--quiet', '-q', String(this.quality), source, path.join(dir, 'out.jpg')]);
			const names = (await fsp.readdir(dir)).filter(name => /^out(-\d+)?\.jpg$/.test(name));
			let best = null;
			for (const name of names) {
				const out = path.join(dir, name);
				const info = await probe(out);
				if (!info || info.format !== 'jpeg') {
					continue;
				}
				const n = name === 'out.jpg' ? 1 : Number(/-(\d+)\./.exec(name)[1]);
				if (primary !== null && n === primary) {
					best = {out, info};
					break;
				}
				if (!best || info.width * info.height > best.info.width * best.info.height) {
					best = {out, info};
				}
			}
			if (!best) {
				throw new Error(`${this.bin} made no picture of ${path.basename(file)}`);
			}
			await moveOver(best.out, file);
			return best.info;
		} finally {
			await fsp.rm(dir, {recursive: true, force: true}).catch(() => {});
		}
	}

	// Which of the file's top-level images (1-based, as heif-dec numbers them) is the primary
	// one, from heif-info's "image: WxH (id=N), primary" lines; null if it cannot say.
	async primaryIndex(source) {
		let out;
		try {
			out = await this.run(this.infoBin, [source], {stdout: true});
		} catch (e) {
			return null;
		}
		const images = out.split('\n').filter(line => /^image: \d+x\d+ \(id=\d+\)/.test(line));
		const at = images.findIndex(line => /\), primary\s*$/.test(line));
		return at < 0 ? null : at + 1;
	}

	// Resolves with what bin wrote to stdout (with stdout: true; at most 64 KiB) once it exits with 0
	run(bin, args, {stdout = false} = {}) {
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = this.spawn(bin, args, {stdio: ['ignore', stdout ? 'pipe' : 'ignore', 'pipe']});
			} catch (e) {
				reject(e);
				return;
			}
			let stderr = '';
			let output = '';
			let done = false;
			const finish = err => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				if (err) {
					reject(err);
				} else {
					resolve(output);
				}
			};
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				finish(new Error(`${bin} took longer than ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			if (stdout && child.stdout) {
				child.stdout.on('data', d => {
					if (output.length < 65536) {
						output += d;
					}
				});
			}
			if (child.stderr) {
				child.stderr.on('data', d => {
					stderr = (stderr + d).slice(-400);
				});
			}
			child.on('error', e => finish(e));
			child.on('close', code => finish(code === 0 ? null :
				new Error(`${bin} exited with ${code}: ${stderr.trim().split('\n').pop() || 'no message'}`)));
		});
	}
}

// Renames src over dst, or copies it there where they are on different file systems
async function moveOver(src, dst) {
	try {
		await fsp.rename(src, dst);
	} catch (e) {
		if (e.code !== 'EXDEV') {
			throw e;
		}
		const part = `${dst}.part`;
		try {
			await fsp.copyFile(src, part);
			await fsp.rename(part, dst);
		} catch (e2) {
			await fsp.unlink(part).catch(() => {});
			throw e2;
		}
	}
}

// What probe says of file, a HEIC picture turned into JPEG in place first
// when decoder is there. null if it is no picture this service can read.
async function readable(file, decoder, log) {
	const info = await probe(file);
	if (info || !decoder || !await isHeic(file)) {
		return info;
	}
	try {
		return await decoder.toJpeg(file);
	} catch (e) {
		if (log) {
			log.warn(`could not turn ${path.basename(file)} into JPEG: ${e.message}`);
		}
		return null;
	}
}

module.exports = {HeifDecoder, isHeic, heicBrand, readable, HEVC_BRANDS};
