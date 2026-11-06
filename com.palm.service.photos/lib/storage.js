// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// How much of the device the cloud photos take.
//
// The whole pictures that come down (an opened photo's, or every photo of a connector that
// has no preview of its own) are kept up to a cap: the user's setting (capBytes, 200 MB
// unless changed), or 5% of the space there is for them, whichever is smaller. Past it,
// those opened longest ago go back to their preview (the sync engine drops them). Nothing
// comes down while less than FLOOR_BYTES is free. The pictures of albums kept on the device
// count for neither.
//
// The photo entries are the media indexer's kind, which cannot be searched by when a photo
// was opened, so that is kept here, in .photosApp/.storage.json, with the settings:
// {settings: {capBytes}, originals: {<_id>: {bytes, opened, albumId}}}.

const fsp = require('fs').promises;
const path = require('path');
const log = require('./log');

const MB = 1024 * 1024;
const DEFAULT_CAP_BYTES = 200 * MB;
const CAP_CHOICES = [100 * MB, 200 * MB, 500 * MB, 1024 * MB, 2048 * MB];
const SHARE_OF_FREE = 0.05;
const FLOOR_BYTES = 1024 * MB;
const FREE_CACHE_MS = 5000;

class NoSpaceError extends Error {
	constructor(free) {
		super(`not enough free space: ${Math.floor(free / MB)} MB free, ${FLOOR_BYTES / MB} MB kept free`);
		this.code = 'NO_SPACE';
	}
}

class Storage {
	constructor({paths, statfs = p => fsp.statfs(p), now = Date.now}) {
		this.paths = paths;
		this.file = path.join(paths.cache, '.storage.json');
		this.statfs = statfs;
		this.now = now;
		this.settings = {capBytes: DEFAULT_CAP_BYTES};
		this.originals = new Map();
		this.loaded = null;
		this.saving = Promise.resolve();
		this.freeAt = 0;
		this.freeBytes = 0;
		this.fresh = false;            // no file was there: the originals already here are not in it
	}

	load() {
		if (!this.loaded) {
			this.loaded = (async () => {
				let data = null;
				try {
					data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
				} catch (e) {
					if (e.code !== 'ENOENT') {
						log.warn(`${this.file} is not read: ${e.message}`);
					}
					this.fresh = true;
				}
				if (data && typeof data === 'object') {
					const cap = data.settings && data.settings.capBytes;
					if (validCap(cap)) {
						this.settings.capBytes = cap;
					}
					for (const [id, o] of Object.entries(data.originals || {})) {
						if (o && Number.isFinite(o.bytes) && Number.isFinite(o.opened)) {
							this.originals.set(id, {bytes: o.bytes, opened: o.opened, albumId: String(o.albumId || '')});
						}
					}
				}
			})();
		}
		return this.loaded;
	}

	// Written whole, one write at a time, through a temporary file
	save() {
		this.saving = this.saving.then(async () => {
			const data = {settings: this.settings, originals: Object.fromEntries(this.originals)};
			const tmp = `${this.file}.tmp`;
			try {
				await fsp.mkdir(path.dirname(this.file), {recursive: true});
				await fsp.writeFile(tmp, JSON.stringify(data));
				await fsp.rename(tmp, this.file);
			} catch (e) {
				log.warn(`${this.file} is not written: ${e.message}`);
			}
		});
		return this.saving;
	}

	async free(fresh = false) {
		if (fresh || this.now() - this.freeAt > FREE_CACHE_MS) {
			const st = await this.statfs(this.paths.media);
			this.freeBytes = Number(st.bavail) * Number(st.bsize);
			this.freeAt = this.now();
		}
		return this.freeBytes;
	}

	// Throws NoSpaceError while less than FLOOR_BYTES is free
	async ensureRoom() {
		const free = await this.free();
		if (free < FLOOR_BYTES) {
			throw new NoSpaceError(free);
		}
	}

	async record(id, albumId, file) {
		await this.load();
		let bytes = 0;
		try {
			bytes = (await fsp.stat(file)).size;
		} catch (e) {
			return;
		}
		this.originals.set(String(id), {bytes, opened: this.now(), albumId: String(albumId || '')});
		this.freeAt = 0;
		await this.save();
	}

	async touch(id) {
		await this.load();
		const o = this.originals.get(String(id));
		if (o) {
			o.opened = this.now();
			await this.save();
		}
	}

	async forget(ids) {
		await this.load();
		let changed = false;
		for (const id of ids) {
			changed = this.originals.delete(String(id)) || changed;
		}
		if (changed) {
			this.freeAt = 0;
			await this.save();
		}
	}

	async setCap(capBytes) {
		await this.load();
		if (!validCap(capBytes)) {
			throw new Error(`capBytes: one of ${CAP_CHOICES.join(', ')}`);
		}
		this.settings.capBytes = capBytes;
		await this.save();
	}

	// What is counted against the cap and what is kept: {count, bytes} of each
	usage(kept) {
		const out = {originals: {count: 0, bytes: 0}, kept: {count: 0, bytes: 0}};
		for (const o of this.originals.values()) {
			const k = kept.has(o.albumId) ? out.kept : out.originals;
			k.count++;
			k.bytes += o.bytes;
		}
		return out;
	}

	// The cap as it is now: the setting, or the share of the space there is for them
	async cap(kept) {
		const used = this.usage(kept).originals.bytes;
		return Math.min(this.settings.capBytes, Math.floor((await this.free() + used) * SHARE_OF_FREE));
	}

	// Ids of the pictures to drop, those opened longest ago first, to be back under the cap;
	// never one of `spare`
	async over(kept, spare = new Set()) {
		await this.load();
		const cap = await this.cap(kept);
		const counted = [...this.originals].filter(([, o]) => !kept.has(o.albumId));
		let total = counted.reduce((s, [, o]) => s + o.bytes, 0);
		const drop = [];
		for (const [id, o] of counted.sort((a, b) => a[1].opened - b[1].opened)) {
			if (total <= cap) {
				break;
			}
			if (spare.has(id)) {
				continue;
			}
			drop.push(id);
			total -= o.bytes;
		}
		return drop;
	}
}

function validCap(v) {
	return CAP_CHOICES.includes(v);
}

// The bytes of the files below dir (not following links)
async function sizeOf(dir) {
	let total = 0;
	let names;
	try {
		names = await fsp.readdir(dir, {withFileTypes: true});
	} catch (e) {
		return 0;
	}
	for (const d of names) {
		const p = path.join(dir, d.name);
		if (d.isDirectory()) {
			total += await sizeOf(p);
		} else if (d.isFile()) {
			total += await fsp.stat(p).then(s => s.size, () => 0);
		}
	}
	return total;
}

module.exports = {Storage, NoSpaceError, sizeOf, DEFAULT_CAP_BYTES, CAP_CHOICES, FLOOR_BYTES, SHARE_OF_FREE};
