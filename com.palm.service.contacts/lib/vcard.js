// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	vCard files read into contacts and persons written out as vCards, as the
	contacts framework's VCardImporter and VCardExporter did it, line by
	line and quirk by quirk: the importer reads 3.0 and 2.1 alike, keys every
	line on its prefix (TEL, EMAIL, X-GTALK...) and takes the label from
	what comes before the first colon; the exporter writes vCard 3.0, or 2.1
	when asked (C6).
*/

const fs = require('fs');
const {newEntry, newContact, entry, single, isObject} = require('./records');

const MARKERS = {
	BEGIN: 'BEGIN:VCARD', END: 'END:VCARD', VERSION: 'VERSION', NICKNAME: 'NICKNAME', NAME: 'N', FULL_NAME: 'FN',
	COMPANY: 'ORG', JOBTITLE: 'TITLE', PHONE: 'TEL', EMAIL: 'EMAIL', ADDRESS: 'ADR', BIRTHDAY: 'BDAY', URL: 'URL',
	NOTE: 'NOTE', RELATED: 'X-ABRELATEDNAMES', GTALK: 'X-GTALK', GOOGLE: 'X-GTALK', AIM: 'X-AIM', MSN: 'X-MSN',
	YAHOO: 'X-YAHOO', JABBER: 'X-JABBER', QQ: 'X-QQ', ICQ: 'X-ICQ', SKYPE: 'X-SKYPE', IM: 'X-IM',
	SPOUSE_ONE_LINE: 'X-SPOUSE', CHILD_ONE_LINE: 'X-CHILD'
};
const SPOUSE_ONE_LINER = 'item1.X-ABLabel:_$!<SPOUSE>!$_';
const CHILD_ONE_LINER = 'item1.X-ABLabel:_$!<CHILD>!$_';
const PREFIX_REGEX = /^(item[0-9]*?.)?([A-Z-]+)[;|:].*/i;

// VCard.TYPES: [vCard value, the entry's type], in the framework's order; a null vCard value is the default.
const TYPES = {
	PHONE: [['FAX', undefined], ['FAX_HOME', 'type_personal_fax'], ['FAX_WORK', 'type_work_fax'], ['HOME', 'type_home'],
		['WORK', 'type_work'], ['CELL', 'type_mobile'], ['PAGER', 'type_pager'], ['MAIN', 'type_main'], [null, 'type_other']],
	EMAIL: [['HOME', 'type_home'], ['WORK', 'type_work'], [null, 'type_other']],
	URL: [['HOME', 'type_home'], ['WORK', 'type_work'], [null, 'type_other']],
	ADDRESS: [['HOME', 'type_home'], ['WORK', 'type_work'], [null, 'type_other']],
	RELATION: [['ASSISTANT', 'type_assistant'], ['BROTHER', 'type_brother'], ['CHILD', 'type_child'],
		['DOMESTIC_PARTNER', 'type_domestic_partner'], ['FATHER', 'type_father'], ['FRIEND', 'type_friend'],
		['MANAGER', 'type_manager'], ['MOTHER', 'type_mother'], ['PARENT', 'type_parent'], ['PARTNER', 'type_partner'],
		['REFERRED_BY', 'type_referred_by'], ['RELATIVE', 'type_relative'], ['SISTER', 'type_sister'],
		['SPOUSE', 'type_spouse'], [null, 'type_other']]
};
const RELATION_LABELS = ['ASSISTANT', 'BROTHER', 'CHILD', 'FATHER', 'FRIEND', 'MANAGER', 'MOTHER', 'PARENT', 'PARTNER',
	'RELATIVE', 'SISTER', 'SPOUSE', 'REFFERRED_BY', 'DOMESTIC_PARTNER'];

