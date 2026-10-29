// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Brings a cloud account's albums and photos down to the device.
//
// The account's service lists its albums (listAlbums) and each album's
// photos (listPhotos); this compares that with the entries it wrote last
// time, by album id (aid) and photo id (pid), removes what the cloud no
// longer has, renames and recounts what changed, and downloads what is new
// into .photosApp/<templateId>/<user>/<album>/. Photos download one after
// another, which keeps the device's connections and storage writes calm.
// When the account is done the thumbnails are made, and only then is its
// sync over, so the app's spinner turns until the photos can be shown.

const fsp = require('fs').promises;
const path = require('path');
const log = require('./log');
const {callProvider} = require('./providers');
const {probe} = require('./imageinfo');
const {exists, freeName, mkdirs, nowSeconds, removeFile, segment, shortHash} = require('./files');
const {ALBUM_KIND, MEDIA_KIND, IMAGE_KIND, VIDEO_KIND, safeExt} = require('./library');

const LIST_TIMEOUT_MS = 60000;
const LIST_ATTEMPTS = 3;

class SyncEngine {
	constructor({db, bus, paths, accounts, caps, library, cache, download}) {
		this.db = db;
		this.bus = bus;
		this.paths = paths;
		this.accounts = accounts;
		this.caps = caps;
		this.library = library;
		this.cache = cache;
		this.download = download;
		this.running = new Map();      // accountId -> {promise, controller}
	}

	isSyncing(accountId) {
		return this.running.has(accountId);
	}

	// Syncs an account; while it syncs, a second call gets the same promise.
	sync(accountId) {
		const current = this.running.get(accountId);
		if (current) {
			return current.promise;
		}
		const account = this.accounts.get(accountId);
		if (!account || accountId === 'local') {
			return Promise.reject(new Error(`no cloud account ${accountId}`));
		}
		if (!account.isEnabled) {
			return Promise.resolve({skipped: 'disabled'});
		}
		const controller = new AbortController();
		const promise = this.accounts.track(accountId, 'sync', () =>
			this.syncAccount(Object.assign({accountId}, account), controller.signal))
			.finally(() => this.running.delete(accountId));
		this.running.set(accountId, {promise, controller});
		return promise;
	}

	// Stops an account's sync; resolves once it has stopped.
	async cancel(accountId) {
		const current = this.running.get(accountId);
		if (!current) {
			return;
		}
		current.controller.abort(new Error('sync cancelled'));
		await current.promise.catch(() => {});
	}

	async syncAccount(account, signal) {
		const cap = this.caps(account.templateId);
		if (!cap || !cap.getAlbums || !cap.serviceName) {
			return {albums: 0};
		}
		const remote = await callProvider(this.bus, cap, 'listAlbums', {accountId: account.accountId},
			{timeoutMs: LIST_TIMEOUT_MS, attempts: LIST_ATTEMPTS, signal});
		signal.throwIfAborted();
		await mkdirs(this.paths.accountDir(account.templateId, account.username));

		const local = await this.db.find({from: ALBUM_KIND, where: [{prop: 'accountId', op: '=', val: account.accountId}]});
		const byAid = new Map(local.map(a => [String(a.aid), a]));
		const remoteAlbums = new Map();
		for (const r of remote.albums || []) {
			if (r && r.aid !== undefined && r.aid !== null && !remoteAlbums.has(String(r.aid))) {
				remoteAlbums.set(String(r.aid), r);
			}
		}

		// A connector with no photos lists one empty placeholder album (aid "": MEGA's and
		// HiDrive's "Camera Uploads"). The first upload into it makes a real folder with an aid
		// of its own, and deleting its last photo turns it back. To whoever is looking at it
		// that is the same album, so the entry takes the new aid instead of being removed and
		// added again under another _id.
		for (const album of local) {
			const aid = String(album.aid);
			if (remoteAlbums.has(aid)) {
				continue;
			}
			const twin = [...remoteAlbums.keys()].find(other => !byAid.has(other) && (aid === '' || other === '') &&
				(remoteAlbums.get(other).name || '') === (album.name || ''));
			if (twin !== undefined) {
				log.info(`album ${album.name} of ${account.templateId} is now aid "${twin}"`);
				await this.db.merge([{_id: album._id, aid: twin}]);
				byAid.delete(aid);
				album.aid = twin;
				byAid.set(twin, album);
			}
		}

		for (const album of local) {
			if (!remoteAlbums.has(String(album.aid))) {
				log.info(`album ${album.name} is gone from ${account.templateId}`);
				await this.library.removeAlbum(album);
			}
		}

		let failure = null;
		for (const [aid, r] of remoteAlbums) {
			signal.throwIfAborted();
			try {
				const known = byAid.get(aid);
				const album = known ? await this.updateAlbum(account, known, r, cap) : await this.addAlbum(account, r);
				await this.syncAlbum(account, cap, album, !known, signal);
			} catch (e) {
				if (signal.aborted) {
					throw signal.reason;
				}
				log.warn(`album ${r.name} of ${account.templateId}: ${e.message}`);
				failure = failure || e;
			}
		}

		signal.throwIfAborted();
		await this.cache.run();
		if (failure) {
			throw failure;
		}
		return {albums: remoteAlbums.size};
	}

