// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Scaled JPEG copies of an image with gst-launch-1.0, which every LuneOS
// image has with the jpeg, png, gdkpixbuf, videoconvertscale and videoflip
// elements. On legacy webOS this was extractfs.
//
// GStreamer parses its pipeline from the arguments, so neither the source
// nor the target ever goes in as it is: the source is reached through a
// symlink with a plain name, and the output is written to a plain name next
// to the target and renamed into place.

const {spawn} = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const {probe, displaySize} = require('./imageinfo');

// videoflip methods for the EXIF orientations 2-8
const FLIP = {2: 'horizontal-flip', 3: 'rotate-180', 4: 'vertical-flip', 5: 'upper-left-diagonal',
	6: 'clockwise', 7: 'upper-right-diagonal', 8: 'counterclockwise'};

let serial = 0;

class Thumbnailer {
	constructor({gst = 'gst-launch-1.0', tmpDir, timeoutMs = 60000, quality = 85, spawnImpl = spawn} = {}) {
		this.gst = gst;
		this.tmpDir = tmpDir;
		this.timeoutMs = timeoutMs;
		this.quality = quality;
		this.spawn = spawnImpl;
	}

	// The output size for a box of maxW x maxH, never larger than the image
	static fit(info, maxW, maxH) {
		const shown = displaySize(info);
		const scale = Math.min(maxW / shown.width, maxH / shown.height, 1);
		return {width: even(shown.width * scale), height: even(shown.height * scale)};
	}

	// Writes dst, a JPEG that fits maxW x maxH. Resolves with the
	// extractfs-style dimensions the db entries carry.
	async make(src, dst, maxW, maxH, info) {
		info = info || await probe(src);
		if (!info) {
			throw new Error(`not an image: ${src}`);
		}
		const out = Thumbnailer.fit(info, maxW, maxH);
		// Scaled while still stored sideways, then turned
		const turned = info.orientation >= 5;
		const scaled = turned ? {width: out.height, height: out.width} : out;

		await fsp.mkdir(this.tmpDir, {recursive: true});
		await fsp.mkdir(path.dirname(dst), {recursive: true});
		const n = `${process.pid}-${++serial}`;
		const link = path.join(this.tmpDir, `in-${n}.${info.ext || 'img'}`);
		const tmpOut = path.join(path.dirname(dst), `.tmp-${n}.jpg`);
		await fsp.symlink(path.resolve(src), link);
		try {
			const args = ['-q', 'filesrc', `location=${link}`, '!', 'decodebin', '!',
				'videoconvertscale', '!',
				`video/x-raw,width=${scaled.width},height=${scaled.height},pixel-aspect-ratio=1/1`, '!'];
			if (FLIP[info.orientation]) {
				args.push('videoflip', `method=${FLIP[info.orientation]}`, '!');
			}
			args.push('videoconvert', '!', 'jpegenc', `quality=${this.quality}`, '!',
				'filesink', `location=${tmpOut}`);
			await this.run(args);
			const st = await fsp.stat(tmpOut);
			if (!st.size) {
				throw new Error('gst-launch-1.0 wrote nothing');
			}
			await fsp.rename(tmpOut, dst);
		} catch (e) {
			await fsp.unlink(tmpOut).catch(() => {});
			throw e;
		} finally {
			await fsp.unlink(link).catch(() => {});
		}
		return {
			'original-width': info.width,
			'original-height': info.height,
			'output-width': out.width,
			'output-height': out.height
		};
	}

	run(args) {
		return new Promise((resolve, reject) => {
			let stderr = '';
			let done = false;
			let timer = null;
			const finish = err => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			};
			const child = this.spawn(this.gst, args, {stdio: ['ignore', 'ignore', 'pipe']});
			timer = setTimeout(() => {
				child.kill('SIGKILL');
				finish(new Error(`gst-launch-1.0 timed out after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			child.stderr.on('data', d => {
				if (stderr.length < 4096) {
					stderr += d;
				}
			});
			child.on('error', finish);
			child.on('close', code => finish(code === 0 ? null :
				new Error(`gst-launch-1.0 exited with ${code}: ${stderr.trim()}`)));
		});
	}
}

function even(v) {
	return Math.max(2, Math.round(v / 2) * 2);
}

module.exports = {Thumbnailer};
