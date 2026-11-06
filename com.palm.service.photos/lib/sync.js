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
//
// An album may be in another (parentAid): its entry gets that album's _id as
// parentId, and the app shows it inside that one.
//
// Nothing more comes down than is looked at. A sync brings the albums only;
// an album's photos are listed once it has been opened (syncAlbum, which the
// app calls when it shows the album: the entry is then `listed`), and from
// then on with every sync. Of each photo only its preview comes down where
// the connector has one (src_small, when it is not the same link as
// src_big): the entry is `original: "remote"`, its path the preview's file.
// The full picture comes down when it is wanted (original(): the picture is
// opened, shared, printed), from a fresh link, as the links are kept nowhere.

const fsp = require('fs').promises;
const path = require('path');
const log = require('./log');
const {callProvider} = require('./providers');
const {probe} = require('./imageinfo');
const {exists, freeName, mkdirs, nowSeconds, removeFile, segment, shortHash} = require('./files');
const {ALBUM_KIND, MEDIA_KIND, IMAGE_KIND, VIDEO_KIND, safeExt} = require('./library');

const LIST_TIMEOUT_MS = 60000;
const LIST_ATTEMPTS = 3;
const REMOTE = 'remote';

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
		this.albums = new Map();       // album _id -> the promise of its photos' sync
		this.originals = new Map();    // photo _id -> the promise of its full picture
		this.work = new Map();         // accountId -> Set of the AbortControllers of syncAlbum and original
		this.writing = new Set();      // files written whose entry has not caught up yet: the sweep leaves them
		this.noGetPhoto = new Set();   // services that have no getPhoto
	}

	isSyncing(accountId) {
		return this.running.has(accountId);
	}

	// True while an album or a full picture is being fetched
	get busy() {
		return this.albums.size > 0 || this.originals.size > 0;
	}

	// fn(signal) as work of the account that cancel() stops
	async forAccount(accountId, fn) {
		const controller = new AbortController();
		if (!this.work.has(accountId)) {
			this.work.set(accountId, new Set());
		}
		const set = this.work.get(accountId);
		const entry = {controller, promise: null};
		set.add(entry);
		try {
			entry.promise = fn(controller.signal);
			return await entry.promise;
		} finally {
			set.delete(entry);
			if (!set.size) {
				this.work.delete(accountId);
			}
		}
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

	// Stops an account's sync, and its albums and pictures being fetched; resolves once they have stopped.
	async cancel(accountId) {
		const waits = [];
		const current = this.running.get(accountId);
		if (current) {
			current.controller.abort(new Error('sync cancelled'));
			waits.push(current.promise);
		}
		for (const entry of this.work.get(accountId) || []) {
			entry.controller.abort(new Error('sync cancelled'));
			if (entry.promise) {
				waits.push(entry.promise);
			}
		}
		await Promise.all(waits.map(p => p.catch(() => {})));
	}

	// syncAlbum {albumId}: the album's photos, listed and their previews brought down, now and
	// with every sync from then on. Resolves when its thumbnails are made.
	async openAlbum(albumId) {
		const [album] = albumId ? await this.db.get([albumId]) : [];
		if (!album || album._del || album._kind !== ALBUM_KIND || !album.accountId || album.accountId === 'local') {
			throw new Error(`no cloud album ${albumId}`);
		}
		const account = this.accounts.get(album.accountId);
		if (!account) {
			throw new Error(`no cloud account ${album.accountId}`);
		}
		if (!account.isEnabled) {
			return {skipped: 'disabled'};
		}
		const cap = this.caps(account.templateId);
		if (!cap || !cap.getPhotos || !cap.serviceName) {
			return {photos: 0};
		}
		const acc = Object.assign({accountId: album.accountId}, account);
		return this.accounts.track(album.accountId, 'sync', () => this.forAccount(album.accountId, async signal => {
			if (album.listed !== true) {
				await this.db.merge([{_id: album._id, listed: true}]);
				album.listed = true;
			}
			if (!this.paths.inCache(album.path)) {
				return {photos: 0};
			}
			await this.photosOf(acc, cap, album, false, signal);
			signal.throwIfAborted();
			await this.cache.run();
			return {photos: (await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: album._id}]})).length};
		}));
	}

	// An album's photos: one sync of them at a time, whoever asks
	photosOf(account, cap, album, isNew, signal) {
		const current = this.albums.get(album._id);
		if (current) {
			return current;
		}
		const promise = this.syncAlbum(account, cap, album, isNew, signal)
			.finally(() => this.albums.delete(album._id));
		this.albums.set(album._id, promise);
		return promise;
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

		// Every album first, so that the sub-albums can be linked to theirs before the photos
		// come down: the app shows the tree while they do.
		let failure = null;
		const synced = new Map();      // aid -> {album, isNew}
		for (const [aid, r] of remoteAlbums) {
			signal.throwIfAborted();
			try {
				const known = byAid.get(aid);
				const album = known ? await this.updateAlbum(account, known, r, cap) : await this.addAlbum(account, r);
				synced.set(aid, {album, isNew: !known});
			} catch (e) {
				if (signal.aborted) {
					throw signal.reason;
				}
				log.warn(`album ${r.name} of ${account.templateId}: ${e.message}`);
				failure = failure || e;
			}
		}
		await this.linkParents(remoteAlbums, synced);

		for (const {album, isNew} of synced.values()) {
			signal.throwIfAborted();
			if (album.listed !== true) {
				continue;      // not opened yet: its photos are listed when it is
			}
			try {
				await this.photosOf(account, cap, album, isNew, signal);
			} catch (e) {
				if (signal.aborted) {
					throw signal.reason;
				}
				log.warn(`album ${album.name} of ${account.templateId}: ${e.message}`);
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

	// Sub-albums: a connector may give an album the aid of the one it is in (parentAid). The
	// entry keeps that, and the parent's _id as parentId, which is what the app reads. A
	// parent that is not listed or not synced, or a chain of parents that comes back on
	// itself, makes it a top-level album: parentId "".
	async linkParents(remoteAlbums, synced) {
		const parentOf = aid => {
			const r = remoteAlbums.get(aid);
			const p = r ? parentAidOf(r) : null;
			return p !== null && synced.has(p) ? p : null;
		};
		const changes = [];
		for (const [aid, {album}] of synced) {
			let parent = parentOf(aid);
			// Up the chain: back at this album means a loop
			const seen = new Set([aid]);
			for (let p = parent; p !== null; p = parentOf(p)) {
				if (seen.has(p)) {
					log.warn(`album ${album.name}: its parents make a loop, shown at the top`);
					parent = null;
					break;
				}
				seen.add(p);
			}
			const parentId = parent !== null ? synced.get(parent).album._id : '';
			const parentAid = parent !== null ? parent : '';
			if ((album.parentId || '') !== parentId || (album.parentAid || '') !== parentAid) {
				changes.push({_id: album._id, parentId, parentAid});
				album.parentId = parentId;
				album.parentAid = parentAid;
			}
		}
		await this.db.merge(changes);
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
			listed: false,
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
		// An album synced before albums were listed only when opened: listed when it has photos here
		if (album.listed !== true && album.listed !== false) {
			change.listed = (await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: album._id}]}, 1)).length > 0;
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
		const headers = downloadHeaders(listed.headers);
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
				await this.fetchPhoto(account, album, p, signal, headers);
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

	// Downloads one photo, or its preview, and writes its entry
	async fetchPhoto(account, album, p, signal, headers) {
		const video = p.type === 'video';
		// The preview where there is one of its own; the picture itself comes down when it is wanted
		const preview = !video && isLink(p.src_small) && isLink(p.src_big) && p.src_small !== p.src_big;
		const url = preview ? p.src_small : (p.src_big || p.src_small);
		if (!url) {
			throw new Error('no URL to download from');
		}
		const file = await this.targetFor(album, p, url);
		// A provider's temporary copy (temporary:true) is removed once it is copied
		const opts = {signal, localRoot: this.paths.media, removeSource: p.temporary === true};
		if (headers) {
			opts.headers = headers;
		}
		await this.download(url, file, opts);

		let finalPath = file;
		let readable = true;
		if (!video) {
			const info = await probe(file);
			readable = !!info;
			finalPath = await this.namedFor(file, info);
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
			createdTime: typeof p.createdTime === 'number' ? p.createdTime : nowSeconds()
		};
		if (preview) {
			entry.original = REMOTE;
		} else {
			entry.appOriginal = finalPath;
		}
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

	// The file named for what it turned out to be (its extension); the name it ends up with.
	async namedFor(file, info) {
		if (!info || path.extname(file).toLowerCase() === `.${info.ext}` ||
				(info.ext === 'jpg' && path.extname(file).toLowerCase() === '.jpeg')) {
			return file;
		}
		let named = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.${info.ext}`);
		if (await exists(named) && await this.inUse(named)) {
			named = await freeName(path.dirname(file), path.basename(named));
		}
		await fsp.rename(file, named);
		return named;
	}

	// The full picture of a photo of which only the preview came down (original "remote"):
	// downloaded next to it, which it then replaces. Resolves with the entry's path, at once
	// for a photo that is here whole. One download per photo, whoever asks.
	original(id) {
		const current = this.originals.get(id);
		if (current) {
			return current;
		}
		const promise = this.fetchOriginal(id).finally(() => this.originals.delete(id));
		this.originals.set(id, promise);
		return promise;
	}

	async fetchOriginal(id) {
		const [entry] = id ? await this.db.get([id]) : [];
		if (!entry || entry._del || !entry.path) {
			throw new Error(`no photo ${id}`);
		}
		if (entry.original !== REMOTE) {
			return entry.path;
		}
		const account = this.accounts.get(entry.accountId);
		const cap = account && account.isEnabled ? this.caps(account.templateId) : null;
		const nested = entry[entry.type];
		const [album] = entry.albumId ? await this.db.get([entry.albumId]) : [];
		if (!cap || !cap.serviceName || !nested || nested.pid === undefined || !album || album._del ||
				!this.paths.inCache(album.path)) {
			throw new Error(`the picture of ${id} cannot be fetched: its account or album is gone`);
		}
		return this.forAccount(entry.accountId, async signal => {
			const link = await this.linkFor(Object.assign({accountId: entry.accountId}, account), cap, album, nested.pid, signal);
			const file = await this.targetFor(album, {pid: nested.pid, fileName: link.fileName || nested.fileName}, link.url);
			const opts = {signal, localRoot: this.paths.media, removeSource: link.temporary === true};
			if (link.headers) {
				opts.headers = link.headers;
			}
			this.writing.add(file);
			let finalPath = file;
			try {
				await this.download(link.url, file, opts);
				finalPath = await this.namedFor(file, await probe(file));
				this.writing.add(finalPath);
				signal.throwIfAborted();
				await this.db.merge([{_id: entry._id, path: finalPath, appOriginal: finalPath, original: 'local'}]);
			} catch (e) {
				await removeFile(this.paths, finalPath).catch(() => {});
				throw e;
			} finally {
				this.writing.delete(file);
				this.writing.delete(finalPath);
			}
			if (entry.path !== finalPath) {
				await removeFile(this.paths, entry.path).catch(e => log.warn(`the preview of ${id} stays: ${e.message}`));
			}
			return finalPath;
		});
	}

	// A fresh link to a photo's full picture: the connector's getPhoto {accountId, aid, pid}
	// -> {src_big, headers}, or, where it has none, the album listed again.
	async linkFor(account, cap, album, pid, signal) {
		if (!this.noGetPhoto.has(cap.serviceName)) {
			try {
				const r = await callProvider(this.bus, cap, 'getPhoto', {accountId: account.accountId, aid: album.aid, pid},
					{timeoutMs: LIST_TIMEOUT_MS, signal});
				if (isLink(r.src_big)) {
					return {url: r.src_big, headers: downloadHeaders(r.headers), fileName: r.fileName,
						temporary: r.temporary === true};
				}
				log.warn(`${cap.serviceName}/getPhoto gave no src_big; listing the album instead`);
			} catch (e) {
				if (signal.aborted) {
					throw signal.reason;
				}
				if (isUnknownMethod(e)) {
					this.noGetPhoto.add(cap.serviceName);
				} else {
					log.warn(`${cap.serviceName}/getPhoto: ${e.message}; listing the album instead`);
				}
			}
		}
		const others = await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: album._id}]});
		const tpl = account.templateId;
		const have = others.map(o => o[tpl] && o[tpl].pid).filter(x => x !== undefined && String(x) !== String(pid)).map(String);
		const params = {accountId: account.accountId, aid: album.aid, have};
		if (tpl === 'com.palm.snapfish') {
			params.albumId = album.aid;
		}
		const listed = await callProvider(this.bus, cap, 'listPhotos', params,
			{timeoutMs: LIST_TIMEOUT_MS, attempts: LIST_ATTEMPTS, signal});
		const p = (listed.photos || []).find(x => x && x.pid !== undefined && x.pid !== null && String(x.pid) === String(pid));
		if (!p || !isLink(p.src_big)) {
			throw new Error(`photo ${pid} is not in ${album.name} any more`);
		}
		return {url: p.src_big, headers: downloadHeaders(listed.headers), fileName: p.fileName, temporary: p.temporary === true};
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
		const kept = new Set(entries.map(e => e.path).concat([...this.writing]));
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

const isLink = v => typeof v === 'string' && v !== '';

// A call that will not work however often it is tried: the connector has no such method (one
// from before getPhoto), or its ACG does not let it be called
function isUnknownMethod(e) {
	const r = e && e.response;
	const text = String((r && r.errorText) || (e && e.message) || '');
	return /unknown method|no such method|method not found|not permitted|denied method/i.test(text);
}

// A listed album's parentAid, as the aids are keyed: a string or a number, else none.
function parentAidOf(r) {
	const p = r.parentAid;
	return (typeof p === 'string' && p !== '') || Number.isFinite(p) ? String(p) : null;
}

// What a connector whose links need a session (PiGallery2's cookie) asks to be sent with
// each of the listing's downloads: only Cookie and Authorization, single-line strings.
// Never kept, never logged. Anything else in it, or none at all: no headers.
const DOWNLOAD_HEADERS = ['cookie', 'authorization'];
const MAX_HEADER_LENGTH = 8192;

function downloadHeaders(given) {
	if (!given || typeof given !== 'object' || Array.isArray(given)) {
		return null;
	}
	const out = {};
	for (const [name, value] of Object.entries(given)) {
		if (!DOWNLOAD_HEADERS.includes(name.toLowerCase()) || typeof value !== 'string' ||
				!value || value.length > MAX_HEADER_LENGTH || /[\r\n\0]/.test(value)) {
			log.warn(`listPhotos asked for a download header that is not taken: ${name}`);
			return null;
		}
		out[name] = value;
	}
	return Object.keys(out).length ? out : null;
}

function total(size) {
	return {
		images: size && Number.isFinite(size.images) ? size.images : 0,
		videos: size && Number.isFinite(size.videos) ? size.videos : 0
	};
}

module.exports = {SyncEngine, downloadHeaders};
