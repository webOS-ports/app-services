// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// How much of the device the cloud photos take.
//
// The whole pictures that come down (an opened photo's, or every photo of a connector that
// has no preview of its own) are kept up to a cap: the user's setting (capBytes, 200 MB
// unless changed), one of CAP_CHOICES; of those, the ones offered are those that fit in the
// space there is for them (choices). Past the cap, those opened longest ago go back to their
// preview (the sync engine drops them). Nothing comes down while less than FLOOR_BYTES is
// free. The pictures of albums kept on the device count for neither. An album not opened
// for expireDays (30 unless changed, 0 for never) goes back to unopened (the sync engine).
//
// The photo entries are the media indexer's kind, which cannot be searched by when a photo
// was opened, so that is kept here, in .photosApp/.storage.json, with the settings:
// {settings: {capBytes, expireDays}, originals: {<_id>: {bytes, opened, albumId}}}.

const fsp = require('fs').promises;
const path = require('path');
const log = require('./log');

const MB = 1024 * 1024;
const DEFAULT_CAP_BYTES = 200 * MB;
const GB = 1024 * MB;
// 100, 200 and 500 MB, then doubling from 1 GB to 256 GB
const CAP_CHOICES = [100 * MB, 200 * MB, 500 * MB, ...Array.from({length: 9}, (_, i) => GB * 2 ** i)];
const FLOOR_BYTES = GB;
// Days an opened album is kept unopened before its photos go; 0: never
const DEFAULT_EXPIRE_DAYS = 30;
const EXPIRE_CHOICES = [7, 14, 30, 60, 90, 0];
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
		this.settings = {capBytes: DEFAULT_CAP_BYTES, expireDays: DEFAULT_EXPIRE_DAYS};
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
					const days = data.settings && data.settings.expireDays;
					if (EXPIRE_CHOICES.includes(days)) {
						this.settings.expireDays = days;
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

	async setExpire(days) {
		await this.load();
		if (!EXPIRE_CHOICES.includes(days)) {
			throw new Error(`expireDays: one of ${EXPIRE_CHOICES.join(', ')}`);
		}
		this.settings.expireDays = days;
		await this.save();
	}

	// The cap: the setting (the floor stops what comes down before the disk fills)
	async cap() {
		return this.settings.capBytes;
	}

	// The sizes to offer: those that fit in the space there is for the pictures (what is
	// free and what they take now, less the floor kept free); the smallest whatever there is,
	// and the one set, so that it can be shown
	async choices(kept) {
		const room = await this.free() + this.usage(kept).originals.bytes - FLOOR_BYTES;
		return CAP_CHOICES.filter((b, i) => i === 0 || b <= room || b === this.settings.capBytes);
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

module.exports = {Storage, NoSpaceError, sizeOf, DEFAULT_CAP_BYTES, CAP_CHOICES, FLOOR_BYTES,
	DEFAULT_EXPIRE_DAYS, EXPIRE_CHOICES};
