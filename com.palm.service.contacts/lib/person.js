// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	A person from db8 as the contacts framework's Person handled it for the
	favourite methods: read (Person.findById), its favourite flag and its
	favourite defaults changed, and saved (Person.save) with its favourite
	and speed-dial backups.

	A person is { id, raw, favorite, instantiationFavorite, favoriteDirty,
	defaultsChanged, points, pointsDirty, contactIds, contacts }. points
	holds its phone numbers, emails and IMs: the stored entries, completed
	in place with their defaults (records.js), as the framework's "extended"
	entries were. Their favoriteData, when they have none, is the one object
	all such entries share, as the framework's default for it was.

	A saved person is merged with only what changed, as the framework merged
	its "dirty" fields: its favourite flag when it was set, and its phone
	numbers, emails and IMs whenever it has any, as reading their normalised
	value (worked out again from the value on the first read) marked each
	entry changed.
*/

const crypto = require('crypto');
const {entry, single, isObject, PERSON_KIND} = require('./records');

const FAVORITE_BACKUP_KIND = 'com.palm.person.favoritebackup:1';
const SPEED_DIAL_BACKUP_KIND = 'com.palm.person.speeddialbackup:1';

const POINT_TYPES = {
	phone: 'contact_point_type_phoneNumber',
	email: 'contact_point_type_emailAddress',
	im: 'contact_point_type_imAddress'
};
// The point types in the order the framework went through them, and each one's field and entry kind.
const POINTS = [
	{type: POINT_TYPES.phone, field: 'phoneNumbers', kind: 'PhoneNumber'},
	{type: POINT_TYPES.email, field: 'emails', kind: 'EmailAddress'},
	{type: POINT_TYPES.im, field: 'ims', kind: 'IMAddress'}
];
const SUPPORTED_FAVORITE_TYPES = POINTS.map(p => p.type);

// Crypto.MD5.b64_md5 as Foundations has it in node: base64 with padding.
function b64md5(s) {
	return crypto.createHash('md5').update(s).digest('base64');
}

// DefaultPropertyHash / SpeedDialHash setPlainValue and isPlainValueEqual.
function plainHash(v) {
	return v ? b64md5(v) : null;
}
function plainEqual(v, hash) {
	return v ? b64md5(v) === hash : v === hash;
}

function list(v) {
	if (Array.isArray(v)) {
		return v;
	}
	return v === undefined || v === null ? [] : [v];
}

// What never settles: a chain of futures that the framework left without a result.
function never() {
	return new Promise(() => {});
}

function normalizeLower(v) {
	return typeof v === 'string' && v ? v.toLowerCase().trim() : '';
}

