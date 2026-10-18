// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// What each photo source can do, as the Photos app asks for it with
// getAccountsCapability: {"local": {...}, "<templateId>": {...}}. A cloud
// account's serviceName is the bus service with its listAlbums, listPhotos,
// upload, deletePhoto, getPhotoComments and addPhotoComments.

// Everything a source may support; what one source does not is switched off below.
const BASE = Object.freeze({
	getAlbums: true,
	getPhotos: true,
	getCaptions: true,
	addCaption: true,
	updateCaption: false,
	getComments: true,
	updateComments: true,
	photoUpload: true,
	videoDownload: true,
	getUserInfo: true,
	videoUpload: false,
	createAlbum: false,
	deleteAlbum: false,
	deletePhoto: false,
	computeNumFiles: false
});

// The device itself
const LOCAL = Object.freeze(Object.assign({}, BASE, {
	getAlbums: false,
	getPhotos: false,
	getCaptions: false,
	addCaption: false,
	getComments: false,
	updateComments: false,
	videoDownload: false,
	getUserInfo: false,
	videoUpload: true,
	createAlbum: true,
	deleteAlbum: true,
	deletePhoto: true
}));

// The photo services webOS 3.0 shipped, each with its own service name.
const KNOWN = Object.freeze({
	'com.palm.facebook': {
		videoDownload: false,
		serviceName: 'com.palm.service.photos.facebook'
	},
	'com.palm.photobucket': {
		getComments: false,
		updateComments: false,
		getUserInfo: false,
		serviceName: 'com.palm.service.photos.photobucket'
	},
	'com.palm.snapfish': {
		getComments: false,
		updateComments: false,
		getUserInfo: false,
		addCaption: false,
		videoDownload: false,
		computeNumFiles: true,
		serviceName: 'com.palm.service.photos.snapfish'
	}
});

// Any other account with PHOTO.UPLOAD: the cloud connectors (Dropbox, Box,
// OneDrive, ...), whose service is the template id with "com.palm." made
// "com.palm.service." (com.palm.boxnet -> com.palm.service.boxnet), so a new
// connector needs nothing here. They list and delete photos; none has comments.
const CLOUD = Object.freeze({
	getComments: false,
	updateComments: false,
	getUserInfo: false,
	videoDownload: false,
	deletePhoto: true
});

function serviceNameFor(templateId) {
	return /^com\.palm\.[A-Za-z0-9_.-]+$/.test(templateId) ?
		templateId.replace(/^com\.palm\./, 'com.palm.service.') : null;
}

function capabilityFor(templateId) {
	if (templateId === 'local') {
		return Object.assign({}, LOCAL);
	}
	if (KNOWN[templateId]) {
		return Object.assign({}, BASE, KNOWN[templateId]);
	}
	const cap = Object.assign({}, BASE, CLOUD);
	const serviceName = serviceNameFor(templateId);
	if (serviceName) {
		cap.serviceName = serviceName;
	} else {
		// Nothing to call for its albums: shown as a source that has none.
		cap.getAlbums = false;
		cap.getPhotos = false;
		cap.photoUpload = false;
		cap.deletePhoto = false;
	}
	return cap;
}

// The whole map for a list of accounts ({templateId})
function capabilitiesFor(accounts) {
	const map = {local: capabilityFor('local')};
	for (const a of accounts) {
		if (a.templateId && !map[a.templateId]) {
			map[a.templateId] = capabilityFor(a.templateId);
		}
	}
	return map;
}

module.exports = {capabilityFor, capabilitiesFor, serviceNameFor};
