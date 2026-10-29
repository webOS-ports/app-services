// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	Person records: building one from its contacts (the contacts framework's
	Person.fixupFromObjects), and saving it with its favourite and speed-dial
	backups (Person.save).

	A person is handled as { rec, contacts, fromDB, instantiationFavorite }:
	rec is the record as the framework's getDBObject() gave it - for a person
	from db8 the stored fields as they are, for a new one every field with its
	default - and contacts the contact records last loaded for it.

	A fixup rebuilds the fields that come from the contacts, and remembers
	which ones it changed: a person already in db8 is saved with a merge of
	those only, as the framework merged its "dirty" fields. So a person whose
	contacts no longer have an organization keeps the one it had, as before.
*/

const crypto = require('crypto');
const {DEFAULTS, NAME_FIELDS, withDefaults, entries, single, contactName, organization, address} = require('./model');

const KIND = 'com.palm.person:1';
const FAVORITE_BACKUP_KIND = 'com.palm.person.favoritebackup:1';
const SPEED_DIAL_BACKUP_KIND = 'com.palm.person.speeddialbackup:1';
const PREFS_KIND = 'com.palm.app.contacts.prefs:1';
const PREFS_DEFAULTS = {listSortOrder: 'LAST_FIRST', defaultAccountId: '', contactsPhoneRegion: 'us'};

const POINT_TYPES = {
	phone: 'contact_point_type_phoneNumber',
	email: 'contact_point_type_emailAddress',
	im: 'contact_point_type_imAddress'
};
const POINT_FIELDS = {
	[POINT_TYPES.phone]: 'phoneNumbers',
	[POINT_TYPES.email]: 'emails',
	[POINT_TYPES.im]: 'ims'
};
const SUPPORTED_FAVORITE_TYPES = [POINT_TYPES.phone, POINT_TYPES.email, POINT_TYPES.im];

// The fields of a person record, in the order the framework wrote them.
const FIELDS = ['favorite', 'contactIds', 'sortKey', 'name', 'names', 'nickname', 'organization', 'searchTerms',
	'emails', 'phoneNumbers', 'ims', 'photos', 'addresses', 'urls', 'notes', 'birthday', 'anniversary', 'gender',
	'reminder', 'launcherId', 'relations', 'ringtone'];

// Crypto.MD5.b64_md5 as Foundations has it in node: base64 with padding.
function b64md5(s) {
	return crypto.createHash('md5').update(s).digest('base64');
}