// VCard.IM_SERVICES: [key, vCard marker, service type, labels].
const IM_SERVICES = [
	['GTALK', 'X-GTALK', 'type_gtalk'], ['GOOGLE', 'X-GTALK', 'type_gtalk'], ['AIM', 'X-AIM', 'type_aim'],
	['MSN', 'X-MSN', 'type_msn'], ['YAHOO', 'X-YAHOO', 'type_yahoo'], ['JABBER', 'X-JABBER', 'type_jabber'],
	['QQ', 'X-QQ', 'type_qq'], ['ICQ', 'X-ICQ', 'type_icq'], ['SKYPE', 'X-SKYPE', 'type_skype'],
	['OTHER', undefined, 'type_default']
].map(([key, marker, type]) => ({key, marker, type, labels: [marker || 'X-IM']}));
const IM_TYPE_OF_MARKER = {
	'X-GTALK': 'type_gtalk', 'X-AIM': 'type_aim', 'X-MSN': 'type_msn', 'X-JABBER': 'type_jabber', 'X-YAHOO': 'type_yahoo',
	'X-ICQ': 'type_icq', 'X-QQ': 'type_qq', 'X-SKYPE': 'type_skype'
};

// The exporter's labels for each entry type (VCard.*_LABELS), in the framework's order.
const LABELS = {
	PHONE: [['type_home', ['HOME', 'VOICE']], ['type_work', ['WORK', 'VOICE']], ['type_mobile', ['CELL', 'VOICE']],
		['type_pager', ['PAGER']], ['type_personal_fax', ['HOME', 'FAX']], ['type_work_fax', ['WORK', 'FAX']],
		['type_other', ['OTHER']]],
	EMAIL: [['type_home', ['HOME', 'INTERNET']], ['type_work', ['WORK', 'INTERNET']], ['type_other', ['INTERNET']]],
	// The framework's table gave "HOME" the work type, so a work URL was labelled HOME and a home one had none (C7).
	URL: [['type_home', ['HOME']], ['type_work', ['WORK']], ['type_other', []]],
	ADDRESS: [['type_home', ['HOME']], ['type_work', ['WORK']], ['type_other', ['OTHER']]]
};

const NO_NAME = '[No Name Available]';

// StringUtils.escapeCommon (its parameter named as in Foundations, for the same TypeError on a non-string).
function escapeCommon(a, re, map) {
	return a.replace(re, m => map[m]);
}

// The exporter's test for a value it leaves out.
function bad(v) {
	return !v || v.length < 1;
}

function unescapeString(s) {
	return escapeCommon(s, /(\\\\)|(\\:)|(\\;)|(\\,)|(\\N)|(\\n)/g,
		{'\\\\': '\\', '\\:': ':', '\\;': ';', '\\,': ',', '\\N': '\n', '\\n': '\n'});
}

function escapeString(s) {
	return escapeCommon(s, /(\\)|(;)|(,)|(\n)|(\r)/g, {'\\': '\\\\', ';': '\\;', ',': '\\,', '\n': '\\n', '\r': '\\r'});
}

// VCardImporter._splitValues: split on the semicolons that are not escaped, then unescape each value.
function splitValues(s) {
	let values = [];
	if (/\\;/.test(s)) {
		let value = '';
		for (let i = 0; i < s.length; i += 1) {
			const ch = s.charAt(i);
			if (ch === ';') {
				const backslashes = value.match(/[\\]+$/);
				if (backslashes) {
					if ((backslashes[0].length % 2) === 0) {
						values.push(value);
						value = '';
					} else {
						value += ch;
					}
				} else {
					values.push(value);
					value = '';
				}
			} else {
				value += ch;
			}
		}
		if (value) {
			values.push(value);
		}
	} else {
		values = s.split(';');
	}
	return values.map(v => escapeCommon(v, /(\\\\)|(\\:)|(\\;)|(\\,)/g, {'\\\\': '\\', '\\:': ':', '\\;': ';', '\\,': ','}));
}

function lineValue(line) {
	return line.substring(line.indexOf(':') + 1).replace(/\r$/, '');
}

function isBegin(line) {
	return line.toUpperCase().indexOf(MARKERS.BEGIN) !== -1;
}

function isEnd(line) {
	return line.toUpperCase().indexOf(MARKERS.END) !== -1;
}

function prefixType(line) {
	const items = PREFIX_REGEX.exec(line);
	if (items && items.length > 2) {
		let type = items[2].toUpperCase();
		if (type === MARKERS.IM) {
			const values = splitValues(line);
			if (values.length > 1) {
				const t = values[1];
				if (t && IM_SERVICES.some(s => s.key === t) && MARKERS[t]) {
					type = MARKERS[t];
				}
			}
		}
		return type;
	}
	return undefined;
}

