// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Thumbnails for the media entries that wait for one.
//
// An entry the service writes (a downloaded cloud photo, a copy uploaded to
// a cloud album) starts with appCacheComplete "unattempted"; the Photos app
// only shows entries whose appCacheComplete is true. This makes the grid
// thumbnail of each such entry and sets appCacheComplete true, or false when
// no thumbnail can be made, so it is not tried again. The files the media
// indexer finds on the device it thumbnails itself and marks true.
//
// The screen-size copy (appScreenNail) is made on demand, for
// generateImgForBigView.

const path = require('path');
const log = require('./log');
const {probe} = require('./imageinfo');
const {segment} = require('./files');

const GRID = {name: 'appGridThumbnail', width: 200, height: 200};
const SCREEN = {name: 'appScreenNail', width: 1024, height: 768};
const PAGE = 200;

class CacheGenerator {
	constructor({db, thumbnailer, paths, queue, isCancelled = () => false, keepAwake = null}) {
		this.db = db;
		this.thumbnailer = thumbnailer;
		this.paths = paths;
		this.queue = queue;
		this.isCancelled = isCancelled;
		this.keepAwake = keepAwake;
		this.running = null;
		this.again = false;
	}

	// Works through every waiting entry. While it runs, another call gets the
	// same promise, and the run goes on to whatever was added meanwhile.
	run() {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			const release = this.keepAwake ? await this.keepAwake('thumbnails').catch(() => null) : null;
			const start = Date.now();
			let count = 0;
			try {
				do {
					this.again = false;
					count += await this.pass();
				} while (this.again);
			} finally {
				if (release) {
					await release().catch(() => {});
				}
				this.running = null;
			}
			return {count, elapsedTime: Date.now() - start};
		})();
		return this.running;
	}

	// Each entry is tried once per pass, so one that cannot be written back
	// does not keep the pass going.
	async pass() {
		const tried = new Set();
		let count = 0;
		let page;
		for (;;) {
			const query = {
				from: 'com.palm.media.types:1',
				where: [{prop: 'appCacheComplete', op: '=', val: 'unattempted'}],
				orderBy: 'albumId',
				limit: PAGE
			};
			if (page) {
				query.page = page;
			}
			const r = await this.db.findPage(query);
			const fresh = r.results.filter(e => !tried.has(e._id));
			if (!fresh.length) {
				if (!r.next || !r.results.length) {
					return count;
				}
				page = r.next;        // only entries seen already on this page: on to the next
				continue;
			}
			page = undefined;         // the done ones left the result set; start over
			for (const entry of fresh) {
				tried.add(entry._id);
				if (this.isCancelled(entry)) {
					continue;
				}
				await this.queue.run(`grid-${entry._id}`, () => this.gridFor(entry));
				count++;
			}
		}
	}

	async gridFor(entry) {
		const merge = {_id: entry._id, appCacheComplete: true};
		if (entry.mediaType === 'image' || entry.mediaType === undefined) {
			const src = entry.path || entry.appOriginal;
			try {
				const made = await this.make(entry, src, GRID);
				merge[GRID.name] = made;
			} catch (e) {
				log.warn(`no thumbnail for ${entry._id}: ${e.message}`);
				merge.appCacheComplete = false;
			}
		}
		// Videos: the cloud services download none, and the indexer handles the device's own.
		try {
			await this.db.merge([merge]);
		} catch (e) {
			log.warn(`could not store the thumbnail of ${entry._id}: ${e.message}`);
		}
		return merge;
	}

	// The screen-size copy of one entry (generateImgForBigView)
	screenNail(id) {
		return this.queue.run(`screen-${id}`, async () => {
			const [entry] = await this.db.get([id]);
			if (!entry || entry.appScreenNail || entry.mediaType === 'video') {
				return entry && entry.appScreenNail;
			}
			const made = await this.make(entry, entry.path || entry.appOriginal, SCREEN);
			await this.db.merge([{_id: entry._id, appScreenNail: made}]);
			return made;
		});
	}

	async make(entry, src, kind) {
		if (!this.paths.inMedia(src)) {
			throw new Error(`source outside ${this.paths.media}: ${src}`);
		}
		const info = await probe(src);
		if (!info) {
			throw new Error(`not an image this service can read: ${src}`);
		}
		const base = path.basename(src, path.extname(src));
		const dst = path.join(this.paths.generated, `${kind.name}-${idPart(entry._id)}-${segment(base)}.jpg`);
		const dimensions = await this.thumbnailer.make(src, dst, kind.width, kind.height, info);
		return {path: dst, cached: true, dimensions};
	}
}

// A generated file is named <kind>-<entry id in hex>-<name>.jpg, so that
// cleanupCache can tell whose it is.
function idPart(id) {
	return Buffer.from(String(id)).toString('hex');
}

function ownerOf(fileName) {
	const m = /^(appGridThumbnail|appScreenNail)-([0-9a-f]+)-.*\.jpg$/.exec(fileName);
	if (!m || m[2].length % 2) {
		return null;
	}
	return {prop: m[1], id: Buffer.from(m[2], 'hex').toString()};
}

module.exports = {CacheGenerator, ownerOf, GRID, SCREEN};