/*
	createPersons({db, call, model, linkHash, sharedFavoriteData}):
	sharedFavoriteData is the favoriteData of every point that has none of
	its own; it lasts as long as the service does, as the framework's did.
*/
function createPersons({db, model, linkHash, sharedFavoriteData = {}}) {
	const normalize = {
		phoneNumbers: v => model.normalizePhoneNumber(v),
		emails: normalizeLower,
		ims: normalizeLower
	};

	// One point: the stored entry, completed in place, and its state.
	function point(raw, field, kind) {
		const e = entry(raw, kind);
		if (e.favoriteData === undefined) {
			e.favoriteData = sharedFavoriteData;
		}
		if (e.normalizedValue === undefined) {
			e.normalizedValue = '';
		}
		if (field === 'phoneNumbers' && e.speedDial === undefined) {
			e.speedDial = '';
		}
		Object.defineProperty(e, '$regen', {value: true, writable: true, enumerable: false});
		Object.defineProperty(e, '$field', {value: field, enumerable: false});
		return e;
	}

	// The point's normalised value, worked out again from its value on the first read (or always, with no value).
	function normalizedValue(p) {
		if (!p.value || p.$regen) {
			p.normalizedValue = normalize[p.$field](p.value);
			p.$regen = false;
		}
		return p.normalizedValue;
	}

	// A person as Person.findById read it: undefined when db8 has no person of that _id.
	async function findById(id) {
		if (typeof id !== 'string') {
			throw new Error('Person.findById requires an id that is a string');
		}
		const results = await db.get([id]);
		const raw = results[0];
		if (!raw || raw._kind !== PERSON_KIND) {
			return undefined;
		}
		const points = {};
		for (const p of POINTS) {
			points[p.field] = list(raw[p.field]).map(e => point(e, p.field, p.kind));
		}
		const favorite = single(raw.favorite);
		return {
			id: raw._id,
			raw,
			favorite,
			instantiationFavorite: favorite,
			favoriteDirty: false,
			defaultsChanged: false,
			points,
			pointsDirty: {},
			contactIds: list(raw.contactIds).map(c => (c ? (isObject(c) ? c.value : c) : '')),
			contacts: null
		};
	}

	function setFavorite(person, value) {
		person.favorite = value;
		person.favoriteDirty = true;
	}

	function isFavorite(person) {
		return person.favorite || false;
	}

	function fieldOf(type) {
		const p = POINTS.find(x => x.type === type);
		return p && p.field;
	}

	// _getDefaultContactPointsForTypeAndAppId: points with favourite data (for the app, if one is given).
	function defaultPoints(person, type, appId) {
		const points = type && fieldOf(type) ? person.points[fieldOf(type)] :
			[].concat(person.points.phoneNumbers, person.points.emails, person.points.ims);
		return points.filter(p => (appId ? p.favoriteData[appId] : Object.keys(p.favoriteData).length > 0));
	}

	// _setDefaultForContactPointType: the default for the app on the first point of that value
	// and type, moved to the front. -> false when there is none.
	function setDefault(person, type, normalized, entryType, appId, listIndex, auxData) {
		const field = fieldOf(type);
		const points = person.points[field];
		const at = points.findIndex(p => normalizedValue(p) === normalized && p.type === entryType);
		if (at < 0) {
			return false;
		}
		const p = points[at];
		p.favoriteData[appId] = {listIndex, auxData};
		points.splice(at, 1);
		points.unshift(p);
		person.pointsDirty[field] = true;
		return true;
	}

	// Person._getNormalizedValueForContactPointType.
	function normalizedFor(type, value) {
		const field = fieldOf(type);
		return field ? normalize[field](value) : value;
	}

	function removeDefaultFor(p, appId) {
		p.favoriteData[appId] = undefined;
	}

	function removeAllFavoriteData(p) {
		p.favoriteData = {};
	}

	// Person.reloadContacts: the person's contacts from db8, in the order db8 gives them.
	async function reloadContacts(person) {
		person.contacts = await db.get(person.contactIds);
		return person.contacts;
	}

	async function backupFor(kind, hash) {
		const r = await db.findPage({from: kind, where: [{prop: 'contactBackupHash', op: '=', val: hash}]});
		return r.results[0];
	}

	// A favourite backup as FavoriteBackup.getDBObject wrote it.
	function favoriteBackupRecord(raw, hash) {
		raw = raw || {};
		const out = {_kind: FAVORITE_BACKUP_KIND};
		for (const k of ['_id', '_rev', '_del']) {
			if (raw[k] !== undefined) {
				out[k] = raw[k];
			}
		}
		const h = raw._id ? single(raw.contactBackupHash) : hash;
		if (h !== undefined) {
			out.contactBackupHash = h;
		}
		out.defaultPropertyHashes = list(raw.defaultPropertyHashes).map(d => entry(isObject(d) ? d : {},
			'DefaultPropertyHash'));
		return out;
	}

	// FavoriteBackup.setDefaultForContactPointType.
	function setBackupDefault(backup, value, type, favoriteData) {
		for (const h of backup.defaultPropertyHashes) {
			if (h.type === type && plainEqual(value, h.value)) {
				h.favoriteData = favoriteData;
				return;
			} else if (h.type === type && plainEqual(null, h.value)) {
				h.favoriteData = favoriteData;
				h.type = type;
				h.value = plainHash(value);
				return;
			}
		}
		backup.defaultPropertyHashes.push({value: plainHash(value), type, favoriteData});
	}

	// _setAllDefaultsInBackup.
	function allDefaultsInBackup(person, backup) {
		for (const type of SUPPORTED_FAVORITE_TYPES) {
			for (const p of defaultPoints(person, type)) {
				setBackupDefault(backup, normalizedValue(p), type, p.favoriteData);
			}
		}
	}

	// Saves that each answer true or false; one that fails counts as false (mapReduceAndVerifyResultsTrue).
	async function saveAll(records, write) {
		const results = await Promise.all(records.map(r => write(r).then(() => true, () => false)));
		return results.every(Boolean);
	}

	// _addFavoriteBackupDBEntries: a backup for each contact, its own if it has one.
	async function addFavoriteBackups(person) {
		const contacts = await reloadContacts(person);
		const backups = await Promise.all(contacts.map(async c => {
			const hash = (await linkHash.linkHash(c)).linkHash;
			const backup = favoriteBackupRecord(await backupFor(FAVORITE_BACKUP_KIND, hash), hash);
			allDefaultsInBackup(person, backup);
			return backup;
		}));
		return saveAll(backups, b => db.put([b]));
	}

	// Contact.getIdFromLinkHash: the id after the local-id marker, else the contact with that remoteId.
	async function idFromLinkHash(hash) {
		const idPart = String(hash).split('|')[1];
		const at = idPart.indexOf('~~:(!)~~');
		if (at !== -1) {
			return idPart.substring(at + '~~:(!)~~'.length);
		}
		const r = await db.findPage({from: 'com.palm.contact:1', where: [{prop: 'remoteId', op: '=', val: idPart}]});
		return r.results.length ? r.results[0]._id : null;
	}

	/*
		_updateFavoriteBackupDBEntries: the contacts' backups with the
		person's defaults, and a new backup for each contact that had none
		(or whose backup's hash does not lead back to it).
	*/
	async function updateFavoriteBackups(person) {
		const contacts = (await reloadContacts(person)).slice();
		const found = await Promise.all(contacts.map(async c => {
			try {
				const hash = (await linkHash.linkHash(c)).linkHash;
				return await backupFor(FAVORITE_BACKUP_KIND, hash);
			} catch (e) {
				return undefined;
			}
		}));
		const toSave = [];
		await Promise.all(found.map(async raw => {
			if (!raw) {
				return;
			}
			const backup = favoriteBackupRecord(raw);
			const id = await idFromLinkHash(backup.contactBackupHash);
			if (id) {
				for (let j = 0; j < contacts.length; j += 1) {
					if (id === contacts[j]._id) {
						contacts.splice(j, 1);
					}
				}
				allDefaultsInBackup(person, backup);
				toSave.push(backup);
			}
		}));
		/*
			The contacts left had no backup. The framework's step that made
			theirs never set its result, so it settled only for a contact
			whose hash failed: one hash had and the save never ends (the
			command times out); every hash failing fails it.
		*/
		const outcomes = await Promise.all(contacts.map(c => linkHash.linkHash(c).then(() => null, e => e)));
		if (outcomes.some(e => e === null)) {
			return never();
		}
		if (outcomes.length) {
			throw outcomes[0];
		}
		return saveAll(toSave, b => db.put([b]));
	}

	// _removeFavoriteBackupDBEntries: every backup of each contact's hash.
	async function removeFavoriteBackups(person) {
		const contacts = await reloadContacts(person);
		return saveAll(contacts, async c => {
			const hash = (await linkHash.linkHash(c)).linkHash;
			const count = await db.delQuery({from: FAVORITE_BACKUP_KIND, where: [{prop: 'contactBackupHash', op: '=', val: hash}]});
			// FavoriteBackup.removeBackupForContact: true only when it removed some.
			if (count > 0) {
				return;
			}
			throw new Error('none removed');
		});
	}

	// SpeedDialSaver(person).saveBackupRecordsForSpeedDials.
	async function saveSpeedDialBackups(person) {
		const speedDials = person.points.phoneNumbers.filter(n => n.speedDial)
			.map(n => ({hashedPhoneNumber: plainHash(n.value), key: n.speedDial}));
		const contacts = person.contacts && person.contacts.length ? person.contacts : await reloadContacts(person);
		const hashes = [];
		const seen = {};
		/*
			A contact whose hash cannot be had: the framework's next step read
			the result of the wrong future (the outer one, not yet settled), so
			the failure was not read there. It still failed the save when the
			step after that waited on db8 (some hash was had), and was lost
			when that step had nothing to look up (no hash at all).
		*/
		const failures = [];
		await Promise.all(contacts.map(async c => {
			if (!seen[c._id]) {
				let h;
				try {
					h = (await linkHash.linkHash(c)).linkHash;
				} catch (e) {
					failures.push(e);
					return;
				}
				hashes.push(h);
				seen[c._id] = h;
			}
		}));
		if (failures.length && hashes.length) {
			throw failures[0];
		}
		const work = [];
		await Promise.all(hashes.map(async hash => {
			const raw = await backupFor(SPEED_DIAL_BACKUP_KIND, hash);
			const backup = {_kind: SPEED_DIAL_BACKUP_KIND};
			for (const k of ['_id', '_rev', '_del']) {
				if (raw && raw[k] !== undefined) {
					backup[k] = raw[k];
				}
			}
			backup.contactBackupHash = raw ? single(raw.contactBackupHash) : hash;
			backup.speedDials = [];
			if (speedDials.length > 0) {
				backup.speedDials = speedDials.map(s => Object.assign({}, s));
				work.push(() => db.put([backup]));
			} else if (backup._id) {
				work.push(() => db.del([backup._id]));
			}
		}));
		await saveAll(work, w => w());
	}

	// What a merge of the person writes: the favourite flag if it was set, the points if it has any.
	function dirtyRecord(person) {
		const out = {_kind: PERSON_KIND, _id: person.id};
		if (person.raw._del !== undefined) {
			out._del = person.raw._del;
		}
		if (person.favoriteDirty) {
			out.favorite = person.favorite;
		}
		for (const p of POINTS) {
			const points = person.points[p.field];
			if (points.length || person.pointsDirty[p.field]) {
				for (const e of points) {
					normalizedValue(e);
				}
				out[p.field] = JSON.parse(JSON.stringify(points));
			}
		}
		return out;
	}

	/*
		Person.save, for a person from db8: merge what changed; then its
		favourite backups: added when it became a favourite, brought up to
		date when its defaults changed, removed when it stopped being one;
		then its speed-dial backups, always. -> true
	*/
	async function save(person) {
		const result = await db.merge([dirtyRecord(person)]);
		if (!result.length) {
			throw new Error('savePerson put - result length is zero');
		}
		const fav = person.favorite;
		if (fav) {
			if (person.instantiationFavorite !== fav || !person.id) {
				await addFavoriteBackups(person);
			} else if (person.defaultsChanged) {
				await updateFavoriteBackups(person);
			}
		} else if (person.instantiationFavorite !== fav && person.id) {
			await removeFavoriteBackups(person);
		}
		person.id = result[0].id;
		await saveSpeedDialBackups(person);
		person.instantiationFavorite = person.favorite;
		person.defaultsChanged = false;
		person.favoriteDirty = false;
		person.pointsDirty = {};
		return true;
	}

	return {findById, setFavorite, isFavorite, defaultPoints, setDefault, normalizedFor, removeDefaultFor,
		removeAllFavoriteData, normalizedValue, reloadContacts, save, dirtyRecord};
}

module.exports = {createPersons, b64md5, POINT_TYPES, SUPPORTED_FAVORITE_TYPES, FAVORITE_BACKUP_KIND,
	SPEED_DIAL_BACKUP_KIND};