// What comes before the first colon, upper case.
function typeInfo(line) {
	const at = line.indexOf(':');
	return line.substring(0, at === -1 ? undefined : at).toUpperCase();
}

function extractLabel(line) {
	const t = typeInfo(line);
	if (t.indexOf('FAX') !== -1) {
		return t.indexOf('HOME') !== -1 ? 'FAX_HOME' : 'FAX_WORK';
	}
	for (const l of ['WORK', 'HOME', 'CELL', 'PAGER', 'MAIN']) {
		if (t.indexOf(l) !== -1) {
			return l;
		}
	}
	return 'OTHER';
}

function extractRelationLabel(line) {
	const v = lineValue(line);
	const t = v ? v.toUpperCase() : '';
	return RELATION_LABELS.find(l => t.indexOf(l) !== -1) || 'OTHER';
}

// _mapVCardValueToContactPointType, then _setThisTypeIfUndefined with the table's own default.
function mapType(label, table, fallback) {
	let def;
	for (const [vcard, type] of table) {
		if (vcard && vcard === label) {
			return type || fallback;
		} else if (!vcard && !def) {
			def = type;
		}
	}
	return def || fallback;
}

// VCardFileReader: the file's lines, with one line of look-ahead.
function reader(path) {
	const lines = fs.readFileSync(path, 'utf8').split('\n');
	let current = 0;
	let peeked = '';
	const next = () => (current < lines.length ? lines[current++] : null);
	return {
		readLine() {
			if (peeked) {
				const l = peeked;
				peeked = undefined;
				return l;
			}
			return next();
		},
		peek() {
			if (!peeked) {
				peeked = next();
			}
			return peeked;
		}
	};
}

// The contact the importer is building: new Contact() and what the lines set.
function blankContact() {
	return {values: {}, saved: false};
}

function arrayOf(c, field) {
	if (!c.values[field]) {
		c.values[field] = [];
	}
	return c.values[field];
}

function handleRelation(nameLine, typeLine) {
	const name = nameLine ? unescapeString(lineValue(nameLine)) : undefined;
	const type = typeLine ? mapType(extractRelationLabel(typeLine), TYPES.RELATION, 'type_other') : undefined;
	if (name && type) {
		return {value: name, type, primary: false};
	}
	return undefined;
}

function add(c, field, value) {
	if (value === undefined) {
		throw new Error('add obj is not defined');
	}
	arrayOf(c, field).push(value);
}

function handleAddress(line) {
	const a = newEntry('Address');
	let poBox = '', street = '', extended = '';
	unescapeString(lineValue(line)).split(';').forEach((part, i) => {
		switch (i) {
		case 0:
			poBox = part;
			break;
		case 1:
			extended = part.replace(/\\n/g, '\n').replace(/\\,/g, ',');
			break;
		case 2:
			street = part;
			break;
		case 3:
			a.locality = part;
			break;
		case 4:
			a.region = part;
			break;
		case 5:
			a.postalCode = part;
			break;
		case 6:
			a.country = part;
			break;
		}
	});
	poBox = poBox && (street || extended) ? poBox + ', ' : poBox;
	street = street && extended ? street + ', ' : street;
	a.streetAddress = poBox + street + extended;
	a.type = mapType(extractLabel(line), TYPES.ADDRESS, 'type_other');
	return a;
}

function handleBirthday(line) {
	let v = lineValue(line);
	if (v.length < 8) {
		return undefined;
	}
	if (v.length === 8) {
		v = v.substring(0, 4) + '-' + v.substring(4, 6) + '-' + v.substring(6, 8);
	} else if (v.length > 10) {
		return undefined;
	}
	return v;
}

function organization(c) {
	const orgs = arrayOf(c, 'organizations');
	if (!orgs[0]) {
		orgs.push(newEntry('Organization'));
	}
	return orgs[0];
}

