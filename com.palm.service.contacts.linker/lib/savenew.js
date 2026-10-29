// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	saveNewPersonAndContacts: a person made from contacts that are not in
	db8 yet, saved so that the autolinker finds the contacts already linked
	(the contacts app creates a contact this way). As
	Person._savePersonAttachingTheseContacts did:

	- contacts that have an _id keep it and only join the person's
	  contactIds; the others get reserved ids and make up the person
	- the person is saved first, then each contact, by merge (db8 stores a
	  merge with an id it does not have as a new record)
	- the contacts are the caller's objects with the contacts framework's
	  defaults written into them, and the person's fields in the email,
	  phone and IM entries the person took from them
	- the reply lists the contacts that got an id here, as the framework
	  shows a contact: every field, with its default when missing

	Not kept: the old code wrote the framework's own Address object, its
	internals and all, as organizations[].location; this writes the address.
*/

const {DEFAULTS, withDefaults, single, kindName, normalizeLower} = require('./model');

const SIM_SERVICE = 'luna://com.palm.service.contacts.sim';

const ACCOUNT = {domain: '', userName: '', userid: ''};
const SYNC_SOURCE = {name: null, extended: {}};

// A contact's fields as the framework shows them, in its order, with how each reads.
const FIELDS = [
	['accounts', 'array', ACCOUNT],
	['accountId', 'primitive', ''],
	['addresses', 'array', DEFAULTS.address],
	['anniversary', 'primitive', ''],
	['birthday', 'primitive', ''],
	['displayName', 'primitive', ''],
	['emails', 'array', DEFAULTS.email],
	['gender', 'primitive', ''],
	['ims', 'array', DEFAULTS.im],
	['name', 'object', DEFAULTS.name],
	['nickname', 'primitive', ''],
	['note', 'primitive', ''],
	['organizations', 'array', DEFAULTS.organization],
	['phoneNumbers', 'array', DEFAULTS.phone],
	['photos', 'array', DEFAULTS.photo],
	['syncSource', 'object', SYNC_SOURCE],
	['tags', 'primitives', ''],
	['urls', 'array', DEFAULTS.url],
	['relations', 'array', DEFAULTS.relation]
];
const FIELD = {};
for (const [name, kind, defaults] of FIELDS) {
	FIELD[name] = {kind, defaults};
}

// The defaults written into the object itself, as the framework's properties wrote them.
function fillIn(obj, defaults) {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
		return;
	}
	const filled = withDefaults(obj, defaults);
	for (const k of Object.keys(filled)) {
		if (obj[k] === undefined) {
			obj[k] = filled[k];
		}
	}
}

// A new contact as the framework took it in: its object and array fields filled in, in place.
function takeIn(contact) {
	for (const [name, kind, defaults] of FIELDS) {
		const v = contact[name];
		if (v === undefined) {
			continue;
		}
		if (kind === 'object') {
			fillIn(v, defaults);
		} else if (kind === 'array') {
			for (const e of Array.isArray(v) ? v : [v]) {
				fillIn(e, defaults);
				if (name === 'organizations' && e && typeof e === 'object') {
					if (!e.location || typeof e.location !== 'object') {
						e.location = {};
					}
					fillIn(e.location, DEFAULTS.address);
				}
			}
		}
	}
	return contact;
}

// Contact.getDBObject(): the contact's own keys first, then every other field with its default.
function shown(contact) {
	const out = {};
	const read = (name, v) => {
		const f = FIELD[name];
		if (!f) {
			return v;
		}
		if (f.kind === 'primitive') {
			const s = single(v);
			return s === undefined ? f.defaults : s;
		}
		if (f.kind === 'primitives') {
			return (Array.isArray(v) ? v : [v]).map(e => (single(e) === undefined ? '' : single(e)));
		}
		if (f.kind === 'array') {
			return Array.isArray(v) ? v : [v];
		}
		return v;
	};
	for (const k of Object.keys(contact)) {
		out[k] = read(k, contact[k]);
	}
	for (const [name, kind, defaults] of FIELDS) {
		if (out[name] === undefined) {
			out[name] = kind === 'array' || kind === 'primitives' ? [] :
				kind === 'object' ? withDefaults({}, defaults) : defaults;
		}
	}
	return out;
}

