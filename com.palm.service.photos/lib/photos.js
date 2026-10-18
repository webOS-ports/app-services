// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// com.palm.service.photos: everything behind the bus methods, with the bus
// handed in, so the unit tests run it against a fake one.

const fsp = require('fs').promises;
const path = require('path');
const log = require('./log');
const {Db} = require('./db');
const {AccountsManager} = require('./accounts');
const {capabilitiesFor, capabilityFor} = require('./capabilities');
const {SerialQueue} = require('./queue');
const {CacheGenerator, ownerOf} = require('./cache');
const {Library, isCloud, ALBUM_KIND} = require('./library');
const {SyncEngine} = require('./sync');
const {callProvider} = require('./providers');
const {removeDir, removeFile} = require('./files');
const {download: defaultDownload} = require('./download');

const SERVICE = 'com.palm.service.photos';
const ACCOUNT_QUERY = {
	from: 'com.palm.account:1',
	where: [
		{prop: 'capabilityProviders.capability', op: '=', val: 'PHOTO.UPLOAD'},
		{prop: 'beingDeleted', op: '=', val: false}
	]
};
const SYNCSTATE_KIND = 'com.palm.account.syncstate:1';

class PhotosService {
	constructor({bus, paths, thumbnailer, download = defaultDownload}) {
		this.bus = bus;
		this.paths = paths;
		this.db = new Db(bus);
		this.tempdb = new Db(bus, 'com.palm.tempdb');
		this.accounts = new AccountsManager();
		this.capsMap = capabilitiesFor([]);
		this.caps = templateId => this.capsMap[templateId] || capabilityFor(templateId);
		this.queue = new SerialQueue();
		this.deleting = new Set();         // accounts being removed
		this.subscribers = new Set();
		this.leftovers = null;
		this.accountsWatch = null;
		this.stopped = false;

		this.cache = new CacheGenerator({
			db: this.db, thumbnailer, paths, queue: this.queue,
			isCancelled: entry => this.deleting.has(entry.accountId),
			keepAwake: name => this.keepAwake(name)
		});
		this.library = new Library({
			db: this.db, bus, paths, accounts: this.accounts, caps: this.caps, cache: this.cache
		});
		this.syncer = new SyncEngine({
			db: this.db, bus, paths, accounts: this.accounts, caps: this.caps,
			library: this.library, cache: this.cache, download
		});
		this.accounts.on('changed', payload => {
			for (const notify of this.subscribers) {
				notify(payload);
			}
		});
		this.ready = null;
	}

	// Reads the photo accounts and keeps watching them
	start() {
		if (!this.ready) {
			this.ready = this.watchAccounts().catch(e => {
				log.error(`reading the photo accounts: ${e.message}`);
			});
		}
		return this.ready;
	}

	stop() {
		this.stopped = true;
		if (this.accountsWatch) {
			this.accountsWatch.cancel();
			this.accountsWatch = null;
		}
	}

	// True while anything is going on that the process should stay up for
	get busy() {
		return this.subscribers.size > 0 || this.syncer.running.size > 0 || !!this.cache.running ||
			this.queue.busy || this.deleting.size > 0 || !!this.leftovers;
	}

	// db8 answers a watched find once with the results and once more with
	// "fired" when they change; then it is asked again.
	watchAccounts() {
		return new Promise((resolve, reject) => {
			let first = true;
			const sub = this.bus.subscribe('luna://com.palm.db/find', {query: ACCOUNT_QUERY, watch: true}, payload => {
				if (payload.returnValue === false) {
					sub.cancel();
					if (first) {
						reject(new Error(payload.errorText || 'find failed'));
					}
					return;
				}
				if (payload.fired) {
					sub.cancel();
					if (!this.stopped) {
						this.watchAccounts().catch(e => log.error(`watching the photo accounts: ${e.message}`));
					}
					return;
				}
				if (Array.isArray(payload.results)) {
					this.applyAccounts(payload.results);
					if (first) {
						first = false;
						resolve();
					}
				}
			});
			this.accountsWatch = sub;
		});
	}

	// The accounts with PHOTO.UPLOAD on. One that drops out of the list had
	// the capability turned off, or is being deleted; it stays known, as off.
	applyAccounts(results) {
		const present = new Set();
		const list = [];
		for (const a of results) {
			present.add(a._id);
			list.push({accountId: a._id, username: a.username, templateId: a.templateId, isEnabled: true});
		}
		this.accounts.upsert(list);
		for (const a of this.accounts.remote()) {
			if (!present.has(a.accountId) && a.isEnabled) {
				this.accounts.setEnabled(a.accountId, false);
			}
		}
		this.capsMap = capabilitiesFor(this.accounts.remote());
	}