// VCardImporter._handleLine.
function handleLine(c, line, file) {
	const type = prefixType(line);
	if (!type) {
		return;
	}
	const im = marker => ({value: unescapeString(lineValue(line)), type: IM_TYPE_OF_MARKER[marker] || 'type_default',
		label: '', primary: false});
	switch (type) {
	case MARKERS.NAME: {
		const pieces = splitValues(lineValue(line));
		c.values.name = newEntry('Name', {familyName: pieces[0] || '', givenName: pieces[1] || '',
			middleName: pieces[2] || '', honorificPrefix: pieces[3] || '', honorificSuffix: pieces[4] || ''});
		break;
	}
	case MARKERS.NICKNAME:
		c.values.nickname = unescapeString(lineValue(line));
		break;
	case MARKERS.COMPANY: {
		const name = splitValues(lineValue(line))[0];
		organization(c).name = name ? name : '';
		break;
	}
	case MARKERS.JOBTITLE: {
		const title = unescapeString(lineValue(line));
		organization(c).title = title ? title : '';
		break;
	}
	case MARKERS.PHONE:
		add(c, 'phoneNumbers', {value: unescapeString(lineValue(line)),
			type: mapType(extractLabel(line), TYPES.PHONE, 'type_other'), primary: false});
		break;
	case MARKERS.EMAIL:
		add(c, 'emails', {value: unescapeString(lineValue(line)),
			type: mapType(extractLabel(line), TYPES.EMAIL, 'type_other'), primary: false});
		break;
	case MARKERS.ADDRESS:
		add(c, 'addresses', handleAddress(line));
		break;
	case MARKERS.BIRTHDAY:
		c.values.birthday = handleBirthday(line);
		break;
	case MARKERS.URL:
		add(c, 'urls', {value: unescapeString(lineValue(line)),
			type: mapType(extractLabel(line), TYPES.URL, 'type_other'), primary: false});
		break;
	case MARKERS.RELATED: {
		// The relation's type is on the next line; one that ends the card is not taken.
		const next = file.peek();
		if (next.toUpperCase().indexOf(MARKERS.END) !== -1) {
			return;
		}
		add(c, 'relations', handleRelation(line, file.readLine()));
		break;
	}
	case MARKERS.SPOUSE_ONE_LINE:
		add(c, 'relations', handleRelation(line, SPOUSE_ONE_LINER));
		break;
	case MARKERS.CHILD_ONE_LINE:
		add(c, 'relations', handleRelation(line, CHILD_ONE_LINER));
		break;
	case MARKERS.GTALK:
	case MARKERS.AIM:
	case MARKERS.MSN:
	case MARKERS.YAHOO:
	case MARKERS.JABBER:
	case MARKERS.QQ:
	case MARKERS.ICQ:
	case MARKERS.SKYPE:
		add(c, 'ims', im(type));
		break;
	case MARKERS.IM:
		add(c, 'ims', im('type_default'));
		break;
	case MARKERS.NOTE:
		c.values.note = unescapeString(lineValue(line));
		break;
	}
}

// The contact as getDBObject() gave it.
function record(c) {
	return newContact(Object.assign({}, c.values, c.kind ? {_kind: c.kind} : {}, c.accountId !== undefined ?
		{accountId: c.accountId} : {}, c.id ? {_id: c.id} : {}));
}

/*
	VCardImporter._importVCard: the cards one at a time, each read up to
	its END line. save(contact) writes one, when importing. -> the
	contacts read, in order (a card ended twice is there twice).

	A card that cannot be read, or a save that fails, fails the import.
	(The old importer's chain of futures failed only for the first card,
	and waited for good on a later one or on a failed save, so the command
	answered only when it timed out: README.md, C2.)
*/
async function importCards(path, save, {openError = false} = {}) {
	let file;
	try {
		file = reader(path);
	} catch (e) {
		if (openError) {
			throw e;
		}
		// The importer's failure to open the file went nowhere; it then read from no reader at all.
		throw new TypeError('Cannot read properties of null (reading \'readLine\')');
	}
	const all = [];
	let current = null;
	for (;;) {
		let ended = false;
		let line = file.readLine();
		while (line !== null) {
			if (isBegin(line)) {
				current = blankContact();
				line = file.readLine();
				continue;
			}
			if (isEnd(line)) {
				ended = true;
				break;
			}
			if (!current) {
				current = blankContact();
			}
			handleLine(current, line, file);
			line = file.readLine();
		}
		if (ended && save && !current) {
			throw new TypeError('Cannot read properties of null (reading \'setKind\')');
		}
		if (!ended) {
			return all;
		}
		if (save) {
			await save(current);
		} else if (current) {
			all.push(current);
		}
	}
}

