// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The bus methods, under the names and with the answers of the webOS 3.0
// service, the "facebook" ones included, which the Photos app still calls.
// Each takes the request payload and resolves with the response.

function methods(svc) {
	const lib = svc.library;

	const syncAll = async () => {
		try {
			await svc.syncAll(false);
			return {returnValue: true, msg: 'Syncing completed successfully'};
		} catch (e) {
			return {returnValue: false, msg: `Syncing failed:${e.message}`};
		}
	};
	const cacheThumbnails = async () => {
		try {
			const r = await svc.accounts.track('local', 'cacheNsync', () => svc.cache.run());
			return {returnValue: true, count: r.count, elapsedTime: r.elapsedTime};
		} catch (e) {
			return {returnValue: false, msg: e.message};
		}
	};
	const bigView = p => {
		if (!p || !p._id) {
			return {returnValue: false, msg: 'The photo entry (_id) is needed'};
		}
		svc.background(svc.cache.screenNail(p._id), `screen nail of ${p._id}`);
		return {returnValue: true, msg: 'Queuing request'};
	};
	const getComments = p => svc.getComments(p);
	const addComment = p => svc.addComment(p || {});
	const createAlbum = p => lib.createAlbum(p || {});
	const clearAccount = p => svc.onDelete(p || {});

	return {
		hello: p => ({returnValue: true, reply: `Hello ${(p && p.name) || ''}!`}),

		getAccountsCapability: async () => {
			await svc.start();
			return {returnValue: true, AccountsCapability: svc.capsMap};
		},

		remoteSyncAlbums: syncAll,
		facebookSyncAlbums: syncAll,

		syncSingleAccount: async p => {
			const accountId = p && p.accountId;
			await svc.start();
			if (!accountId || accountId === 'local' || !svc.accounts.has(accountId)) {
				return {returnValue: false, msg: 'account not found'};
			}
			try {
				await svc.syncOne(accountId);
				return {returnValue: true};
			} catch (e) {
				return {returnValue: false, error: e.message};
			}
		},

		onEnabled: p => svc.onEnabled(p || {}),
		onCredentialsChanged: p => svc.onCredentialsChanged(p || {}),
		onDelete: clearAccount,
		facebookClearCache: clearAccount,

		generateThumbnails: cacheThumbnails,
		cacheThumbnails,
		generateImgForBigView: bigView,
		facebookGenerateImgForBigView: bigView,

		getPhotoComments: getComments,
		facebookGetPhotoComments: getComments,
		addPhotoComments: addComment,
		facebookAddPhotoComments: addComment,

		createAlbum,
		addAlbum: createAlbum,
		// The app sends the album ids as the payload itself: [id, ...]
		deleteAlbum: p => lib.deleteAlbums(Array.isArray(p) ? p : ((p && (p.albums || p.ids)) || [])),
		renameAlbum: p => lib.renameAlbum(p || {}),
		addPhotos: p => lib.addPhotos(p || {}),
		deletePhotos: p => lib.deletePhotos(p || {}),

		cleanupCache: async () => ({returnValue: true, msg: 'Finished Delete', count: await svc.cleanupCache()}),
		rmLeftOvers: () => {
			svc.background(svc.removeLeftovers(), 'removing leftovers');
			return {returnValue: true, msg: 'Removing Left Over Albums'};
		}
	};
}

// The one subscription: the accounts and, as they change, their sync status
const SUBSCRIPTIONS = ['subscribeToAccountsInfo'];

module.exports = {methods, SUBSCRIPTIONS};