	subscribe(notify) {
		this.subscribers.add(notify);
		return () => this.subscribers.delete(notify);
	}

	// A power activity, so the device does not sleep in the middle of making
	// thumbnails; resolves with the function that ends it.
	async keepAwake(name) {
		const activity = {
			name: `${SERVICE}.${name}`,
			description: 'Photos: making thumbnails',
			type: {foreground: true, power: true, powerDebounce: true}
		};
		const r = await this.bus.call('luna://com.palm.activitymanager/create', {activity, start: true, replace: true},
			{timeoutMs: 10000});
		if (!r || !r.returnValue || !r.activityId) {
			return null;
		}
		return () => this.bus.call('luna://com.palm.activitymanager/complete', {activityId: r.activityId},
			{timeoutMs: 10000});
	}

	// ---- syncing -----------------------------------------------------------

	// Every enabled cloud account; with local also the device's own media
	// (their thumbnails). Removes what deleted accounts left first.
	async syncAll(local) {
		await this.start();
		await this.removeLeftovers();
		const jobs = [];
		if (local) {
			jobs.push(this.accounts.track('local', 'sync', () => this.cache.run()));
		}
		for (const a of this.accounts.remote()) {
			if (a.isEnabled && !this.deleting.has(a.accountId)) {
				jobs.push(this.syncer.sync(a.accountId));
			}
		}
		const results = await Promise.allSettled(jobs);
		const failed = results.find(r => r.status === 'rejected');
		if (failed) {
			throw failed.reason;
		}
	}

	// One account, with the "syncing" state the accounts app shows meanwhile
	async syncOne(accountId) {
		await this.start();
		await this.removeLeftovers();
		let stateId = null;
		try {
			const ids = await this.tempdb.put([{
				_kind: SYNCSTATE_KIND,
				accountId,
				capabilityProvider: SERVICE,
				syncState: 'INITIAL_SYNC'
			}]);
			stateId = ids[0];
		} catch (e) {
			log.warn(`no sync state for ${accountId}: ${e.message}`);
		}
		try {
			return await this.syncer.sync(accountId);
		} finally {
			if (stateId) {
				await this.tempdb.del([stateId]).catch(() => {});
			}
		}
	}

	// ---- accounts ----------------------------------------------------------

	async accountRecord(accountId) {
		const [a] = await this.db.get([accountId]);
		if (!a || a._del || a.beingDeleted) {
			return null;
		}
		const enabled = (a.capabilityProviders || []).some(c => c && c.capability === 'PHOTO.UPLOAD');
		return {accountId, username: a.username, templateId: a.templateId, isEnabled: enabled};
	}

	async hasCredentials(accountId) {
		try {
			const r = await this.bus.call('luna://com.palm.service.accounts/hasCredentials', {accountId},
				{timeoutMs: 20000});
			return !!(r && r.returnValue && r.value);
		} catch (e) {
			return false;
		}
	}

	// onEnabled {accountId, enabled}: the account's photos are shown again
	// and synced, or hidden. The accounts service undoes the change when this
	// answers with an error, so it answers true; the sync goes on afterwards.
	async onEnabled({accountId, enabled}) {
		if (!accountId) {
			return {returnValue: false, errorText: 'accountId is required'};
		}
		await this.start();
		const albums = {from: ALBUM_KIND, where: [{prop: 'accountId', op: '=', val: accountId}]};
		if (enabled !== true) {
			await this.syncer.cancel(accountId);
			await this.db.mergeQuery(albums, {showAlbum: false}).catch(e => log.warn(e.message));
			this.accounts.setEnabled(accountId, false);
			return {returnValue: true};
		}
		await this.db.mergeQuery(albums, {showAlbum: true}).catch(e => log.warn(e.message));
		const account = await this.accountRecord(accountId).catch(() => null);
		if (!account) {
			return {returnValue: true, msg: `Account ${accountId} not found`};
		}
		account.isEnabled = true;
		this.accounts.upsert(account);
		this.capsMap = capabilitiesFor(this.accounts.remote());
		// Not signed in yet: onCredentialsChanged syncs it once it is
		if (!(await this.hasCredentials(accountId))) {
			return {returnValue: true, msg: `Account ${accountId} does not have credentials`};
		}
		this.background(this.syncOne(accountId), `sync of ${accountId}`);
		return {returnValue: true};
	}