// VCardImporter.countContacts.
function countContacts(path) {
	if (!fs.readFileSync(path, 'utf8')) {
		throw new Error('File to count vCards does not exist');
	}
	const file = reader(path);
	let count = 0;
	for (let line = file.readLine(); line !== null; line = file.readLine()) {
		if (isBegin(line)) {
			count += 1;
		}
	}
	return count;
}

async function readVCard(path) {
	if (!path) {
		throw new Error('File path must be specified to make a VCardImporter');
	}
	const contacts = await importCards(path, null);
	// The same card ended twice is the same contact twice, as it last was.
	return contacts.map(record);
}

/*
	The exporter's view of a person from db8 (new Person(raw)): its fields
	as stored, its array fields' entries complete.
*/
function personView(raw) {
	const lst = v => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
	const entries = (v, kind) => lst(v).map(e => entry(e, kind));
	return {
		name: isObject(raw.name) ? raw.name : {},
		nickname: single(raw.nickname),
		organization: isObject(raw.organization) ? raw.organization : {},
		phoneNumbers: entries(raw.phoneNumbers, 'PhoneNumber'),
		emails: entries(raw.emails, 'EmailAddress'),
		ims: entries(raw.ims, 'IMAddress'),
		addresses: entries(raw.addresses, 'Address'),
		urls: entries(raw.urls, 'Url'),
		relations: entries(raw.relations, 'Relation'),
		birthday: single(raw.birthday),
		notes: lst(raw.notes).map(n => (n ? (isObject(n) ? n.value : n) : ''))
	};
}

function labelsFor(table, type) {
	const other = (table.find(([t]) => t === 'type_other') || [null, []])[1];
	if (!type) {
		return other;
	}
	for (const [t, labels] of table) {
		if (t === type) {
			return t === 'type_other' ? other : labels;
		}
	}
	return other;
}

// _buildCorrectLabelBasedOnVersion: TYPE=A,B for 3.0, A;B for 2.1.
function typeLabel(labels, v21) {
	return v21 ? labels.join(';') : 'TYPE=' + labels.join(',');
}

