// Copyright (c) 2026 Herman van Hazendonk
// Derived from the contacts framework's Contact.js, Person.js,
// PropertyArray.js and properties/, Copyright (c) 2009-2013 LG Electronics,
// Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	Contacts and persons as plain db8 records, with the rules of the contacts
	framework (loadable-frameworks contacts 1.0) that decide what a person
	record holds. The framework wrapped every field in a property object;
	these functions give the same records without them:

	- an entry of a contact's array (an email, a phone number...) reads with
	  its kind's defaults filled in for the fields it lacks: PropertyArray
	  built its elements without passing on that they came from the database
	- a single field of a contact (its name, nickname, note...) reads as
	  stored: no defaults for a contact that has an _id
	- a person's emails, phone numbers and IMs are new "extended" entries:
	  the contact's entry with defaults, favoriteData {}, a speedDial "" for
	  a phone number, and a normalizedValue worked out again
	- a person's names, addresses, urls and relations are the contacts' own
	  entries, as stored
*/

const DEFAULTS = {
	email: {value: '', type: 'type_home', primary: false},
	phone: {value: '', type: '', primary: false},
	im: {value: '', type: '', label: '', primary: false},
	address: {streetAddress: '', locality: '', postalCode: '', region: '', country: '', type: 'type_work', primary: false},
	url: {value: '', type: '', primary: false},
	relation: {value: '', type: '', primary: false},
	photo: {value: '', type: 'type_square', primary: false, localPath: ''},
	organization: {name: '', department: '', title: '', type: '', startDate: '', endDate: '', location: {}, description: ''},
	name: {givenName: '', middleName: '', familyName: '', honorificPrefix: '', honorificSuffix: ''},
	photos: {bigPhotoPath: '', squarePhotoPath: '', listPhotoPath: '', listPhotoSource: '', bigPhotoId: '',
		squarePhotoId: '', contactId: '', accountId: ''},
	ringtone: {name: '', location: ''}
};

const NAME_FIELDS = Object.keys(DEFAULTS.name);
const NO_NAME = '[No Name Available]';

// Sync sources in the order a merged person's contacts are listed in (lower first); others are 5.
const SYNC_SOURCE_PRIORITY = {
	'com.palm.contact.linkedin': 1,
	'com.palm.contact.facebook': 2,
	'com.palm.contact.eas': 3,
	'com.palm.contact.palmprofile': 4,
	'com.palm.contact.google': 6,
	'com.palm.contact.yahoo': 7,
	'com.palm.contact.sim': 8,
	'com.palm.contact.attaddresssync': 9,
	'com.palm.contact.skype': 10,
	'com.palm.contact.libpurple': 11,
	'com.palm.contact.imyahoo': 12
};
const THIRD_PARTY_PRIORITY = 5;

// The entry with defaults for the fields it does not have (a field that is null stays null).
function withDefaults(raw, defaults) {
	const out = Object.assign({}, raw && typeof raw === 'object' ? raw : {});
	for (const k of Object.keys(defaults)) {
		if (out[k] === undefined) {
			out[k] = defaults[k] && typeof defaults[k] === 'object' ? {} : defaults[k];
		}
	}
	return out;
}

function address(raw) {
	return withDefaults(raw, DEFAULTS.address);
}

function organization(raw) {
	const org = withDefaults(raw, DEFAULTS.organization);
	org.location = address(raw && raw.location);
	return org;
}

// The entry it was made from, kept on a copy (not enumerable: it is not written to db8).
function fromSource(copy, source) {
	if (source && typeof source === 'object') {
		Object.defineProperty(copy, 'source', {value: source.source || source, configurable: true});
	}
	return copy;
}

// A contact's array field, its entries with their defaults.
function entries(contact, prop, defaults) {
	const list = contact[prop];
	if (!Array.isArray(list)) {
		return list && typeof list === 'object' ? [fromSource(withDefaults(list, defaults), list)] : [];
	}
	return list.map(e => fromSource(withDefaults(e, defaults), e));
}

// A one-value field as the framework read it: a string, or an object with a value.
function single(v) {
	if (!v) {
		return undefined;
	}
	return typeof v === 'object' ? v.value : v;
}

function fromDB(contact) {
	return !!contact._id;
}

// A contact's name: the stored fields, with "" for missing ones unless the contact is from db8.
function contactName(contact) {
	const raw = contact.name && typeof contact.name === 'object' ? contact.name : {};
	return fromDB(contact) ? raw : withDefaults(raw, DEFAULTS.name);
}

