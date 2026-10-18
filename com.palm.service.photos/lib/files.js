// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Where things go, and the file operations the service does. Every path it
// deletes, renames or writes is checked against the media root first: the
// paths come from db entries that other apps can write too, and the service
// runs as root.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

class Paths {
	constructor(mediaRoot = '/media/internal') {
		this.media = path.resolve(mediaRoot);
		// Downloaded cloud photos: .photosApp/<templateId>/<user>/<album>/
		this.cache = path.join(this.media, '.photosApp');
		// Thumbnails and screen-size copies the service makes
		this.generated = path.join(this.cache, 'Generated');
	}

	// True if p is inside dir (not dir itself)
	static within(dir, p) {
		if (typeof p !== 'string' || !p || p.indexOf('\0') >= 0) {
			return false;
		}
		const rel = path.relative(dir, path.resolve(p));
		return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
	}

	inMedia(p) {
		return Paths.within(this.media, p);
	}

	inCache(p) {
		return Paths.within(this.cache, p);
	}

	accountDir(templateId, username) {
		return path.join(this.cache, segment(templateId), segment(username || 'account'));
	}

	// One directory per cloud album. The album id goes in as a hash: it is
	// often a path or a URL, and two albums may have the same name.
	cloudAlbumDir(templateId, username, aid, name) {
		return path.join(this.accountDir(templateId, username), `${segment(name || 'album')}-${shortHash(aid)}`);
	}
}

// A name that is safe as one path segment and for GStreamer's pipeline
// parser: letters, digits, '.', '_' and '-'; never hidden, never empty.
function segment(name) {
	let s = String(name === undefined || name === null ? '' : name)
		.normalize('NFKD').replace(/[^\x20-\x7e]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '_')
		.replace(/^[._-]+/, '')
		.slice(0, 80);
	if (!s) {
		s = 'x';
	}
	return s;
}

function shortHash(value) {
	return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 10);
}

// A local album's directory name from what the user typed (createAlbum,
// renameAlbum). Null if it cannot be one: empty, "." or "..", hidden (the
// media indexer would never see it) or over-long.
function albumDirName(name) {
	if (typeof name !== 'string') {
		return null;
	}
	const n = name.trim().replace(/[\0-\x1f\x7f]/g, '').replace(/\//g, '_');
	if (!n || n.startsWith('.') || Buffer.byteLength(n) > 200) {
		return null;
	}
	return n;
}

async function exists(p) {
	try {
		await fsp.lstat(p);
		return true;
	} catch (e) {
		return false;
	}
}

async function mkdirs(p) {
	await fsp.mkdir(p, {recursive: true, mode: 0o755});
}

// p with its directory resolved through symlinks, if that is still inside
// root (resolved too); else null. The last component is kept as it is, so a
// symlink there is removed itself rather than what it points at.
async function resolvedInside(root, p) {
	if (!Paths.within(root, p)) {
		return null;
	}
	let realRoot;
	let realDir;
	try {
		realRoot = await fsp.realpath(root);
		realDir = await fsp.realpath(path.dirname(path.resolve(p)));
	} catch (e) {
		return null;
	}
	const resolved = path.join(realDir, path.basename(p));
	return Paths.within(realRoot, resolved) ? resolved : null;
}

// Removes a file the service is allowed to remove; a file that is already gone is fine.
async function removeFile(paths, p) {
	const target = await resolvedInside(paths.media, p);
	if (!target) {
		return false;
	}
	try {
		await fsp.unlink(target);
		return true;
	} catch (e) {
		if (e.code === 'ENOENT') {
			return false;
		}
		throw e;
	}
}

// A directory: only when empty, unless it is one of the service's own (under .photosApp).
async function removeDir(paths, p, {recursive = false} = {}) {
	if (recursive) {
		const target = await resolvedInside(paths.cache, p);
		if (!target) {
			if (!(await exists(p)) && paths.inCache(p)) {
				return;
			}
			throw new Error(`not removing ${p}: not a cloud album or account directory`);
		}
		if (target === path.join(await fsp.realpath(paths.cache), 'Generated')) {
			throw new Error(`not removing ${p}: the thumbnail directory`);
		}
		// rm does not follow symlinks below the directory it removes
		await fsp.rm(target, {recursive: true, force: true});
		return;
	}
	const target = await resolvedInside(paths.media, p);
	if (!target) {
		if (!(await exists(p))) {
			return;
		}
		throw new Error(`not removing ${p}: outside ${paths.media}`);
	}
	try {
		await fsp.rmdir(target);
	} catch (e) {
		if (e.code !== 'ENOENT') {
			throw e;
		}
	}
}

// dir/name, or dir/name-1.ext, name-2.ext, ... whichever does not exist yet
async function freeName(dir, name) {
	const ext = path.extname(name);
	const base = name.slice(0, name.length - ext.length);
	let candidate = path.join(dir, name);
	for (let n = 1; await exists(candidate); n++) {
		candidate = path.join(dir, `${base}-${n}${ext}`);
	}
	return candidate;
}

// Copies src into dir under a free name; never replaces a file.
async function copyInto(src, dir, name) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const dst = await freeName(dir, name);
		try {
			await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
			return dst;
		} catch (e) {
			if (e.code !== 'EEXIST') {
				throw e;
			}
		}
	}
	throw new Error(`no free name for ${name} in ${dir}`);
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

module.exports = {
	Paths, segment, shortHash, albumDirName, exists, mkdirs,
	removeFile, removeDir, freeName, copyInto, nowSeconds
};