function createExporter({model}) {
	// Utils.generateDisplayName for a person.
	function displayName(p) {
		const full = model.fullName(p.name);
		if (full) {
			return full;
		}
		if (p.nickname) {
			return p.nickname;
		}
		const org = p.organization;
		if (org.title && org.name) {
			return org.title + ', ' + org.name;
		} else if (!org.title && org.name) {
			return org.name;
		} else if (org.title && !org.name) {
			return org.title;
		}
		if (p.emails.length) {
			return p.emails[0].value;
		} else if (p.ims.length) {
			return p.ims[0].value;
		} else if (p.phoneNumbers.length) {
			return model.formatPhoneNumber(p.phoneNumbers[0].value);
		}
		return NO_NAME;
	}

	/*
		VCardExporter._exportVCard: the lines of one person, or none. version
		'2.1' writes a 2.1 card (its labels A;B, and CHARSET=UTF-8 on the
		name, full name and numbers unless charset is another); any other a
		3.0 card.
	*/
	function vcard(raw, onlyPhoneNumbers, {version, charset} = {}) {
		const v21 = version === '2.1';
		const cs = v21 && (charset || 'UTF-8') === 'UTF-8' ? ';CHARSET=UTF-8' : '';
		const p = personView(raw);
		const out = [];
		if (onlyPhoneNumbers && p.phoneNumbers.length < 1) {
			return out;
		}
		let name = p.name;
		if (!name.givenName && !name.familyName) {
			name = newEntry('Name', {familyName: displayName(p)});
		}
		out.push(MARKERS.BEGIN + '\r');
		out.push(MARKERS.VERSION + (v21 ? ':2.1\r' : ':3.0\r'));
		const part = v => (v ? escapeString(v) : '');
		out.push('N' + cs + ':' + part(name.familyName) + ';' + part(name.givenName) + ';' + part(name.middleName) + ';' +
			part(name.honorificPrefix) + ';' + part(name.honorificSuffix) + '\r');
		const shown = displayName(p);
		if (!bad(shown)) {
			out.push('FN' + cs + ':' + escapeString(shown) + '\r');
		}
		if (!onlyPhoneNumbers) {
			const org = p.organization;
			if (org.name || org.title) {
				if (org.name) {
					out.push('ORG:' + escapeString(org.name) + ';\r');
				}
				if (org.title) {
					out.push('TITLE:' + escapeString(org.title) + '\r');
				}
			}
			if (!bad(p.nickname)) {
				out.push('NICKNAME:' + escapeString(p.nickname) + '\r');
			}
		}
		for (const n of p.phoneNumbers) {
			let value = n.value;
			if (onlyPhoneNumbers) {
				// PhoneNumber.unformatForVCard
				let kept = '';
				value.replace(/[0123456789+*wpt#]/gi, ch => {
					kept += ch;
				});
				value = kept;
			}
			if (!value) {
				continue;
			}
			const label = typeLabel(labelsFor(LABELS.PHONE, n.type), v21);
			out.push('TEL' + cs + (label.length > 0 ? ';' + label : '') + ':' + escapeString(value) + '\r');
		}
		if (!onlyPhoneNumbers) {
			for (const e of p.emails) {
				if (!bad(e.value)) {
					out.push('EMAIL;' + typeLabel(labelsFor(LABELS.EMAIL, e.type), v21) + ':' + escapeString(e.value) + '\r');
				}
			}
			for (const a of p.addresses) {
				const formatted = (a.streetAddress ? escapeString(a.streetAddress.replace(/\n/g, ' ')) : '') + ';' +
					part(a.locality) + ';' + part(a.region) + ';' + part(a.postalCode) + ';' + part(a.country);
				out.push('ADR;' + typeLabel(labelsFor(LABELS.ADDRESS, a.type), v21) + ':;;' + formatted + '\r');
			}
			for (const u of p.urls) {
				if (!bad(u.value)) {
					// No label, no TYPE= (C7: "URL;TYPE=:").
					const labels = labelsFor(LABELS.URL, u.type);
					out.push('URL' + (labels.length ? ';' + typeLabel(labels, v21) : '') + ':' + escapeString(u.value) + '\r');
				}
			}
			for (const i of p.ims) {
				if (!bad(i.value)) {
					const service = IM_SERVICES.find(s => s.type === i.type);
					const labels = !i.type || !service ? ['X-IM'] : service.labels;
					out.push(labels + ':' + escapeString(i.value) + '\r');
				}
			}
			for (const r of p.relations) {
				if (!r.value && !r.type) {
					continue;
				}
				if (r.type === 'type_spouse') {
					out.push(MARKERS.SPOUSE_ONE_LINE + ':' + escapeString(r.value) + '\r');
				} else if (r.type === 'type_child') {
					out.push(MARKERS.CHILD_ONE_LINE + ':' + escapeString(r.value) + '\r');
				}
			}
			if (!bad(p.birthday)) {
				out.push('BDAY:' + p.birthday + '\r');
			}
			if (p.notes.length) {
				const note = p.notes[0];
				if (!bad(note)) {
					out.push('NOTE:' + escapeString(note) + '\r');
				}
			}
		}
		out.push(MARKERS.END + '\r\n\r');
		return out;
	}

	return {vcard, displayName};
}

// What VCardFileWriter.close wrote: the lines, each ended with "\n".
function fileText(lines) {
	return lines.map(l => l + '\n').join('');
}

// VCardFileWriter.getSize: the length in UTF-8 bytes, as encodeURIComponent counts them.
function byteSize(text) {
	return encodeURIComponent(text).replace(/%[A-F\d]{2}/g, 'U').length;
}

module.exports = {readVCard, importCards, countContacts, record, createExporter, fileText, byteSize, escapeString,
	unescapeString, splitValues, prefixType, extractLabel, mapType, TYPES, NO_NAME};