	// onCredentialsChanged {accountId}: signed in again (a restored profile,
	// a new password). The account is known again, and synced if its photos
	// are on.
	async onCredentialsChanged({accountId}) {
		if (!accountId) {
			return {returnValue: false, errorText: 'accountId is required'};
		}
		await this.start();
		const account = await this.accountRecord(accountId).catch(() => null);
		if (account) {
			this.accounts.upsert(account);
			this.capsMap = capabilitiesFor(this.accounts.remote());
			if (account.isEnabled) {
				this.background(this.syncOne(accountId), `sync of ${accountId}`);
			}
		}
		return {returnValue: true};
	}

	// onDelete {accountId}: everything synced from the account goes. Its
	// albums are marked first, so what an interrupted delete leaves is
	// removed the next time (removeLeftovers).
	async onDelete({accountId}) {
		if (!accountId || accountId === 'local') {
			return {returnValue: false, errorText: 'accountId is required'};
		}
		await this.start();
		if (this.deleting.has(accountId)) {
			return {returnValue: true};
		}
		this.deleting.add(accountId);
		try {
			const albums = {from: ALBUM_KIND, where: [{prop: 'accountId', op: '=', val: accountId}]};
			await this.db.mergeQuery(albums, {toBeDeleted: true, showAlbum: false}).catch(e => log.warn(e.message));
			await this.syncer.cancel(accountId);
			await this.accounts.track(accountId, 'del', () => this.removeAccountData(accountId));
		} catch (e) {
			// What is left stays marked, and goes with the next removeLeftovers
			log.error(`removing account ${accountId}: ${e.message}`);
		} finally {
			await this.clearSyncState(accountId);
			this.accounts.remove(accountId);
			this.capsMap = capabilitiesFor(this.accounts.remote());
			this.deleting.delete(accountId);
		}
		// The accounts service only waits for this
		return {returnValue: true};
	}

	async removeAccountData(accountId) {
		const albums = await this.db.find({from: ALBUM_KIND, where: [{prop: 'accountId', op: '=', val: accountId}]});
		const dirs = new Set();
		const account = this.accounts.get(accountId);
		if (account && account.templateId) {
			dirs.add(this.paths.accountDir(account.templateId, account.username));
		}
		let failure = null;
		for (const album of albums) {
			if (album.path && this.paths.inCache(album.path)) {
				dirs.add(path.dirname(album.path));
			}
			try {
				await this.library.removeAlbum(album);
			} catch (e) {
				log.warn(`album ${album._id}: ${e.message}`);
				failure = failure || e;
			}
		}
		// Albums that could not go stay marked, and with them their directory
		if (failure) {
			throw failure;
		}
		for (const dir of dirs) {
			await removeDir(this.paths, dir, {recursive: true}).catch(e => log.warn(e.message));
			// The template's directory too, once no account of it is left
			const parent = path.dirname(dir);
			if (this.paths.inCache(parent) && parent !== this.paths.generated) {
				await removeDir(this.paths, parent).catch(() => {});
			}
		}
	}

	// rmLeftOvers: albums of accounts whose removal did not finish
	removeLeftovers() {
		if (this.leftovers) {
			return this.leftovers;
		}
		this.leftovers = (async () => {
			try {
				const albums = await this.db.find({from: ALBUM_KIND, where: [{prop: 'toBeDeleted', op: '=', val: true}]});
				const owners = new Set(albums.map(a => a.accountId).filter(id => id && !this.deleting.has(id)));
				for (const accountId of owners) {
					this.deleting.add(accountId);
					try {
						await this.removeAccountData(accountId);
						await this.clearSyncState(accountId);
					} catch (e) {
						log.warn(`leftovers of ${accountId}: ${e.message}`);
					} finally {
						this.deleting.delete(accountId);
					}
				}
				return owners.size;
			} catch (e) {
				log.warn(`removing leftovers: ${e.message}`);
				return 0;
			} finally {
				this.leftovers = null;
			}
		})();
		return this.leftovers;
	}