function clone(v) {
	return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function hasFavoriteData(entry) {
	return !!(entry && entry.favoriteData && typeof entry.favoriteData === 'object' &&
		Object.keys(entry.favoriteData).length);
}

/*
	The record new Person(raw).getDBObject() gives: a raw record from db8
	(one with an _id) as stored, any other with defaults for what it lacks.
	The emails, phone numbers and IMs are extended entries either way.
*/
function personRecord(model, raw) {
	raw = raw || {};
	const fromDB = !!raw._id;
	const prim = (v, def) => {
		const s = single(v);
		return s === undefined && !fromDB ? def : s;
	};
	const obj = (v, defaults) => {
		const o = v && typeof v === 'object' ? v : {};
		return fromDB ? Object.assign({}, o) : withDefaults(o, defaults);
	};
	const list = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
	const rec = {_kind: KIND};
	for (const k of ['_id', '_rev', '_del']) {
		if (raw[k] !== undefined) {
			rec[k] = raw[k];
		}
	}
	rec.favorite = prim(raw.favorite, false);
	rec.contactIds = list(raw.contactIds).map(id => single(id) === undefined ? '' : single(id));
	rec.sortKey = prim(raw.sortKey, '');
	rec.name = obj(raw.name, DEFAULTS.name);
	rec.names = list(raw.names).map(n => withDefaults(n, DEFAULTS.name));
	rec.nickname = prim(raw.nickname, '');
	rec.organization = fromDB ? Object.assign({}, raw.organization || {}) : organization(raw.organization);
	rec.searchTerms = list(raw.searchTerms).map(s => single(s) === undefined ? '' : single(s));
	rec.emails = list(raw.emails).map(model.emailEntry);
	rec.phoneNumbers = list(raw.phoneNumbers).map(model.phoneEntry);
	rec.ims = list(raw.ims).map(model.imEntry);
	rec.photos = obj(raw.photos, DEFAULTS.photos);
	rec.addresses = list(raw.addresses).map(address);
	rec.urls = list(raw.urls).map(u => withDefaults(u, DEFAULTS.url));
	rec.notes = list(raw.notes).map(n => single(n) === undefined ? '' : single(n));
	rec.birthday = prim(raw.birthday, '');
	rec.anniversary = prim(raw.anniversary, '');
	rec.gender = prim(raw.gender, '');
	rec.reminder = prim(raw.reminder, '');
	rec.launcherId = prim(raw.launcherId, '');
	rec.relations = list(raw.relations).map(r => withDefaults(r, DEFAULTS.relation));
	rec.ringtone = obj(raw.ringtone, DEFAULTS.ringtone);
	return rec;
}

function createPersons({db, call, model, G, linkHash, log = console}) {
	// A person as loaded (or a new one): see the top of this file.
	function wrap(raw) {
		const rec = personRecord(model, raw);
		return {rec, contacts: [], fromDB: !!(raw && raw._id), instantiationFavorite: !!rec.favorite, defaultsChanged: false};
	}

	async function getContacts(ids) {
		return ids.length ? db.get(ids) : [];
	}

	// Person.reloadContacts: the person's contacts from db8, in the order db8 returns them.
	async function reloadContacts(person) {
		person.contacts = await getContacts(person.rec.contactIds);
		return person.contacts;
	}

	// AppPrefs: the contacts app's prefs record, created with its defaults when there is none.
	async function listSortOrder() {
		let r = await db.findPage({from: PREFS_KIND, limit: 2});
		if (r.results.length === 0) {
			await db.put([Object.assign({}, PREFS_DEFAULTS, {_kind: PREFS_KIND})]);
			r = await db.findPage({from: PREFS_KIND, limit: 2});
		}
		const prefs = r.results.length === 1 ? r.results[0] : PREFS_DEFAULTS;
		return prefs.listSortOrder;
	}

	async function favoriteBackupForHash(hash) {
		const r = await db.findPage({from: FAVORITE_BACKUP_KIND, where: [{prop: 'contactBackupHash', op: '=', val: hash}]});
		return r.results[0];
	}

	// The favourite backups of every contact of these persons; a contact whose hash or lookup
	// fails counts as having none.
	async function favoriteBackupsFor(people) {
		const ids = Array.from(new Set([].concat(...people.map(p => p.rec.contactIds))));
		const contacts = await getContacts(ids);
		return Promise.all(contacts.map(async c => {
			try {
				return await favoriteBackupForHash((await linkHash.linkHash(c)).linkHash);
			} catch (e) {
				return undefined;
			}
		}));
	}

	// Person._discoverFavoriteSaverBackupDupes: savers that repeat another with the same
	// favourite data are kept once per repeat, ones that disagree are dropped.
	function splitSavers(savers) {
		const dupes = [], notDupes = [];
		for (let i = 0; i < savers.length; i++) {
			let wasDupe = false;
			const a = savers[i];
			for (let j = i + 1; j < savers.length; j++) {
				const b = savers[j];
				if (a.value === b.value && a.type === b.type) {
					wasDupe = true;
					if (JSON.stringify(a.favoriteData) === JSON.stringify(b.favoriteData)) {
						dupes.push(a);
					}
				}
			}
			if (!wasDupe) {
				notDupes.push(a);
			}
		}
		return {dupes, notDupes};
	}

	// The link hashes of the contacts of these persons (each person's loaded contacts, loaded
	// now if it has none), in the order the lookups finish; one failing fails the lot.
	async function linkHashesOf(people) {
		const hashes = [];
		const seen = {};
		await Promise.all(people.map(async p => {
			if (p.contacts.length === 0) {
				await reloadContacts(p);
			}
			await Promise.all(p.contacts.map(async c => {
				if (!seen[c._id]) {
					const now = linkHash.linkHashNow(c);
					const h = now ? now.linkHash : (await linkHash.linkHash(c)).linkHash;
					seen[c._id] = h;
					hashes.push(h);
				} else {
					hashes.push(seen[c._id]);
				}
			}));
		}));
		return hashes;
	}

	async function cropListPhoto(localPath) {
		const parts = localPath.split('/');
		const fileName = parts[parts.length - 1];
		const cache = await call.subscribe('luna://com.palm.filecache/InsertCacheObject',
			{typeName: 'contactphoto', size: 8192, fileName, subscribe: true});
		try {
			const toPath = cache.first.pathName;
			await call('luna://com.webos.service.image/ezResize',
				{src: localPath, dest: toPath, destType: 'jpg', destSizeW: 50, destSizeH: 50});
			return toPath;
		} finally {
			cache.cancel();
		}
	}

	// The person's photos from the first contact with any; the list photo cropped anew.
	async function photosFrom(contacts) {
		const withPhotos = contacts.find(c => entries(c, 'photos', DEFAULTS.photo).length > 0);
		if (!withPhotos) {
			return {};
		}
		const photos = entries(withPhotos, 'photos', DEFAULTS.photo);
		const square = photos.find(p => p.type === 'type_square' && p.localPath);
		const big = photos.find(p => p.type === 'type_big' && p.localPath);
		const list = square || big;
		if (!list) {
			return {};
		}
		const out = {
			bigPhotoPath: big ? big.localPath : '',
			squarePhotoPath: square ? square.localPath : '',
			listPhotoSource: list.type,
			bigPhotoId: big ? big._id : '',
			squarePhotoId: square ? square._id : '',
			contactId: withPhotos._id,
			accountId: single(withPhotos.accountId)
		};
		try {
			out.listPhotoPath = await cropListPhoto(list.localPath);
		} catch (e) {
			log.warn('Person fixup: cropping list photo and got error.  We\'re ignoring it.  ' + ((e && e.message) || e));
			out.listPhotoPath = '';
		}
		return out;
	}

	/*
		Person.fixupFromObjects: the person's fields again from its contacts
		(given, or loaded from its contactIds), carrying over from `others` -
		the persons being merged into it - their favourite flag, launcher id,
		reminder, ringtone and speed dials.
	*/
	async function fixup(person, options = {}) {
		const changed = new Set();
		try {
			await fixupSteps(person, options, changed);
		} catch (e) {
			// As _savePersonAttachingTheseContacts had it: it never looked at how the fixup
			// went, so the person is saved as far as the fixup got.
			if (!options.partial) {
				throw e;
			}
			log.warn('Person fixup failed, going on with what it did: ' + ((e && e.message) || e));
		} finally {
			person.changed = new Set([...(person.changed || []), ...changed]);
		}
		return person.rec;
	}

	async function fixupSteps(person, {contacts, others = [], listSortOrder: order}, changed) {
		if (!contacts) {
			contacts = await reloadContacts(person);
		}
		others = others.slice();
		const all = [person].concat(others);
		const rec = person.rec;
		const set = (field, value) => {
			rec[field] = value;
			changed.add(field);
		};

		const savedSpeedDials = [];
		for (const p of all) {
			for (const n of p.rec.phoneNumbers) {
				if (n.speedDial) {
					savedSpeedDials.push({speedDial: n.speedDial, value: n.value, person: p});
				}
			}
		}

		let wasFavoriteFromBackups = false;
		let savers = [];
		for (const backup of await favoriteBackupsFor(all)) {
			if (backup) {
				wasFavoriteFromBackups = true;
				savers = savers.concat((backup.defaultPropertyHashes || []).map(h => withDefaults(h,
					{value: null, type: null, favoriteData: null})));
			}
		}
		const {dupes, notDupes} = splitSavers(savers);

		// clearFieldsForFixup, then each contact in turn.
		const name = Object.assign({}, rec.name);
		for (const f of NAME_FIELDS) {
			name[f] = '';
		}
		const names = [], terms = [], emails = [], phones = [], ims = [], addresses = [], urls = [], relations = [];
		const notes = [];
		const seen = {name: {}, term: {}, email: {}, phone: {}, im: {}, address: {}, url: {}, relation: {}, note: {}};
		let nickname, org, birthday, anniversary, gender;
		let nameCopied = false;
		for (const contact of contacts) {
			if (!contact) {
				continue;
			}
			const cname = contactName(contact);
			if (model.fullName(cname) !== '') {
				if (!nameCopied) {
					for (const f of NAME_FIELDS) {
						name[f] = cname[f] || '';
					}
					nameCopied = true;
				}
				names.push(...model.dedupe(seen.name, [cname], model.keys.name));
			}
			if (nickname === undefined && single(contact.nickname)) {
				nickname = single(contact.nickname);
			}
			if (org === undefined) {
				const best = model.bestOrganization(contact);
				if (best) {
					org = best;
				}
			}
			terms.push(...model.dedupe(seen.term, model.searchTerms(contact)));
			emails.push(...model.dedupe(seen.email, entries(contact, 'emails', DEFAULTS.email), model.keys.email));
			phones.push(...model.dedupe(seen.phone, entries(contact, 'phoneNumbers', DEFAULTS.phone), model.keys.phone));
			ims.push(...model.dedupe(seen.im, entries(contact, 'ims', DEFAULTS.im), model.keys.im));
			addresses.push(...model.dedupe(seen.address, entries(contact, 'addresses', DEFAULTS.address), model.keys.address));
			urls.push(...model.dedupe(seen.url, entries(contact, 'urls', DEFAULTS.url), model.keys.url));
			relations.push(...model.dedupe(seen.relation, entries(contact, 'relations', DEFAULTS.relation),
				model.keys.relation));
			const note = single(contact.note);
			if (note) {
				notes.push(...model.dedupe(seen.note, [note], model.keys.note));
			}
			if (birthday === undefined && single(contact.birthday)) {
				birthday = single(contact.birthday);
			}
			if (anniversary === undefined && single(contact.anniversary)) {
				anniversary = single(contact.anniversary);
			}
			if (gender === undefined && single(contact.gender)) {
				gender = single(contact.gender);
			}
		}
		set('name', name);
		set('names', names.map(clone));
		set('nickname', nickname === undefined ? '' : nickname);
		if (org !== undefined) {
			const old = rec.organization && rec.organization._id !== undefined ? {_id: rec.organization._id} : {};
			set('organization', Object.assign(old, clone(org)));
		} else {
			// Cleared but not marked changed: a person from db8 keeps its old one there,
			// while its sort key is worked out without it.
			rec.organization = Object.assign({}, rec.organization, organization({}));
		}
		set('searchTerms', terms);
		set('emails', emails.map(model.emailEntry));
		set('phoneNumbers', phones.map(model.phoneEntry));
		set('ims', ims.map(model.imEntry));
		set('addresses', addresses.map(clone));
		set('urls', urls.map(clone));
		set('notes', notes);
		set('birthday', birthday === undefined ? '' : birthday);
		set('anniversary', anniversary === undefined ? '' : anniversary);
		set('gender', gender === undefined ? '' : gender);
		set('relations', relations.map(clone));

		if (!order) {
			order = await listSortOrder();
		}
		set('sortKey', model.sortKey(rec, order));

		const photos = await photosFrom(contacts);
		set('photos', Object.assign({}, rec.photos, withDefaults(photos, DEFAULTS.photos)));

		if (!rec.launcherId) {
			const withLauncher = others.find(o => o && o.rec.launcherId);
			if (withLauncher) {
				set('launcherId', withLauncher.rec.launcherId);
			}
		}
		set('reminder', all.reduce((acc, p) => {
			const r = p.rec.reminder;
			return r ? (acc ? acc + '. ' + r : r) : acc;
		}, ''));
		if (!(rec.ringtone && rec.ringtone.name) || !(rec.ringtone && rec.ringtone.location)) {
			const withRingtone = others.find(o => o && o.rec.ringtone && o.rec.ringtone.name && o.rec.ringtone.location);
			if (withRingtone) {
				set('ringtone', Object.assign({}, rec.ringtone, {name: withRingtone.rec.ringtone.name,
					location: withRingtone.rec.ringtone.location}));
			}
		}

		// Speed dials: the ones the persons had, on the first number that compares as the same;
		// then the backups', on the first number with that hash and no speed dial yet.
		for (const saved of savedSpeedDials) {
			const match = rec.phoneNumbers.find(n => G.Phone.comparePhoneNumbers(n.value, saved.value) > 0);
			if (match) {
				match.speedDial = saved.speedDial;
			}
		}
		const hashes = await linkHashesOf(all);
		const backups = (await db.findPage({from: SPEED_DIAL_BACKUP_KIND,
			where: [{prop: 'contactBackupHash', op: '=', val: hashes}]})).results;
		// SpeedDialBackup.getBackupsForLinkHashes makes every one of them the first.
		for (let i = 0; i < backups.length; i++) {
			for (const sd of (backups[0].speedDials || [])) {
				rec.phoneNumbers.some(n => {
					const hashed = sd.hashedPhoneNumber === undefined ? null : sd.hashedPhoneNumber;
					const equal = n.value ? b64md5(n.value) === hashed : n.value === hashed;
					if (equal && !n.speedDial) {
						n.speedDial = sd.key === undefined ? null : sd.key;
						return true;
					}
					return false;
				});
			}
		}

		// Favourites: the flag from the others or a backup; the backed-up defaults onto the
		// points with that hash; and the points with favourite data to the front.
		if (others.some(o => o.rec.favorite) || wasFavoriteFromBackups) {
			set('favorite', true);
		}
		for (const saver of dupes.concat(notDupes)) {
			const points = saver.type in POINT_FIELDS ? rec[POINT_FIELDS[saver.type]] :
				rec.phoneNumbers.concat(rec.emails, rec.ims);
			for (const point of points) {
				const nv = point.normalizedValue;
				if (nv ? b64md5(nv) === saver.value : nv === saver.value) {
					point.favoriteData = saver.favoriteData;
					break;
				}
			}
		}
		for (const type of SUPPORTED_FAVORITE_TYPES) {
			const field = POINT_FIELDS[type];
			const points = rec[field].slice();
			const promote = [];
			points.forEach((point, i) => {
				if (hasFavoriteData(point)) {
					points.splice(i, 1);
					promote.push(point);
				}
			});
			if (promote.length) {
				rec[field] = promote.concat(points);
			}
		}
	}

	/*
		Person.save: put a new person, merge the changed fields of one from db8;
		then its favourite backups, if its favourite flag changed or it is new;
		then its speed-dial backups, always.
	*/
	async function save(person) {
		const rec = person.rec;
		let result;
		if (rec._id) {
			const dirty = {_kind: rec._kind, _id: rec._id};
			if (rec._del !== undefined) {
				dirty._del = rec._del;
			}
			for (const f of FIELDS) {
				if (person.changed && person.changed.has(f)) {
					dirty[f] = rec[f];
				}
			}
			result = await db.merge([dirty]);
		} else {
			const full = {};
			for (const k of ['_kind'].concat(FIELDS)) {
				full[k] = rec[k];
			}
			result = await db.put([full]);
		}
		if (!result || !result.length) {
			throw new Error('savePerson put - result length is zero');
		}
		const isNew = !rec._id;
		if (rec.favorite) {
			if (person.instantiationFavorite !== Boolean(rec.favorite) || isNew) {
				await addFavoriteBackups(person);
			} else if (person.defaultsChanged) {
				await addFavoriteBackups(person);
			}
		} else if (person.instantiationFavorite !== Boolean(rec.favorite) && !isNew) {
			await removeFavoriteBackups(person);
		}
		rec._id = result[0].id;
		rec._rev = result[0].rev;
		person.changed = new Set();
		person.fromDB = true;
		await saveSpeedDialBackups(person);
		person.instantiationFavorite = !!rec.favorite;
		person.defaultsChanged = false;
		return true;
	}

	function defaultsInBackup(person, backup) {
		const hashes = backup.defaultPropertyHashes = (backup.defaultPropertyHashes || []).map(h =>
			withDefaults(h, {value: null, type: null, favoriteData: null}));
		for (const type of SUPPORTED_FAVORITE_TYPES) {
			for (const point of person.rec[POINT_FIELDS[type]].filter(hasFavoriteData)) {
				const value = point.normalizedValue;
				const plain = v => (v ? b64md5(v) : null);
				let found = hashes.find(h => h.type === type && (value ? b64md5(value) === h.value : value === h.value));
				if (!found) {
					found = hashes.find(h => h.type === type && h.value === null);
					if (found) {
						found.value = plain(value);
					}
				}
				if (found) {
					found.favoriteData = point.favoriteData;
				} else {
					hashes.push({value: plain(value), type, favoriteData: point.favoriteData});
				}
			}
		}
	}

	async function addFavoriteBackups(person) {
		const contacts = await reloadContacts(person);
		const toSave = [];
		await Promise.all(contacts.map(async c => {
			const hash = (await linkHash.linkHash(c)).linkHash;
			const backup = clone(await favoriteBackupForHash(hash)) ||
				{_kind: FAVORITE_BACKUP_KIND, contactBackupHash: hash, defaultPropertyHashes: []};
			defaultsInBackup(person, backup);
			toSave.push(backup);
		}));
		for (const b of toSave) {
			await db.put([b]);
		}
	}

	async function removeFavoriteBackups(person) {
		const contacts = await reloadContacts(person);
		await Promise.all(contacts.map(async c => {
			const hash = (await linkHash.linkHash(c)).linkHash;
			await db.delQuery({from: FAVORITE_BACKUP_KIND, where: [{prop: 'contactBackupHash', op: '=', val: hash}]});
		}));
	}

	// SpeedDialSaver(person).saveBackupRecordsForSpeedDials.
	async function saveSpeedDialBackups(person) {
		const speedDials = person.rec.phoneNumbers.filter(n => n.speedDial)
			.map(n => ({hashedPhoneNumber: n.value ? b64md5(n.value) : null, key: n.speedDial}));
		if (person.contacts.length === 0) {
			await reloadContacts(person);
		}
		const hashes = [];
		const seen = {};
		await Promise.all(person.contacts.map(async c => {
			if (!seen[c._id]) {
				const now = linkHash.linkHashNow(c);
				const h = now ? now.linkHash : (await linkHash.linkHash(c)).linkHash;
				seen[c._id] = h;
				hashes.push(h);
			}
		}));
		const work = [];
		await Promise.all(hashes.map(async hash => {
			const r = await db.findPage({from: SPEED_DIAL_BACKUP_KIND,
				where: [{prop: 'contactBackupHash', op: '=', val: hash}]});
			const backup = r.results[0] ? clone(r.results[0]) :
				{_kind: SPEED_DIAL_BACKUP_KIND, contactBackupHash: hash, speedDials: []};
			if (speedDials.length > 0) {
				backup.speedDials = clone(speedDials);
				work.push(() => db.put([backup]));
			} else if (backup._id) {
				work.push(() => db.del([backup._id]));
			}
		}));
		await Promise.all(work.map(w => w()));
	}

	async function del(person) {
		return db.del([person.rec._id]);
	}

	// Person.findByContactIds: the person holding ids[0], else the one holding most of ids.
	async function findByContactIds(ids) {
		const r = await db.findPage({from: KIND, where: [{prop: 'contactIds', op: '=', val: ids}]});
		let best = null, most = 0;
		const seenIds = {};
		for (const raw of r.results) {
			if (seenIds[raw._id]) {
				continue;
			}
			const own = (raw.contactIds || []).map(single);
			if (own.indexOf(ids[0]) >= 0) {
				return raw;
			}
			const n = own.filter(id => ids.indexOf(id) >= 0).length;
			if (n > most) {
				best = raw;
				most = n;
			}
			seenIds[raw._id] = true;
		}
		return r.results.length ? best || undefined : null;
	}

	return {wrap, reloadContacts, fixup, save, del, listSortOrder, findByContactIds, KIND};
}

module.exports = {createPersons, personRecord, b64md5, KIND, FIELDS};
