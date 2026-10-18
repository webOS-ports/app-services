// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Albums and photos: create, rename, delete, copy between albums and
// accounts. Local albums are directories on the device, with the media
// indexer keeping their entries; a cloud album is a directory under
// .photosApp that this service keeps in step with the account.

const fsp = require('fs').promises;
const path = require('path');
const log = require('./log');
const {callProvider} = require('./providers');
const {albumDirName, copyInto, exists, mkdirs, nowSeconds, removeDir, removeFile, segment} = require('./files');

const ALBUM_KIND = 'com.palm.media.image.album:1';
const MEDIA_KIND = 'com.palm.media.types:1';
const IMAGE_KIND = 'com.palm.media.image.file:1';
const VIDEO_KIND = 'com.palm.media.video.file:1';

// The cached copies an entry may have, besides the file itself
const CACHED = ['appScreenNail', 'appGridThumbnail', 'appStripThumbnail', 'appFullScreenImg'];

// renameAlbum's answers, as the Photos app shows them
const RENAME_ERRORS = {
	moveFailed: 'File System Failed to move album directory',
	nameExists: 'An Album with that name already exists',
	pathExists: 'Name Already in Use By File System',
	db: 'Error Connecting to DB',
	remote: 'Cannot rename a remote Account',
	reserved: 'Reserved Album'
};

// ".jpg" stays ".jpg"; anything odd is dropped
function safeExt(ext) {
	const e = String(ext || '').toLowerCase();
	return /^\.[a-z0-9]{1,8}$/.test(e) ? e : '';
}

function isCloud(entry) {
	return !!entry && !!entry.accountId && entry.accountId !== 'local' && entry.type !== 'local';
}

class Library {
	constructor({db, bus, paths, accounts, caps, cache}) {
		this.db = db;
		this.bus = bus;
		this.paths = paths;
		this.accounts = accounts;
		this.caps = caps;           // templateId -> capability
		this.cache = cache;
		this.reserved = [paths.media, path.join(paths.media, 'screencaptures'), 'camera://'];
	}

	// Removes a photo's files and entry. With remote, a cloud photo is first
	// deleted from its account, and kept here when that fails, so a photo is
	// never gone from the device while it is still in the cloud. Only a
	// delete the user asks for is remote: a sync removes what the cloud no
	// longer has, and removing an account only clears what was synced down.
	async removePhoto(photo, {remote = false, signal} = {}) {
		if (remote && isCloud(photo)) {
			const cap = this.caps(photo.type);
			const nested = photo[photo.type];
			if (cap && cap.deletePhoto && cap.serviceName && nested && nested.pid !== undefined) {
				await callProvider(this.bus, cap, 'deletePhoto', {accountId: photo.accountId, pid: nested.pid},
					{timeoutMs: 60000, signal});
			}
		}
		const files = [photo.path];
		for (const name of CACHED) {
			if (photo[name] && photo[name].path) {
				files.push(photo[name].path);
			}
		}
		for (const f of files) {
			if (f) {
				await removeFile(this.paths, f);
			}
		}
		await this.db.del([photo._id]);
	}

