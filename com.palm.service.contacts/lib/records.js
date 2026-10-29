// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	Contact, person and backup records as the contacts framework (loadable
	frameworks contacts 1.0) wrote them, without its property objects.

	The framework wrapped each field of a record in a property object with
	defaults for the fields it lacked. It filled in those defaults for a new
	record only, but every entry of an array field (an email, a phone
	number, a photo...) was made as a new one, so its defaults were filled
	in, on the stored entry itself: a contact that was saved was written
	with every entry complete. This file has those defaults and the ways
	they were applied.
*/

// The fields of each kind of entry, in the order the framework wrote them, with their defaults.
const FIELDS = {
	Account: {domain: '', userName: '', userid: ''},
	Address: {streetAddress: '', locality: '', postalCode: '', region: '', country: '', type: 'type_work', primary: false},
	ContactPhoto: {value: '', type: 'type_square', primary: false, localPath: ''},
	EmailAddress: {value: '', type: 'type_home', primary: false},
	IMAddress: {value: '', type: '', label: '', primary: false},
	Name: {givenName: '', middleName: '', familyName: '', honorificPrefix: '', honorificSuffix: ''},
	Organization: {name: '', department: '', title: '', type: '', startDate: '', endDate: '', location: null,
		description: ''},
	PhoneNumber: {value: '', type: '', primary: false},
	Relation: {value: '', type: '', primary: false},
	Url: {value: '', type: '', primary: false},
	SyncSource: {name: null, extended: null},
	DefaultPropertyHash: {value: null, type: null, favoriteData: null},
	SpeedDialHash: {hashedPhoneNumber: null, key: null}
};

// A contact's array fields and the kind of their entries (Tag entries are plain strings).
const CONTACT_ARRAYS = {
	accounts: 'Account', addresses: 'Address', emails: 'EmailAddress', ims: 'IMAddress',
	organizations: 'Organization', phoneNumbers: 'PhoneNumber', photos: 'ContactPhoto', tags: null,
	urls: 'Url', relations: 'Relation'
};

// The fields of a contact, in the order the framework wrote a new one.
const CONTACT_FIELDS = ['_kind', '_id', '_rev', '_del', 'remoteId', 'accounts', 'accountId', 'addresses',
	'anniversary', 'birthday', 'displayName', 'emails', 'gender', 'ims', 'name', 'nickname', 'note',
	'organizations', 'phoneNumbers', 'photos', 'syncSource', 'tags', 'urls', 'relations'];

const CONTACT_KIND = 'com.palm.contact:1';
const PERSON_KIND = 'com.palm.person:1';

function isObject(v) {
	return !!v && typeof v === 'object';
}

function clone(v) {
	return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/*
	The framework's refusal of an entry that is not an object for a kind with
	more than one field.
*/
function notAnObject(kind, value) {
	const first = Object.keys(FIELDS[kind])[0];
	return new Error('PropertyBase - Sanity check failed: argument passed is not an object and there is more than ' +
		'one field: field name: ' + first + ' OBJ: ' + JSON.stringify(value) + ' isPrimitiveType: false config length: ' +
		Object.keys(FIELDS[kind]).length);
}

/*
	entry(raw, kind): the entry as the framework wrote it - the stored entry,
	changed in place, with the defaults of the fields it lacks. A field that
	is null stays null. An organization's location is an address with its
	defaults too. Not an object: a new entry of defaults for a falsy one, and
	refused for any other.
*/
function entry(raw, kind) {
	const fields = FIELDS[kind];
	if (!isObject(raw)) {
		if (raw) {
			throw notAnObject(kind, raw);
		}
		raw = {};
	}
	for (const k of Object.keys(fields)) {
		if (raw[k] === undefined) {
			raw[k] = isObject(fields[k]) ? {} : fields[k];
		}
	}
	if (kind === 'Organization') {
		raw.location = entry(isObject(raw.location) ? raw.location : {}, 'Address');
	}
	if (kind === 'SyncSource' && raw.extended === null && fields.extended === null) {
		raw.extended = {};
	}
	return raw;
}

// A new entry of a kind: its defaults, then the fields given.
function newEntry(kind, values) {
	const out = entry({}, kind);
	return Object.assign(out, values || {});
}

/*
	The entries of an array field as the framework read them: an array's
	entries each made complete in place (falsy ones stay as they are, read
	as entries of defaults), a single object as one entry.
*/
function arrayInPlace(raw, prop, kind) {
	const v = raw[prop];
	if (v === undefined || v === null) {
		return;
	}
	if (Array.isArray(v)) {
		for (const e of v) {
			if (kind && e) {
				entry(e, kind);
			}
		}
	} else if (kind) {
		entry(v, kind);
	}
}

/*
	contactForMerge(raw): what Contact.save merged for a contact from db8:
	the stored record as read, every array entry complete, without its _rev.
	(The framework wrote an organization's location as its own Address
	object, internals and all; this writes the address. README.md says why.)
*/
function contactForMerge(raw) {
	const out = clone(raw);
	for (const prop of Object.keys(CONTACT_ARRAYS)) {
		arrayInPlace(out, prop, CONTACT_ARRAYS[prop]);
	}
	delete out._rev;
	return out;
}

/*
	A new contact as the framework made one (new Contact()), with its fields
	in their order: the given values over the defaults.
*/
function newContact(values) {
	const defaults = {
		_kind: CONTACT_KIND, accounts: [], accountId: '', addresses: [], anniversary: '', birthday: '',
		displayName: '', emails: [], gender: '', ims: [], name: newEntry('Name'), nickname: '', note: '',
		organizations: [], phoneNumbers: [], photos: [], syncSource: newEntry('SyncSource'), tags: [], urls: [],
		relations: []
	};
	const out = {};
	for (const k of CONTACT_FIELDS) {
		const v = Object.prototype.hasOwnProperty.call(values, k) ? values[k] : defaults[k];
		if (v !== undefined) {
			out[k] = v;
		}
	}
	return out;
}

/*
	A one-value field of a stored record as the framework read it: an
	object's value, any other truthy value as it is, and nothing (undefined)
	for a falsy one: a stored favorite:false read as no value at all.
*/
function single(v) {
	if (!v) {
		return undefined;
	}
	return isObject(v) ? v.value : v;
}

module.exports = {FIELDS, CONTACT_ARRAYS, CONTACT_FIELDS, CONTACT_KIND, PERSON_KIND, entry, newEntry, contactForMerge,
	newContact, single, clone, isObject};