function createSaveNew({db, call, persons, model}) {
	/*
		The extended fields the person's entries gave the contact entries they
		were made from. In the framework those were one object, so what the
		fixup did to the person's entry (a speed dial or favourite restored from
		a backup) the contact's entry had too.
	*/
	function markTaken(person, contacts) {
		const final = new Map();
		for (const field of ['emails', 'phoneNumbers', 'ims']) {
			for (const e of person.rec[field] || []) {
				if (e && e.source) {
					final.set(e.source, e);
				}
			}
		}
		const seen = {email: {}, phone: {}, im: {}};
		const fields = [['emails', 'email', DEFAULTS.email], ['phoneNumbers', 'phone', DEFAULTS.phone],
			['ims', 'im', DEFAULTS.im]];
		for (const c of contacts) {
			for (const [field, key, defaults] of fields) {
				const list = c[field];
				if (list === undefined) {
					continue;
				}
				for (const e of Array.isArray(list) ? list : [list]) {
					const k = model.keys[key](withDefaults(e, defaults));
					if (!k || seen[key][k]) {
						continue;
					}
					seen[key][k] = true;
					if (!e || typeof e !== 'object') {
						continue;
					}
					const taken = final.get(e);
					if (taken) {
						e.favoriteData = taken.favoriteData;
						e.normalizedValue = taken.normalizedValue;
						if (key === 'phone') {
							e.speedDial = taken.speedDial;
						}
						continue;
					}
					if (e.favoriteData === undefined) {
						e.favoriteData = {};
					}
					e.normalizedValue = key === 'phone' ? model.normalizePhoneNumber(e.value) : normalizeLower(e.value);
					if (key === 'phone' && e.speedDial === undefined) {
						e.speedDial = '';
					}
				}
			}
		}
	}

	async function saveContact(contact) {
		if (kindName(contact._kind) === 'com.palm.contact.sim') {
			await call(SIM_SERVICE + '/saveContact', {contact: shown(contact)});
			return;
		}
		delete contact._rev;
		const r = await db.merge([contact]);
		if (!r.length) {
			throw new Error('Contact save put - result length is zero');
		}
		contact._id = r[0].id;
		contact._rev = r[0].rev;
	}

	// Person.getDBObject() of a saved person: _kind, _id and _rev first.
	function personShown(person) {
		const rec = person.rec;
		const out = {_kind: rec._kind, _id: rec._id, _rev: rec._rev};
		for (const k of Object.keys(rec)) {
			if (out[k] === undefined) {
				out[k] = rec[k];
			}
		}
		return out;
	}

	return async function saveNewPersonAndContacts(params) {
		if (!params.person || typeof params.person !== 'object' || Array.isArray(params.person)) {
			throw new Error('Autolinker.saveNewPersonAndContacts: You must specify a person object to save.');
		}
		if (!Array.isArray(params.contacts)) {
			throw new Error('Autolinker.saveNewPersonAndContacts: You must specify an array of contacts to save.');
		}
		const person = persons.wrap(params.person);
		const contacts = params.contacts.map(c => takeIn(c && typeof c === 'object' ? c : {}));
		if (!contacts.length) {
			throw new Error('There must be contacts in the param to use _savePersonAttachingTheseContacts');
		}
		/*
			The contacts that have an _id first, in their order, then the others
			with reserved ids. The old code took the first out by splicing as it
			looped, which skipped the one after each: a contact with an _id
			right after another got a new id (README: Q7.5).
		*/
		const toSave = contacts.filter(c => c._id);
		const ids = toSave.map(c => c._id);
		const fresh = contacts.filter(c => !c._id);
		const reserved = await db.reserveIds(fresh.length);
		if (reserved.length !== fresh.length) {
			throw new Error('_savePersonAttachingTheseContacts failed because there were not enough reserved ids return to give to all the contacts');
		}
		fresh.forEach((c, i) => {
			c._id = reserved[i];
			ids.push(reserved[i]);
			toSave.push(c);
		});
		if (person.contacts.length === 0) {
			await persons.reloadContacts(person);
		}
		person.rec.contactIds = ids;
		const from = person.contacts.concat(fresh);
		await persons.fixup(person, {contacts: from, partial: true});
		markTaken(person, from);
		await persons.save(person);
		for (const c of toSave) {
			await saveContact(c);
		}
		return {saveResult: true, person: personShown(person), contacts: fresh.map(shown)};
	};
}

module.exports = {createSaveNew, takeIn, shown};