	// The "syncing" state this service shows for an account in the accounts app
	clearSyncState(accountId) {
		return this.tempdb.delQuery({from: SYNCSTATE_KIND, where: [
			{prop: 'accountId', op: '=', val: accountId},
			{prop: 'capabilityProvider', op: '=', val: SERVICE}
		]}).catch(() => 0);
	}

	// Those it may have left behind when it went down
	async clearSyncStates() {
		for (const a of this.accounts.remote()) {
			await this.clearSyncState(a.accountId);
		}
	}

	// cleanupCache: the thumbnails and screen-size copies whose entry is
	// gone, deleted by the indexer when the photo went. Each file is named
	// after its entry (cache.js); an entry that cannot be read keeps its files.
	async cleanupCache() {
		let names;
		try {
			names = await fsp.readdir(this.paths.generated);
		} catch (e) {
			return 0;
		}
		const files = new Map();      // entry id -> [{name, prop}]
		for (const name of names) {
			const owner = ownerOf(name);
			if (owner) {
				if (!files.has(owner.id)) {
					files.set(owner.id, []);
				}
				files.get(owner.id).push({name, prop: owner.prop});
			} else if (name.startsWith('.tmp-')) {
				files.set(`.tmp:${name}`, [{name, prop: null}]);
			}
		}
		let removed = 0;
		const ids = [...files.keys()].filter(id => !id.startsWith('.tmp:'));
		for (let i = 0; i < ids.length; i += 100) {
			const batch = ids.slice(i, i + 100);
			let entries;
			try {
				entries = await this.db.get(batch);
			} catch (e) {
				continue;
			}
			const live = new Map(entries.filter(e => e && !e._del).map(e => [e._id, e]));
			for (const id of batch) {
				const entry = live.get(id);
				for (const f of files.get(id)) {
					const file = path.join(this.paths.generated, f.name);
					if (!entry || !entry[f.prop] || entry[f.prop].path !== file) {
						removed += (await removeFile(this.paths, file).catch(() => false)) ? 1 : 0;
					}
				}
			}
		}
		// Half-written ones from a thumbnailer that was stopped
		const hourAgo = Date.now() - 3600 * 1000;
		for (const [key, list] of files) {
			if (key.startsWith('.tmp:')) {
				const file = path.join(this.paths.generated, list[0].name);
				const st = await fsp.stat(file).catch(() => null);
				if (st && st.mtimeMs < hourAgo) {
					removed += (await removeFile(this.paths, file).catch(() => false)) ? 1 : 0;
				}
			}
		}
		return removed;
	}

	// ---- comments ----------------------------------------------------------

	async photoFor(arg) {
		const id = arg && (arg._id || arg.id);
		if (!id) {
			return null;
		}
		const [photo] = await this.db.get([id]);
		return photo && !photo._del ? photo : null;
	}

	commentsTarget(photo) {
		if (!photo || !isCloud(photo)) {
			return null;
		}
		const cap = this.caps(photo.type);
		const nested = photo[photo.type];
		return cap && cap.getComments && cap.serviceName && nested && nested.pid !== undefined ? {cap, pid: nested.pid} : null;
	}

	async getComments(arg) {
		const photo = await this.photoFor(arg);
		const target = this.commentsTarget(photo);
		if (!target) {
			return {returnValue: false, message: 'Read comments not supported for this account type'};
		}
		const r = await callProvider(this.bus, target.cap, 'getPhotoComments',
			{accountId: photo.accountId, pid: target.pid}, {timeoutMs: 60000});
		await this.db.merge([{_id: photo._id, comments: r.comments || []}]);
		return {returnValue: true, result: {id: photo._id, comments: r.comments || []}};
	}

	async addComment({photo: arg, text}) {
		const photo = await this.photoFor(arg);
		const target = this.commentsTarget(photo);
		if (!target) {
			return {returnValue: false, message: 'Add comments not supported for this account type'};
		}
		if (typeof text !== 'string' || !text.trim()) {
			return {returnValue: false, message: 'No comment text'};
		}
		await callProvider(this.bus, target.cap, 'addPhotoComments',
			{accountId: photo.accountId, pid: target.pid, text}, {timeoutMs: 60000});
		await this.getComments(photo);
		return {returnValue: true, message: 'successfully added the comments!!'};
	}

	// ---- helpers -----------------------------------------------------------

	background(promise, what) {
		promise.catch(e => log.warn(`${what}: ${e && e.message}`));
	}
}

module.exports = {PhotosService, SERVICE, ACCOUNT_QUERY};