function normalizeLower(v) {
	return typeof v === 'string' && v ? v.toLowerCase().trim() : '';
}

// The kind without its version.
function kindName(kind) {
	return String(kind || '').split(':')[0];
}

function syncSourcePriority(contact) {
	const p = SYNC_SOURCE_PRIORITY[kindName(contact._kind)];
	return p === undefined ? THIRD_PARTY_PRIORITY : p;
}

/*
	createModel({G, P, phoneRegion}): the rules that need Globalization (G)
	and phonenumberlib (P).
*/
// Values normalizePhoneNumber remembers before it starts again.
const NORMALIZED_MAX = 20000;

function createModel({G, P, phoneRegion = 'us'}) {
	const region = phoneRegion.toUpperCase();
	/*
		normalizePhoneNumber's results by value. A phone search compares the
		numbers of every person it finds, so a person with many numbers had
		them parsed again for each contact linked to it; on 300 contacts made
		to look alike, the parse was 63% of the run.
	*/
	const normalized = new Map();

	function fullName(name) {
		name = name || {};
		return G.Name.formatPersonalName({
			prefix: name.honorificPrefix,
			givenName: name.givenName,
			middleName: name.middleName,
			familyName: name.familyName,
			suffix: name.honorificSuffix
		}, G.Name.longName);
	}

	/*
		The contacts framework's normalised phone number, as LuneOS has it:
		phonenumberlib's parse, "+-<cc>-<leading digits>-<rest>-" reversed;
		the search form only "-<rest>-" reversed. A value that is neither a
		string nor an object is refused, as the framework's Assert refused it.
	*/
	function normalizePhoneNumber(value, wantSearchFormat) {
		if (typeof value === 'string') {
			const key = (wantSearchFormat ? 's' : 'n') + value;
			let n = normalized.get(key);
			if (n === undefined) {
				if (normalized.size >= NORMALIZED_MAX) {
					normalized.clear();
				}
				n = normalizeParsed(P.Parse(value, region), value, wantSearchFormat);
				normalized.set(key, n);
			}
			return n;
		}
		if (value && typeof value === 'object') {
			return normalizeParsed(undefined, value.subscriberNumber, wantSearchFormat);
		}
		throw new Error('PhoneNumber.normalizePhoneNumber - number passed is not a string or an object');
	}

	/*
		The key a phone number is looked up by, here (rankers.js, "similar
		mobile number") and in the contacts service's findPersonByPhone: the
		search form without its closing "-", "-<the number's digits,
		reversed>", which finds the persons with a number whose normalised
		value starts with it, as the phone app looks up a caller. 408-555-1234
		is stored as "-4321555804--1-+" and looked up as "-4321555804". The
		old service looked it up by Globalization's subscriber number,
		"-4321555-", which is not a prefix of what phonenumberlib stores, so
		10-digit US numbers and NL mobile numbers never found anyone (README:
		Q7.15). null for a value with no digits, which is not looked up.
	*/
	function phoneLookupKey(value) {
		if (typeof value !== 'string') {
			return null;
		}
		const key = normalizePhoneNumber(value, true).slice(0, -1);
		return /^-\d+$/.test(key) ? key : null;
	}

	function normalizeParsed(parsed, value, wantSearchFormat) {
		let n = '';
		if (!parsed) {
			if (!wantSearchFormat) {
				n = '--';
			}
			n += '-' + value + '-';
		} else {
			if (!wantSearchFormat) {
				n = '+-' + parsed.regionMetaData.countryCode + '-' + parsed.leadingDigit;
			}
			n += '-' + parsed.nationalNumber.substr(parsed.leadingDigit.length) + '-';
		}
		return n.split('').reverse().join('');
	}

	function formatPhoneNumber(value) {
		return value ? G.Phone.reformat(value) : value;
	}

	// The key each kind of contact point is deduplicated on in a person (falsy keys are dropped).
	const keys = {
		name: n => normalizeLower(n.givenName) + ':(|)' + normalizeLower(n.familyName),
		email: e => normalizeLower(e.value),
		phone: p => normalizePhoneNumber(p.value, true),
		im: i => normalizeLower(i.value) + ':(|)' + i.type,
		address: a => (a.streetAddress + a.locality + a.postalCode + a.region + a.country + a.type).toUpperCase()
			.replace(/\W/g, ''),
		url: u => u.value.toLowerCase(),
		relation: r => r.value + ':(|)' + r.type,
		note: n => n.toUpperCase()
	};

	function dedupe(seen, list, key) {
		const out = [];
		for (const item of list) {
			const k = key ? key(item) : item;
			if (k && !seen[k]) {
				seen[k] = true;
				out.push(item);
			}
		}
		return out;
	}

	// The organization a contact gives its person: the first, unless a later one is better.
	function bestOrganization(contact) {
		let best = null;
		for (const org of entries(contact, 'organizations', DEFAULTS.organization).map(organization)) {
			if (!best) {
				best = org;
				if (best.name && best.title) {
					break;
				}
			} else if ((org.name && org.title) || (!best.name && org.name) || (!best.name && !best.title && org.title)) {
				best = org;
			}
		}
		return best;
	}

	function searchTerms(contact) {
		const name = contactName(contact);
		let given = name.givenName, family = name.familyName;
		if (!given || !family) {
			return [];
		}
		given = given.toLowerCase();
		family = family.toLowerCase();
		return given && family ? [given.substring(0, 1) + family, family + given] : [];
	}

	function emailEntry(e) {
		const out = withDefaults(e, Object.assign({}, DEFAULTS.email, {favoriteData: {}}));
		out.normalizedValue = normalizeLower(out.value);
		return fromSource(out, e);
	}

	function phoneEntry(p) {
		const out = withDefaults(p, Object.assign({}, DEFAULTS.phone, {favoriteData: {}}));
		out.normalizedValue = normalizePhoneNumber(out.value);
		if (out.speedDial === undefined) {
			out.speedDial = '';
		}
		return fromSource(out, p);
	}

	function imEntry(i) {
		const out = withDefaults(i, Object.assign({}, DEFAULTS.im, {favoriteData: {}}));
		out.normalizedValue = normalizeLower(out.value);
		return fromSource(out, i);
	}

	/*
		What a person shows as its name when it has none (Utils.generateDisplayName):
		the full name, the nickname, title and company, the first email, IM or
		phone number, and else "[No Name Available]".
	*/
	function displayName(person) {
		const full = fullName(person.name);
		if (full) {
			return full;
		}
		if (person.nickname) {
			return person.nickname;
		}
		const org = person.organization || {};
		if (org.title && org.name) {
			return org.title + ', ' + org.name;
		}
		if (!org.title && org.name) {
			return org.name;
		}
		if (org.title && !org.name) {
			return org.title;
		}
		if (person.emails.length) {
			return person.emails[0].value;
		}
		if (person.ims.length) {
			return person.ims[0].value;
		}
		if (person.phoneNumbers.length) {
			return formatPhoneNumber(person.phoneNumbers[0].value);
		}
		return NO_NAME;
	}

	const SORT_DEFAULT = '𧻓';

	// SortKey._generateSortKeyHelper, with the family name through Globalization's sort name.
	function sortKey(person, listSortOrder) {
		const name = person.name || {};
		let given = name.givenName || '';
		let family = G.Name.getSortName(name.familyName || '');
		let company = (person.organization && person.organization.name) || '';
		let display = displayName(person) || '';
		given = (given || '').trim();
		family = (family || '').trim();
		company = company.trim();
		display = display.trim();
		const byCompany = listSortOrder === 'COMPANY_LAST_FIRST' || listSortOrder === 'COMPANY_FIRST_LAST';
		const firstLast = listSortOrder === 'COMPANY_FIRST_LAST' || listSortOrder === 'FIRST_LAST';
		let key = '';
		if (byCompany) {
			key += (company || SORT_DEFAULT + SORT_DEFAULT) + '\t';
		}
		if (given || family) {
			if (firstLast) {
				key += given ? given + '\t' : '';
				key += family ? family + '\t' : '';
			} else {
				key += family ? family + '\t' : '';
				key += given ? given + '\t' : '';
			}
		} else {
			key += display + '\t';
		}
		key = key.trim();
		if (key) {
			const first = key.charAt(0);
			if (first !== SORT_DEFAULT && first !== '\t' && !G.Character.isLetter(first)) {
				key = SORT_DEFAULT + key;
			}
		} else {
			key = SORT_DEFAULT + SORT_DEFAULT;
		}
		return key.toLocaleLowerCase().trim();
	}

	return {fullName, normalizePhoneNumber, phoneLookupKey, formatPhoneNumber, keys, dedupe, bestOrganization,
		searchTerms, emailEntry, phoneEntry, imEntry, displayName, sortKey};
}

module.exports = {createModel, DEFAULTS, NAME_FIELDS, withDefaults, entries, single, contactName, organization,
	address, normalizeLower, kindName, syncSourcePriority, fromDB};
