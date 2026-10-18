// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// What kind of image a file is, its size and EXIF orientation, read from
// the header alone. Takes the place of fileparserd, which the old service
// asked whether a download was an image and what its extension should be.

const fsp = require('fs').promises;

const HEAD = 64;
const MAX_SEGMENT_READ = 65536;
const MAX_DIMENSION = 65535 * 4;

const EXTENSIONS = {jpeg: 'jpg', png: 'png', gif: 'gif', bmp: 'bmp', webp: 'webp'};

// {format, ext, width, height, orientation} or null if it is no image we know
async function probe(file) {
	let fh;
	try {
		fh = await fsp.open(file, 'r');
	} catch (e) {
		return null;
	}
	try {
		const size = (await fh.stat()).size;
		const head = await readAt(fh, 0, HEAD);
		let info = null;
		if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
			info = await jpeg(fh, size);
		} else {
			info = fromHead(head);
		}
		if (!info || !(info.width > 0) || !(info.height > 0) ||
				info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) {
			return null;
		}
		info.ext = EXTENSIONS[info.format];
		info.orientation = info.orientation || 1;
		return info;
	} catch (e) {
		return null;
	} finally {
		await fh.close();
	}
}

async function readAt(fh, position, length) {
	const buf = Buffer.alloc(length);
	const {bytesRead} = await fh.read(buf, 0, length, position);
	return buf.subarray(0, bytesRead);
}

function fromHead(b) {
	if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a &&
			b.toString('latin1', 12, 16) === 'IHDR') {
		return {format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20)};
	}
	if (b.length >= 10 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) {
		return {format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8)};
	}
	if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM') {
		return {format: 'bmp', width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22))};
	}
	if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
		const chunk = b.toString('latin1', 12, 16);
		if (chunk === 'VP8X') {
			return {format: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3)};
		}
		if (chunk === 'VP8 ') {
			return {format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff};
		}
		if (chunk === 'VP8L' && b[20] === 0x2f) {
			const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
			return {
				format: 'webp',
				width: 1 + (((b1 & 0x3f) << 8) | b0),
				height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
			};
		}
	}
	return null;
}

// Walks the JPEG markers up to the frame header, picking up the EXIF orientation on the way.
async function jpeg(fh, size) {
	let pos = 2;
	let orientation = 1;
	for (let guard = 0; guard < 1000 && pos + 4 <= size; guard++) {
		const m = await readAt(fh, pos, 4);
		if (m.length < 2 || m[0] !== 0xff) {
			return null;
		}
		const marker = m[1];
		if (marker === 0xff) {          // fill byte
			pos += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			pos += 2;
			continue;
		}
		if (m.length < 4) {
			return null;
		}
		const length = m.readUInt16BE(2);
		if (length < 2) {
			return null;
		}
		if (marker === 0xe1 && orientation === 1) {
			const seg = await readAt(fh, pos + 4, Math.min(length - 2, MAX_SEGMENT_READ));
			orientation = exifOrientation(seg) || 1;
		}
		const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrame) {
			const sof = await readAt(fh, pos + 4, 5);
			if (sof.length < 5) {
				return null;
			}
			return {format: 'jpeg', height: sof.readUInt16BE(1), width: sof.readUInt16BE(3), orientation};
		}
		if (marker === 0xda || marker === 0xd9) {   // scan data or the end, and no frame header yet
			return null;
		}
		pos += 2 + length;
	}
	return null;
}

// The Orientation tag (0x0112) of IFD0 in an APP1 "Exif" segment
function exifOrientation(seg) {
	if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') {
		return null;
	}
	const t = seg.subarray(6);
	const order = t.toString('latin1', 0, 2);
	if (order !== 'II' && order !== 'MM') {
		return null;
	}
	const le = order === 'II';
	const u16 = o => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
	const u32 = o => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
	if (u16(2) !== 42) {
		return null;
	}
	const ifd = u32(4);
	if (ifd + 2 > t.length) {
		return null;
	}
	const count = u16(ifd);
	for (let i = 0; i < count; i++) {
		const e = ifd + 2 + i * 12;
		if (e + 12 > t.length) {
			return null;
		}
		if (u16(e) === 0x0112) {
			const v = u16(e + 8);
			return v >= 1 && v <= 8 ? v : null;
		}
	}
	return null;
}

// Width and height as shown: orientations 5 to 8 turn the picture on its side.
function displaySize(info) {
	return info.orientation >= 5 ? {width: info.height, height: info.width} :
		{width: info.width, height: info.height};
}

module.exports = {probe, displaySize, exifOrientation, EXTENSIONS};