	async addAlbum(account, r) {
		const dir = this.paths.cloudAlbumDir(account.templateId, account.username, r.aid, r.name);
		await mkdirs(dir);
		const album = {
			_kind: ALBUM_KIND,
			name: r.name || '',
			path: dir,
			total: total(r.size),
			type: account.templateId,
			aid: r.aid,
			accountId: account.accountId,
			showAlbum: true,
			searchKey: r.name || '',
			modifiedTime: nowSeconds()
		};
		try {
			[album._id] = await this.db.put([album]);
		} catch (e) {
			await fsp.rmdir(dir).catch(() => {});
			throw e;
		}
		return album;
	}

	async updateAlbum(account, album, r, cap) {
		const change = {};
		// Downloads go into the album's directory: never one outside .photosApp
		if (!this.paths.inCache(album.path)) {
			change.path = this.paths.cloudAlbumDir(account.templateId, account.username, album.aid, album.name);
		}
		await mkdirs(change.path || album.path);
		if (r.name !== undefined && album.name !== r.name) {
			change.name = r.name;
			change.searchKey = r.name;
		}
		if (album.showAlbum !== true) {
			change.showAlbum = true;
		}
		if (!cap.computeNumFiles && r.size) {
			const t = total(r.size);
			if (!album.total || album.total.images !== t.images || album.total.videos !== t.videos) {
				change.total = t;
			}
		}
		if (Object.keys(change).length) {
			change.modifiedTime = nowSeconds();
			await this.db.merge([Object.assign({_id: album._id}, change)]);
		}
		return Object.assign({}, album, change);
	}

