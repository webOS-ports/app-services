// Copyright (c) 2026 Herman van Hazendonk
// Derived from the contacts framework's Contact.js and
// properties/ContactPhoto.js, Copyright (c) 2009-2013 LG Electronics, Inc.,
// licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	A contact's photo cropped and saved, as the contacts framework's
	Contact.setCroppedContactPhoto and Contact.save did it.

	The new photo replaces the contact's photos of its type (their cached
	copies under /var are expired first) and goes first in the list. For a
	Palm Profile contact it is cropped by the image service into
	/media/internal/.contactphotos/, and that file is the photo's value as
	well as its local path; for any other the cropped copy goes into the
	file cache and the value stays the original's path.
*/

const {contactForMerge, entry, newEntry, isObject, single, CONTACT_ARRAYS, clone} = require('./records');

const FILECACHE = 'luna://com.palm.filecache';
const IMAGE = 'luna://com.webos.service.image';
const ACCOUNTS = 'luna://com.palm.service.accounts';
const SIM = 'luna://com.palm.service.contacts.sim';
const MEDIA_DIR = '/media/internal/.contactphotos/';

const LIST = {width: 50, height: 50, size: 8192};
const BIG_CACHED = {width: 96, height: 96, size: 150000};
const BIG_MEDIA = {width: 196, height: 196, size: 150000};
const FILETYPE = 'jpg';

function kindName(contact) {
	return String(contact._kind || '').split(':')[0];
}

function photosOf(contact) {
	const v = contact.photos;
	if (Array.isArray(v)) {
		return v.slice();
	}
	return v === undefined || v === null ? [] : [v];
}

function createPhotos({call, db, log = console, now = Date.now}) {
	// ContactPhoto.expire: errors are logged, not passed on.
	async function expire(pathName) {
		if (!pathName) {
			return;
		}
		try {
			await call(FILECACHE + '/ExpireCacheObject', {pathName});
		} catch (e) {
			log.error('Exception when expiring photo at \'' + pathName + '\': ' + ((e && e.message) || e));
		}
	}

	/*
		The image service's scale for a crop: the crop's width over the
		width the app suggested, or, for a crop with no suggestedXsize, its
		own scale (refetchPhoto's default crop, C10).
	*/
	function scaleOf(cropInfo, dims) {
		if (cropInfo.suggestedXsize === undefined && typeof cropInfo.scale === 'number') {
			return cropInfo.scale;
		}
		return dims.width / cropInfo.suggestedXsize;
	}

	// ContactPhoto.cropAndGetPath: a cropped copy in the file cache.
	async function cropToCache(fromPath, cropInfo, type) {
		const dims = type === 'type_big' ? BIG_CACHED : LIST;
		const parts = fromPath.split('/');
		const fileName = parts[parts.length - 1];
		const cache = await call.subscribe(FILECACHE + '/InsertCacheObject',
			{typeName: 'contactphoto', size: dims.size, fileName, subscribe: true});
		try {
			const toPath = cache.first.pathName;
			const params = {src: fromPath, dest: toPath, destType: FILETYPE};
			if (type === 'type_list') {
				params.destSizeW = dims.width;
				params.destSizeH = dims.height;
				await call(IMAGE + '/ezResize', params);
			} else {
				params.focusX = cropInfo.focusX;
				params.focusY = cropInfo.focusY;
				params.scale = scaleOf(cropInfo, dims);
				params.cropW = dims.width;
				params.cropH = dims.height;
				await call(IMAGE + '/convert', params);
			}
			return toPath;
		} finally {
			cache.cancel();
		}
	}

	// ContactPhoto.cropAndGetPathToMediaInternal: a cropped copy under /media/internal.
	async function cropToMedia(fromPath, cropInfo, type) {
		const dims = type === 'type_big' ? BIG_MEDIA : LIST;
		fromPath.split('/');
		const toPath = MEDIA_DIR + now() + '.' + FILETYPE;
		await call(IMAGE + '/convert', {src: fromPath, dest: toPath, destType: FILETYPE, focusX: cropInfo.focusX,
			focusY: cropInfo.focusY, scale: scaleOf(cropInfo, dims), cropW: dims.width, cropH: dims.height});
		return toPath;
	}

	/*
		Contact.setCroppedContactPhoto(contact, path, cropInfo, photoType):
		changes contact.photos (a contact record as read) and -> the path of
		the cropped photo.
	*/
	async function setCroppedPhoto(contact, path, cropInfo, photoType) {
		// Each photo as the framework read it: complete, a missing one as a photo of defaults.
		const photos = photosOf(contact).map(p => entry(p, 'ContactPhoto'));
		for (let i = photos.length - 1; i >= 0; i -= 1) {
			const photo = photos[i];
			if (photo.type === photoType) {
				const localPath = photo.localPath;
				if (localPath && typeof localPath === 'string' && localPath.indexOf('/var') === 0) {
					await expire(localPath);
				}
				photos.splice(i, 1);
			}
		}
		let template;
		try {
			const r = await call(ACCOUNTS + '/getAccountInfo', {accountId: single(contact.accountId)});
			template = r.result.templateId;
		} catch (e) {
			log.error(String((e && e.message) || e));
		}
		let cropped;
		if (template === 'com.palm.palmprofile') {
			cropped = await cropToMedia(path, cropInfo, photoType);
			path = cropped;
		} else {
			cropped = await cropToCache(path, cropInfo, photoType);
		}
		photos.splice(0, 0, newEntry('ContactPhoto', {value: path, localPath: cropped, type: photoType}));
		contact.photos = photos;
		return cropped;
	}

	// Contact.getDBObject, all of it, as a SIM contact was given to the SIM service.
	function fullRecord(contact) {
		const out = contactForMerge(contact);
		if (contact._rev !== undefined) {
			out._rev = contact._rev;
		}
		for (const k of Object.keys(CONTACT_ARRAYS)) {
			if (out[k] === undefined || out[k] === null) {
				out[k] = [];
			} else if (!Array.isArray(out[k])) {
				out[k] = [out[k]];
			}
		}
		for (const k of ['name', 'syncSource']) {
			if (!isObject(out[k])) {
				out[k] = {};
			}
		}
		// One-value fields as read: an object's value, and none for a falsy one.
		for (const k of ['accountId', 'anniversary', 'birthday', 'displayName', 'gender', 'nickname', 'note']) {
			out[k] = single(contact[k]);
		}
		if (!out._kind) {
			out._kind = 'com.palm.contact:1';
		}
		return out;
	}

	// Contact.save for a contact from db8: the SIM service saves a SIM contact; any other is merged.
	async function saveContact(contact) {
		if (kindName(contact) === 'com.palm.contact.sim') {
			await call(SIM + '/saveContact', {contact: fullRecord(contact)});
			return true;
		}
		const result = await db.merge([contactForMerge(contact)]);
		if (!result.length) {
			throw new Error('Contact save put - result length is zero');
		}
		return true;
	}

	return {setCroppedPhoto, saveContact, cropToCache, cropToMedia, expire, fullRecord};
}

module.exports = {createPhotos, clone, MEDIA_DIR};