	// Removes an album's photos (here only), its directory and its entry.
	// A cloud album's directory goes with whatever is left in it; a local one
	// only when empty, and its entry goes even when the directory cannot.
	async removeAlbum(album) {
		const photos = await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: album._id}]});
		let failed = null;
		for (const photo of photos) {
			try {
				await this.removePhoto(photo);
			} catch (e) {
				failed = failed || e;
			}
		}
		if (album.path) {
			try {
				await removeDir(this.paths, album.path, {recursive: isCloud(album) && this.paths.inCache(album.path)});
			} catch (e) {
				log.warn(`album directory ${album.path} stays: ${e.message}`);
			}
		}
		// An album stays while any of its photos does: a removal that is
		// tried again (removeLeftovers) finds them through it.
		if (failed) {
			throw failed;
		}
		await this.db.del([album._id]);
	}

	// Counts a cloud album's photos and videos again
	async recount(albumId) {
		const where = [{prop: 'albumId', op: '=', val: albumId}];
		const total = {
			images: await this.db.count({from: IMAGE_KIND, where}),
			videos: await this.db.count({from: VIDEO_KIND, where})
		};
		await this.db.merge([{_id: albumId, total, modifiedTime: nowSeconds()}]);
		return total;
	}

	// createAlbum {name, accountId, specs}
	async createAlbum({name, accountId, specs}) {
		if (!name) {
			return {returnValue: false, msg: 'Need a valid album name'};
		}
		if (!accountId) {
			return {returnValue: false, msg: 'Need a valid account Id for the album'};
		}
		const dirName = albumDirName(name);
		if (!dirName) {
			return {returnValue: false, msg: 'Need a valid album name'};
		}
		if (accountId !== 'local') {
			const account = this.accounts.get(accountId);
			const cap = account && this.caps(account.templateId);
			if (!cap || !cap.createAlbum) {
				return {returnValue: false, msg: 'This account cannot create albums'};
			}
		}
		let albumPath = path.join(this.paths.media, dirName);
		const taken = await this.db.find({from: ALBUM_KIND, where: [{prop: 'path', op: '=', val: albumPath}]}, 1);
		if (taken.length || await exists(albumPath)) {
			albumPath = path.join(this.paths.media, `${Date.now()}-${dirName}`);
		}
		await mkdirs(albumPath);
		const st = await fsp.stat(albumPath);
		const album = {
			_kind: ALBUM_KIND,
			name,
			path: albumPath,
			total: {images: 0, videos: 0},
			modifiedTime: Math.floor(st.mtimeMs / 1000),
			showAlbum: true,
			searchKey: name
		};
		if (accountId === 'local') {
			album.type = 'local';
		} else {
			album.accountId = accountId;
		}
		const [albumId] = await this.db.put([album]);
		if (!specs || !specs.length) {
			return {returnValue: true, msg: `Added Album for ${name}`, albumId};
		}
		const copied = await this.addPhotos({specs, targetAlbum: albumId});
		if (!copied.returnValue) {
			return {returnValue: false, msg: `Failed to add some photos to the added album: ${copied.msg}`, albumId};
		}
		return {returnValue: true, msg: `Added Album for ${name} and added photos to it`, albumId};
	}

	// deleteAlbum [albumId, ...]: local albums only, with their photos
	async deleteAlbums(ids) {
		if (!Array.isArray(ids) || !ids.length) {
			return {returnValue: false, response: 'No albums specified to delete.'};
		}
		let albums;
		try {
			albums = (await this.db.get(ids)).filter(a => a && !a._del);
		} catch (e) {
			return {returnValue: false, response: 'Unable to query mojoDb for album entry details'};
		}
		let deleted = 0;
		let failed = false;
		for (const album of albums) {
			if (isCloud(album) || this.paths.inCache(album.path)) {
				continue;
			}
			try {
				await this.accounts.track('local', 'del', () => this.removeAlbum(album));
				deleted++;
			} catch (e) {
				log.warn(`album ${album._id} not deleted: ${e.message}`);
				failed = true;
			}
		}
		if (failed) {
			return {returnValue: false, response: 'Some albums failed to be deleted'};
		}
		return {returnValue: true, response: {numDeleted: deleted}};
	}

	// renameAlbum {albumId, newName}: local albums only
	async renameAlbum({albumId, newName}) {
		if (!albumId || !newName) {
			return {returnValue: false, msg: 'Invalid Album'};
		}
		const dirName = albumDirName(newName);
		if (!dirName) {
			return {returnValue: false, msg: RENAME_ERRORS.pathExists};
		}
		let album;
		try {
			const sameName = await this.db.find({from: ALBUM_KIND, where: [{prop: 'name', op: '=', val: newName}]});
			if (sameName.some(a => !isCloud(a) && a._id !== albumId)) {
				return {returnValue: false, msg: RENAME_ERRORS.nameExists};
			}
			[album] = await this.db.get([albumId]);
		} catch (e) {
			return {returnValue: false, msg: RENAME_ERRORS.db};
		}
		if (!album || album._del) {
			return {returnValue: false, msg: RENAME_ERRORS.db};
		}
		if (isCloud(album)) {
			return {returnValue: false, msg: RENAME_ERRORS.remote};
		}
		if (!album.path || this.reserved.includes(path.resolve(album.path)) || this.reserved.includes(album.path) ||
				!this.paths.inMedia(album.path) || this.paths.inCache(album.path)) {
			return {returnValue: false, msg: RENAME_ERRORS.reserved};
		}
		const newPath = path.join(path.dirname(album.path), dirName);
		if (!this.paths.inMedia(newPath) || await exists(newPath)) {
			return {returnValue: false, msg: RENAME_ERRORS.pathExists};
		}
		// The entry first, so the indexer finds the album at its new path
		// when the files show up there rather than making a second one.
		try {
			await this.db.merge([{_id: albumId, name: newName, path: newPath, searchKey: newName}]);
		} catch (e) {
			return {returnValue: false, msg: RENAME_ERRORS.db};
		}
		try {
			await fsp.rename(album.path, newPath);
		} catch (e) {
			await this.db.merge([{_id: albumId, name: album.name, path: album.path, searchKey: album.searchKey || album.name}])
				.catch(() => {});
			return {returnValue: false, msg: RENAME_ERRORS.moveFailed};
		}
		return {returnValue: true};
	}

	// The photos a spec names: the listed ones, or with exclude every photo
	// of sourceAlbum but the listed ones.
	async photosOf(spec) {
		const listed = Array.isArray(spec.photos) ? spec.photos : [];
		if (!spec.exclude) {
			return listed.length ? (await this.db.get(listed)).filter(p => p && !p._del) : [];
		}
		let albumId = spec.sourceAlbum;
		if (!albumId && listed.length) {
			const [first] = await this.db.get([listed[0]]);
			albumId = first && first.albumId;
		}
		if (!albumId) {
			return [];
		}
		const skip = new Set(listed);
		const all = await this.db.find({from: MEDIA_KIND, where: [{prop: 'albumId', op: '=', val: albumId}]});
		return all.filter(p => !skip.has(p._id));
	}

	// deletePhotos {specs: [{sourceAlbum, exclude, photos}]}
	async deletePhotos({specs}) {
		if (!Array.isArray(specs) || !specs.length) {
			return {returnValue: false, response: 'No specs for photos to delete'};
		}
		const touched = new Map();      // cloud albums to count again
		let failure = null;
		for (const spec of specs) {
			let photos;
			try {
				photos = await this.photosOf(spec);
			} catch (e) {
				failure = failure || e;
				continue;
			}
			for (const photo of photos) {
				const account = isCloud(photo) ? photo.accountId : 'local';
				try {
					await this.accounts.track(account, 'del', () => this.removePhoto(photo, {remote: true}));
					if (isCloud(photo) && photo.albumId) {
						touched.set(photo.albumId, true);
					}
				} catch (e) {
					log.warn(`photo ${photo._id} not deleted: ${e.message}`);
					failure = failure || e;
				}
			}
		}
		for (const albumId of touched.keys()) {
			await this.recount(albumId).catch(e => log.warn(`recount of ${albumId}: ${e.message}`));
		}
		if (failure) {
			return {returnValue: false, error: `Failed to delete all, ${failure.message}`};
		}
		return {returnValue: true, msg: 'Deleted all photos !'};
	}

	// addPhotos {targetAlbum, specs: [{sourceAlbum, exclude, photos, targetAlbum}]}
	async addPhotos({specs, targetAlbum}) {
		if (!Array.isArray(specs) || !specs.length) {
			return {returnValue: false, response: 'No specs to copy.'};
		}
		let failure = null;
		for (const spec of specs) {
			const albumId = spec.targetAlbum || targetAlbum;
			try {
				const [album] = albumId ? await this.db.get([albumId]) : [];
				if (!album || album._del) {
					throw new Error(`no album ${albumId}`);
				}
				const photos = await this.photosOf(spec);
				const account = isCloud(album) ? album.accountId : 'local';
				await this.accounts.track(account, 'copy', async () => {
					let error = null;
					for (const photo of photos) {
						try {
							await this.copyPhoto(photo, album);
						} catch (e) {
							log.warn(`photo ${photo._id} not copied to ${album.name}: ${e.message}`);
							error = error || e;
						}
					}
					if (isCloud(album)) {
						await this.recount(album._id).catch(() => {});
						this.cache.run().catch(() => {});
					}
					if (error) {
						throw error;
					}
				});
			} catch (e) {
				failure = failure || e;
			}
		}
		if (failure) {
			return {returnValue: false, msg: `Copy failed for some photos::${failure.message}`};
		}
		return {returnValue: true, msg: 'Successfully finished copying '};
	}

	// One photo into an album. Into a local album the file is copied, and
	// the indexer adds it; into a cloud album it is uploaded, and a copy is
	// kept in the album's directory with the id the cloud gave it, so the
	// next sync sees it is there already.
	async copyPhoto(photo, album) {
		const src = photo.appOriginal || photo.path;
		if (!src || !this.paths.inMedia(src)) {
			throw new Error(`no file for photo ${photo._id}`);
		}
		const name = path.basename(src);
		if (!isCloud(album)) {
			if (!album.path || !this.paths.inMedia(album.path) || this.paths.inCache(album.path)) {
				throw new Error(`album ${album._id} has no directory to copy into`);
			}
			await mkdirs(album.path);
			return copyInto(src, album.path, name);
		}
		const cap = this.caps(album.type);
		const video = photo.mediaType === 'video';
		if (!cap || !cap.serviceName || !cap.photoUpload || (video && !cap.videoUpload)) {
			throw new Error(`${album.type} does not take ${video ? 'videos' : 'photos'}`);
		}
		const r = await callProvider(this.bus, cap, 'upload', {accountId: album.accountId, albumId: album.aid, path: src},
			{timeoutMs: 300000});
		if (r.pid === undefined || r.pid === null) {
			throw new Error(`${cap.serviceName}/upload gave no id`);
		}
		await mkdirs(album.path);
		const ext = path.extname(name);
		const dst = await copyInto(src, album.path, segment(path.basename(name, ext)) + safeExt(ext));
		const entry = {
			_kind: video ? VIDEO_KIND : IMAGE_KIND,
			albumId: album._id,
			albumPath: album.path,
			type: album.type,
			accountId: album.accountId,
			mediaType: video ? 'video' : 'image',
			createdTime: nowSeconds(),
			appCacheComplete: 'unattempted',
			path: dst,
			appOriginal: dst
		};
		entry[album.type] = {pid: r.pid};
		try {
			await this.db.put([entry]);
		} catch (e) {
			await removeFile(this.paths, dst).catch(() => {});
			throw e;
		}
		return dst;
	}
}

module.exports = {Library, isCloud, safeExt, ALBUM_KIND, MEDIA_KIND, IMAGE_KIND, VIDEO_KIND, RENAME_ERRORS};