	async syncAlbum(account, cap, album, isNew, signal) {
		if (!cap.getPhotos) {
			return;
		}
		const tpl = account.templateId;
		const local = isNew ? [] :
			await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: album._id}]});
		const have = new Map();
		for (const entry of local) {
			const nested = entry[tpl];
			if (nested && nested.pid !== undefined) {
				have.set(String(nested.pid), entry);
			}
		}

		// `have`: what is never fetched again, so a provider that has to make a copy of each
		// photo first (MEGA decrypts them) need not make one of these. Others ignore it.
		const params = {accountId: account.accountId, aid: album.aid, have: [...have.keys()]};
		if (account.templateId === 'com.palm.snapfish') {
			params.albumId = album.aid;       // what that service reads
		}
		const listed = await callProvider(this.bus, cap, 'listPhotos', params,
			{timeoutMs: LIST_TIMEOUT_MS, attempts: LIST_ATTEMPTS, signal});
		const remote = new Map();
		for (const p of listed.photos || []) {
			if (p && p.pid !== undefined && p.pid !== null && !remote.has(String(p.pid))) {
				remote.set(String(p.pid), p);
			}
		}

		if (cap.computeNumFiles) {
			let videos = 0;
			if (cap.videoDownload) {
				for (const p of remote.values()) {
					videos += p.type === 'video' ? 1 : 0;
				}
			}
			const t = {images: remote.size - videos, videos};
			if (!album.total || album.total.images !== t.images || album.total.videos !== t.videos) {
				await this.db.merge([{_id: album._id, total: t}]);
			}
		}

		for (const [pid, entry] of have) {
			if (!remote.has(pid)) {
				await this.library.removePhoto(entry);
			}
		}
		const captions = [];
		for (const [pid, p] of remote) {
			const entry = have.get(pid);
			if (entry && p.caption !== undefined && entry.caption !== p.caption) {
				captions.push({_id: entry._id, caption: p.caption});
			}
		}
		await this.db.merge(captions);

		let failure = null;
		for (const [pid, p] of remote) {
			if (have.has(pid)) {
				continue;
			}
			signal.throwIfAborted();
			if (p.type === 'video' && !cap.videoDownload) {
				continue;
			}
			try {
				await this.fetchPhoto(account, album, p, signal);
			} catch (e) {
				if (signal.aborted) {
					throw signal.reason;
				}
				log.warn(`photo ${pid} of ${album.name}: ${e.message}`);
				failure = failure || e;
			}
		}
		if (this.paths.inCache(album.path)) {
			const swept = await this.sweep(album);
			if (swept) {
				log.info(`${swept} file(s) without an entry removed from ${album.path}`);
			}
		}
		if (failure) {
			throw failure;
		}
	}

	// Downloads one photo and writes its entry
	async fetchPhoto(account, album, p, signal) {
		const url = p.src_big || p.src_small;
		if (!url) {
			throw new Error('no URL to download from');
		}
		const video = p.type === 'video';
		const file = await this.targetFor(album, p, url);
		// A provider's temporary copy (temporary:true) is removed once it is copied
		await this.download(url, file, {signal, localRoot: this.paths.media, removeSource: p.temporary === true});

		let finalPath = file;
		let readable = true;
		if (!video) {
			const info = await probe(file);
			readable = !!info;
			if (info && path.extname(file).toLowerCase() !== `.${info.ext}` &&
					!(info.ext === 'jpg' && path.extname(file).toLowerCase() === '.jpeg')) {
				let named = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.${info.ext}`);
				if (await exists(named) && await this.inUse(named)) {
					named = await freeName(path.dirname(file), path.basename(named));
				}
				await fsp.rename(file, named);
				finalPath = named;
			}
		}

		const nested = {pid: p.pid};
		if (p.caption !== undefined) {
			nested.caption = p.caption;
		}
		if (p.fileName !== undefined) {
			nested.fileName = p.fileName;
		}
		// The links the services hand out carry tokens; none is kept.
		const entry = {
			_kind: video ? VIDEO_KIND : IMAGE_KIND,
			albumId: album._id,
			mediaType: video ? 'video' : 'image',
			accountId: account.accountId,
			albumPath: album.path,
			type: account.templateId,
			appCacheComplete: readable ? 'unattempted' : false,
			path: finalPath,
			appOriginal: finalPath,
			createdTime: typeof p.createdTime === 'number' ? p.createdTime : nowSeconds()
		};
		if (p.caption !== undefined) {
			entry.caption = p.caption;
		}
		entry[account.templateId] = nested;
		try {
			await this.db.put([entry]);
		} catch (e) {
			await removeFile(this.paths, finalPath).catch(() => {});
			throw e;
		}
	}

	// Where a photo goes: the name the service gives (fileName), else the
	// last part of the URL. A name another photo has already gets the id's hash.
	async targetFor(album, p, url) {
		let name = p.fileName;
		if (!name) {
			try {
				name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
			} catch (e) {
				name = '';
			}
		}
		const ext = safeExt(path.extname(name));
		const base = segment(path.basename(name, path.extname(name)) || `photo-${shortHash(p.pid)}`);
		let file = path.join(album.path, base + ext);
		if (await exists(file) && await this.inUse(file)) {
			file = path.join(album.path, `${base}-${shortHash(p.pid)}${ext}`);
		}
		return file;
	}

	// Whether an entry has this file; one left without (its entry lost) is taken over
	async inUse(file) {
		return (await this.db.find({from: MEDIA_KIND, where: [{prop: 'path', op: '=', val: file}]}, 1)).length > 0;
	}

	// Files in the album's directory that no entry has: what a download left
	// when its entry could not be written, or entries lost to something else.
	// The directory is this service's alone.
	async sweep(album) {
		let names;
		try {
			names = await fsp.readdir(album.path);
		} catch (e) {
			return 0;
		}
		const entries = await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: album._id}]});
		const kept = new Set(entries.map(e => e.path));
		let removed = 0;
		for (const name of names) {
			const file = path.join(album.path, name);
			if (kept.has(file)) {
				continue;
			}
			const st = await fsp.lstat(file).catch(() => null);
			// A download still running writes to a .part file
			if (!st || !st.isFile() || (name.endsWith('.part') && Date.now() - st.mtimeMs < 3600 * 1000)) {
				continue;
			}
			removed += (await removeFile(this.paths, file)) ? 1 : 0;
		}
		return removed;
	}
}

function total(size) {
	return {
		images: size && Number.isFinite(size.images) ? size.images : 0,
		videos: size && Number.isFinite(size.videos) ? size.videos : 0
	};
}

module.exports = {SyncEngine};
