// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The bus methods of com.palm.service.contacts, answering as the
	mojoservice service answered (mojo.js), errors and all. README.md lists
	what the old service got wrong; until a commit after this one says
	otherwise, this one gets it wrong in the same way.

	preBackup               the Palm Profile contacts' photos, for the backup service
	countVCardContacts      {filePath: "file://..."} -> {count}
	readVCard               {filePath} -> {contacts}
	importVCard             {filePath}: the cards saved to the default account
	vCardExportOne          {filePath, personId, onlyPhoneNumbers, useFileCache}
	vCardExportAll          {filePath, onlyPhoneNumbers}
	favoritePerson          {personId, defaultData}
	setFavoriteDefault      {personId, defaultData: {value, contactPointType, type, listIndex, auxData, appId}}
	unfavoritePerson        {personId}
	setCroppedContactPhoto  {personId, path, cropInfo, photoType}
	refetchPhoto            {contactId, photoId}
	findPersonByPhone       {phoneNumber, params: {returnAllMatches, includeMatchingItem, mcc}}
	sortOrderChanged        the sort-order watch's callback: every person's sortKey again
	SetUpWatch              creates that watch
	deleteContactImage      {path}
	updatePersonLocaleAll   {locale}: every phone number normalised again for that region
*/

const fs = require('fs');
const mojo = require('./mojo');
const {isObject, entry, clone, PERSON_KIND, CONTACT_KIND} = require('./records');
const vcard = require('./vcard');
const {SUPPORTED_FAVORITE_TYPES} = require('./person');
const {KIND: PREFS_KIND, PREF} = require('./prefs');

const SERVICE = 'com.palm.service.contacts';
const VERSION = '1.0';
const ACCOUNTS = 'luna://com.palm.service.accounts';
const AM = 'luna://com.palm.activitymanager';
const FILECACHE = 'luna://com.palm.filecache';
const SIM = 'luna://com.palm.service.contacts.sim';
const FILE_SCHEMA = 'file://';
const PALM_PROFILE = 'com.palm.palmprofile';
const DEFAULT_APP = 'com.palm.app.phone';
const SORT_DEFAULT = '𧻓';
const NO_NAME = '[No Name Available]';
const LONG_TIMEOUT_S = 3600;
const TIMEOUTS = {readVCard: 3600, importVCard: 3600, vCardExportAll: 3600, sortOrderChanged: 3600,
	updatePersonLocaleAll: 1800};

const NAMES = ['preBackup', 'countVCardContacts', 'readVCard', 'importVCard', 'vCardExportAll', 'vCardExportOne',
	'favoritePerson', 'setFavoriteDefault', 'setCroppedContactPhoto', 'unfavoritePerson', 'findPersonByPhone',
	'sortOrderChanged', 'deleteContactImage', 'SetUpWatch', 'refetchPhoto', 'updatePersonLocaleAll'];

// Foundations' Assert: a plain Error with the message.
function require_(ok, message) {
	if (!ok) {
		throw new Error(message);
	}
}

function requireString(v, message) {
	require_(typeof v === 'string' || v instanceof String, message);
}

// What never settles: a chain of futures the old code left without a result.
function never() {
	return new Promise(() => {});
}

// ContactsServiceAssistant.getPathFromFileTypeSchemaPath.
function localPath(filePath) {
	requireString(filePath, 'getPathFromFileTypeSchemaPath did not specify a filePath for the vcard to count');
	require_(filePath.indexOf(FILE_SCHEMA) === 0, 'getPathFromFileTypeSchemaPath did not specify a target to a local file');
	return filePath.substr(FILE_SCHEMA.length);
}

// The service's getApplicationId: the caller's appId in defaultData, else the phone app's.
function applicationId(args) {
	return args.defaultData && args.defaultData.appId ? args.defaultData.appId : DEFAULT_APP;
}

function list(v) {
	if (Array.isArray(v)) {
		return v;
	}
	return v === undefined || v === null ? [] : [v];
}

/*
	BatchDBWriter: writes of one property each, gathered per record and
	merged in batches of bufferCommitSize records; a write of the value a
	record already has is dropped (by ===, or by its JSON with deep). The
	merges are not waited for, as BatchDBWriter did not wait for them.
*/
function batchWriter(db, log, {deep = false, size = 500} = {}) {
	let writes = null;
	let count = 0;
	function commit() {
		if (!writes) {
			return;
		}
		const objects = Object.keys(writes).map(id => writes[id]);
		if (objects.length > 0) {
			db.merge(objects).catch(e => log.error(SERVICE + ': commitBatchedWrites failed: ' + ((e && e.message) || e)));
		}
		writes = null;
		count = 0;
	}
	function write(obj, prop, val) {
		if (val === undefined) {
			val = null;
		}
		let old = obj[prop];
		if (old === undefined) {
			old = null;
		}
		if (deep ? JSON.stringify(old) === JSON.stringify(val) : old === val) {
			return;
		}
		obj[prop] = val;
		const id = obj._id;
		if (writes && !writes[id] && count > size - 1) {
			commit();
		}
		count += 1;
		writes = writes || {};
		writes[id] = writes[id] || {_id: id};
		writes[id][prop] = val;
	}
	return {write, commit};
}

function createCommands({db, call, persons, photos, prefs, model, G, log = console, timeoutsS = {}}) {
	const exporter = vcard.createExporter({model});

	// ---- backup

	async function preBackup() {
		const r = await call(ACCOUNTS + '/listAccounts', {templateId: PALM_PROFILE});
		const account = r.results[0];
		require_(account !== undefined, 'ContactsService.photoPreBackup - There were no palm profile accounts in the account list');
		// Contact.getContactsByAccountId: one page of them.
		requireString(account._id, 'Contact.getContactsByAccountId requires an accountId that is a valid string');
		const found = await db.findPage({from: CONTACT_KIND, where: [{prop: 'accountId', op: '=', val: account._id}]});
		const files = [];
		for (const contact of found.results) {
			// The original photo, not the cached copy: it can be cropped again after a restore.
			for (const p of list(contact.photos)) {
				files.push(entry(p, 'ContactPhoto').value);
			}
		}
		return {version: VERSION, description: 'Backup of ' + files.length + ' palm profile contact photos.', files,
			ignoreMissingFiles: true};
	}

	// ---- vCards

	async function countVCardContacts(params) {
		requireString(params.filePath, 'vCardCountContacts did not specify a filePath for the vcard to count');
		return {count: vcard.countContacts(localPath(params.filePath))};
	}

	async function readVCard(params) {
		requireString(params.filePath, 'readVCard did not specify a filePath for the vcard to read');
		return {contacts: await vcard.readVCard(localPath(params.filePath))};
	}

	/*
		VCardImporter.importVCard: the cards saved, as new contacts of the
		kind the default account's contacts provider has. -> {} once they
		are; a file that cannot be read fails with its error. (The old
		service mapped over the importer's result, true, and failed every
		import, and lost the importer's own errors: README.md, C1.)
	*/
	async function importVCard(params) {
		requireString(params.filePath, 'importVCard did not specify a filePath for the vcard to import');
		const path = localPath(params.filePath);
		if (!path) {
			throw new Error('File path must be specified to make a VCardImporter');
		}
		const accountId = (await prefs.load()).get(PREF.defaultAccountId);
		let kind = null;
		try {
			const account = (await call(ACCOUNTS + '/getAccountInfo', {accountId})).result;
			let noKinds = false;
			for (let i = 0; i < account.capabilityProviders.length && !kind && !noKinds; i += 1) {
				const provider = account.capabilityProviders[i];
				if (provider.capability === 'CONTACTS') {
					if (provider.id === 'com.palm.palmprofile.contacts') {
						kind = 'com.palm.contact.palmprofile:1';
					} else if (provider.dbkinds && provider.dbkinds.contact) {
						kind = provider.dbkinds.contact;
					} else {
						noKinds = true;
					}
				}
			}
		} catch (e) {
			// The importer read the account in a callback whose failure went nowhere.
			log.error(SERVICE + ': importVCard: no account info: ' + ((e && e.message) || e));
			return never();
		}
		if (!kind) {
			const e = new Error('no provider for contacts could be retrieved for account: "' + accountId + '"');
			e.errorCode = 'NO_PROVIDER_FOR_CONTACTS';
			throw e;
		}
		await vcard.importCards(path, async c => {
			c.kind = kind;
			c.accountId = accountId;
			// A card ended twice is the contact saved twice: the second time it has its _id, and is merged.
			if (c.id) {
				await saveContactAgain(vcard.record(c));
			} else {
				c.id = await saveNewContact(vcard.record(c));
			}
		}, {openError: true});
		return {};
	}

	// Contact.save for a new contact: the SIM service saves a SIM contact; any other is put. -> its _id (none for SIM)
	async function saveNewContact(rec) {
		if (String(rec._kind).split(':')[0] === 'com.palm.contact.sim') {
			await call(SIM + '/saveContact', {contact: rec});
			return null;
		}
		const r = await db.put([rec]);
		if (!r.length) {
			throw new Error('Contact save put - result length is zero');
		}
		return r[0].id;
	}

	async function saveContactAgain(rec) {
		if (String(rec._kind).split(':')[0] === 'com.palm.contact.sim') {
			await call(SIM + '/saveContact', {contact: rec});
			return;
		}
		const r = await db.merge([rec]);
		if (!r.length) {
			throw new Error('Contact save put - result length is zero');
		}
	}

	function exportPath(params) {
		const filePath = params.filePath || '';
		if (!filePath) {
			throw new Error('File path must be specified to make a VCardImporter');
		}
		return filePath;
	}

	// Person.getPersonAndContactsById, for the person only: its contacts are read and not used.
	async function personAndContacts(id) {
		requireString(id, 'getPersonAndContactsById requires an id that is a String');
		const results = await db.get([id]);
		const raw = results[0];
		require_(raw && raw._kind === PERSON_KIND, 'Unable to find person by Id');
		await db.get(list(raw.contactIds).map(c => (isObject(c) ? c.value : c)));
		return raw;
	}

	async function vCardExportOne(params) {
		const onlyPhoneNumbers = params.onlyPhoneNumbers || false;
		const filePath = exportPath(params);
		const personId = params.personId || undefined;
		const useFileCache = params.useFileCache || false;
		require_(personId, 'personId passed to export was not truthy. export requires a valid personId to export');
		const raw = await personAndContacts(personId);
		const text = vcard.fileText(exporter.vcard(raw, onlyPhoneNumbers));
		let path = filePath;
		let cache = null;
		if (useFileCache) {
			cache = await call.subscribe(FILECACHE + '/InsertCacheObject',
				{typeName: 'contactvcard', fileName: filePath, size: vcard.byteSize(text), subscribe: true});
			path = (cache.first && cache.first.pathName) || filePath;
		}
		try {
			fs.writeFileSync(path, text, 'utf8');
		} finally {
			if (cache) {
				cache.cancel();
			}
		}
		return {success: true, filePath: path};
	}

	// Every person, a page of 500 at a time; what was written before a failure is still saved.
	async function vCardExportAll(params) {
		const onlyPhoneNumbers = params.onlyPhoneNumbers || false;
		const filePath = exportPath(params);
		let text = '';
		const query = {from: PERSON_KIND, limit: 500};
		for (;;) {
			const page = await db.findPage(Object.assign({}, query));
			try {
				for (const raw of page.results) {
					text += vcard.fileText(exporter.vcard(raw, onlyPhoneNumbers));
				}
			} catch (e) {
				fs.writeFileSync(filePath, text, 'utf8');
				throw e;
			}
			if (!page.next) {
				fs.writeFileSync(filePath, text, 'utf8');
				return {success: true, filePath};
			}
			query.page = page.next;
		}
	}

	// ---- favourites

	// Person._getPersonAndSetFavoriteValueTo.
	async function personWithFavorite(personId, value) {
		require_(personId !== undefined, '_getPersonAndSetFavoriteValueTo: missing required argument - personId');
		const person = await persons.findById(personId);
		require_(person !== undefined, '_getPersonAndSetFavoriteValueTo: could not find the person with id - ' + personId);
		persons.setFavorite(person, value);
		return person;
	}

	// Person._setFavoriteDefault.
	async function setDefault(param, appId) {
		require_(appId !== undefined, '_setFavoriteDefault: missing required argument - applicationID');
		appId = appId.split(' ')[0];
		const personId = param.personId;
		require_(personId !== undefined, '_setFavoriteDefault: missing required argument - personId');
		const defaultData = param.defaultData;
		require_(defaultData !== undefined, '_setFavoriteDefault: missing required argument - defaultData');
		const {contactPointType, listIndex, value, type} = defaultData;
		require_(contactPointType !== undefined, '_setFavoriteDefault: missing required defaultData property - contactPointType');
		require_(SUPPORTED_FAVORITE_TYPES.indexOf(contactPointType) >= 0,
			'_setFavoriteDefault: unsupported contact point type specified');
		require_(listIndex !== undefined, '_setFavoriteDefault: missing required defaultData property - listIndex');
		require_(value !== undefined, '_setFavoriteDefault: missing required defaultData property - value');
		const person = await persons.findById(personId);
		require_(person !== undefined, '_setFavoriteDefault: could not find the person with id - ' + personId);
		require_(persons.isFavorite(person), '_setFavoriteDefault: cannot set a default on a person that is not a favorite');
		const normalized = persons.normalizedFor(contactPointType, value);
		if (!persons.setDefault(person, contactPointType, normalized, type, appId, listIndex, defaultData.auxData)) {
			throw new Error('Setting favorite default on person - ' + personId + ' - failed! Could not find a contact point with value - ' +
				value + ' - on person');
		}
		// One default per person per app, across the point types.
		for (const p of persons.defaultPoints(person, undefined, appId)) {
			if (persons.normalizedValue(p) !== normalized) {
				persons.removeDefaultFor(p, appId);
			}
		}
		person.defaultsChanged = true;
		return persons.save(person);
	}

	/*
		Person._favoritePerson: the person read and made a favourite; with
		defaultData, the default set on the person as read again (which
		refuses one that was not a favourite yet); then the first one saved.
	*/
	async function favoritePerson(params) {
		const person = await personWithFavorite(params.personId, true);
		if (params.defaultData) {
			await setDefault(params, applicationId(params));
		}
		return persons.save(person);
	}

	async function setFavoriteDefault(params) {
		return setDefault(params, applicationId(params));
	}

	async function unfavoritePerson(params) {
		const person = await personWithFavorite(params.personId, false);
		for (const p of persons.defaultPoints(person)) {
			persons.removeAllFavoriteData(p);
		}
		return persons.save(person);
	}

	// ---- photos

	// Person._setCroppedContactPhotoPerson: on the person's first contact.
	async function setCroppedContactPhoto(params) {
		const {contacts} = await personAndContactsFull(params.personId);
		const contact = contacts[0];
		if (contact === undefined) {
			throw new TypeError('Cannot read properties of undefined (reading \'setCroppedContactPhoto\')');
		}
		await photos.setCroppedPhoto(contact, params.path, params.cropInfo, params.photoType);
		return photos.saveContact(contact);
	}

	// Person.getDisplayablePersonAndContactsById: the person and its contacts, in db8's order.
	async function personAndContactsFull(id) {
		requireString(id, 'getPersonAndContactsById requires an id that is a String');
		const person = await persons.findById(id);
		require_(person, 'Unable to find person by Id');
		const contacts = await db.get(person.contactIds);
		return {person, contacts: contacts || []};
	}

	/*
		refetchPhoto: a contact's photo cropped again from its original, as
		its cached copy has gone. With no cropInfo saved, a default that was
		meant to copy the photo as it is (README.md: it does not).
	*/
	async function refetchPhoto(params) {
		const r = await db.get([params.contactId]);
		const contact = r[0] ? r[0] : {};
		const thePhoto = list(contact.photos).map(p => entry(p, 'ContactPhoto')).find(p => p._id === params.photoId);
		if (!thePhoto) {
			log.log('refetchPhoto: could not refetch thumbnail photo because there is no photo with photoId ' +
				params.photoId + ' on the contact with id ' + contact._id);
			return '';
		}
		const cropInfo = thePhoto.cropInfo ? thePhoto.cropInfo : {window: {focusX: 0.5, focusY: 0.5}, scale: 1.0};
		const result = await photos.setCroppedPhoto(contact, thePhoto.value, cropInfo, thePhoto.type);
		if (typeof result === 'string' && result.length > 0) {
			return photos.saveContact(contact);
		}
		return result;
	}

	// IO.Posix.unlink was a Triton call: in node it fails before anything is deleted (README.md).
	async function deleteContactImage(params) {
		if (params.path) {
			throw new ReferenceError('webOS is not defined');
		}
		return never();
	}

	// ---- phone numbers

	async function findPersonByPhone(args) {
		const params = args.params || {};
		const phoneNumber = args.phoneNumber;
		requireString(phoneNumber, 'Person.findByPhone requires a phone number that is a string');
		const empty = () => (params.returnAllMatches ? [] : null);
		const parsed = G.Phone.parsePhoneNumber(phoneNumber, undefined, params.mcc);
		if (!parsed) {
			return empty();
		}
		const normalized = model.normalizePhoneNumber(parsed, true);
		if (!normalized) {
			return empty();
		}
		const found = (await db.findPage({from: PERSON_KIND,
			where: [{prop: 'phoneNumbers.normalizedValue', op: '%', val: normalized}]})).results;
		if (!found || found.length === 0) {
			return empty();
		}
		const matches = [];
		for (const person of found) {
			const numbers = person.phoneNumbers;
			for (let j = 0; j < numbers.length; j += 1) {
				const quality = G.Phone.comparePhoneNumbers(parsed, G.Phone.parsePhoneNumber(numbers[j].value));
				if (quality > 0) {
					const match = params.includeMatchingItem ? {person, item: numbers[j]} : person;
					if (!params.returnAllMatches) {
						return match;
					}
					matches.push({match, quality});
				}
			}
		}
		if (matches.length === 0) {
			return empty();
		}
		matches.sort((a, b) => a.quality - b.quality);
		return matches.map(m => m.match);
	}

	async function updatePersonLocaleAll(params) {
		const region = params.locale || G.Locale.getCurrentPhoneRegion();
		const writer = batchWriter(db, log, {deep: true});
		const started = Date.now();
		prefs.load().then(p => p.set(PREF.contactsPhoneRegion, region), e => log.error(String(e)));
		const query = {select: ['_id', 'phoneNumbers'], from: PERSON_KIND, limit: 500};
		for (;;) {
			const page = await db.findPage(Object.assign({}, query));
			for (const person of page.results) {
				const numbers = clone(person.phoneNumbers) || [];
				for (let i = 0; i < numbers.length; i += 1) {
					const parsed = G.Phone.parsePhoneNumber(numbers[i].value, 'xx_' + region);
					numbers[i].normalizedValue = model.normalizePhoneNumber(parsed);
				}
				writer.write(person, 'phoneNumbers', numbers);
			}
			if (!page.next) {
				break;
			}
			query.page = page.next;
		}
		writer.commit();
		log.info('The re-parsing of the contacts to phone region \'' + region + '\' took ' +
			((Date.now() - started) / 1000) + ' seconds');
		return {returnValue: true};
	}

	// ---- sort order

	// SortKey for a person as sortOrderChanged reads it: its _id, name and organization only.
	function sortKeyOf(person, listSortOrder) {
		let given = '', family = '', company = '';
		const name = person.name;
		if (name) {
			given = name.givenName || '';
			family = name.familyName || '';
		}
		const org = person.organization;
		if (org) {
			company = org.name || '';
		}
		// Person.generateDisplayNameFromRawPerson: a person with no name fails here.
		let display = G.Name.formatPersonalName({prefix: person.name.honorificPrefix, givenName: person.name.givenName,
			middleName: person.name.middleName, familyName: person.name.familyName, suffix: person.name.honorificSuffix},
		G.Name.longName);
		if (!display && person.nickname) {
			display = person.nickname;
		}
		if (!display && org) {
			if (org.title && org.name) {
				display = org.title + ', ' + org.name;
			} else if (!org.title && org.name) {
				display = org.name;
			} else if (org.title && !org.name) {
				display = org.title;
			}
		}
		if (!display) {
			display = NO_NAME;
		}
		family = G.Name.getSortName(family);
		given = (given || '').trim();
		family = (family || '').trim();
		company = (company || '').trim();
		display = (display || '').trim();
		let key = '';
		if (listSortOrder === 'COMPANY_LAST_FIRST' || listSortOrder === 'COMPANY_FIRST_LAST') {
			key += (company || SORT_DEFAULT + SORT_DEFAULT) + '\t';
		}
		if (given || family) {
			if (listSortOrder === 'COMPANY_FIRST_LAST' || listSortOrder === 'FIRST_LAST') {
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

	// SortKey.generateSortKey: with no sort order, the prefs are read (again) for it.
	async function generateSortKey(person, listSortOrder) {
		require_(person, 'SortKey.generateSortKey requires a person that is truthy');
		if (!listSortOrder) {
			listSortOrder = (await prefs.load()).get(PREF.listSortOrder);
		}
		requireString(listSortOrder, 'SortKey.generateSortKey requires a listSortOrder that is a string');
		return sortKeyOf(person, listSortOrder);
	}

	// The watch on the prefs' sort order, as SetUpWatch creates it and sortOrderChanged restarts it.
	function watchTrigger(where) {
		return {method: 'palm://com.palm.db/watch', params: {query: {from: PREFS_KIND, where}, subscribe: true},
			key: 'fired'};
	}
	const CALLBACK = {method: 'palm://com.palm.service.contacts/sortOrderChanged', params: {}};

	async function sortOrderChanged(params) {
		const activity = params.$activity;
		const writer = batchWriter(db, log, {size: 100});
		if (activity && activity.trigger && !activity.trigger.returnValue) {
			// Setting up the watch failed: Foundations' Err.create, -1 when there is no errorCode.
			const e = new Error(activity.trigger.errorText);
			e.errorCode = activity.trigger.errorCode !== undefined ? activity.trigger.errorCode : -1;
			throw e;
		}
		const p = await prefs.load();
		const order = p.get(PREF.listSortOrder);
		const prefsId = p.get('_id');
		if (!params.isFirstRun) {
			const query = {select: ['_id', 'name', 'organization'], from: PERSON_KIND, limit: 500};
			for (;;) {
				const page = await db.findPage(Object.assign({}, query));
				// Utils.dbMap: each person of the page; the first that failed fails the run, after the others.
				let failed = null;
				for (const person of page.results) {
					try {
						writer.write(person, 'sortKey', await generateSortKey(person, order));
					} catch (e) {
						failed = failed || e;
					}
				}
				if (failed) {
					throw failed;
				}
				if (!page.next) {
					break;
				}
				query.page = page.next;
			}
		}
		writer.commit();
		// A run with no $activity (by hand) fails here, after the sort keys are written.
		const activityId = activity.activityId;
		await call(AM + '/complete', {activityId, restart: true, callback: CALLBACK,
			trigger: watchTrigger([{prop: '_id', op: '=', val: prefsId}, {prop: PREF.listSortOrder, op: '!=', val: order}])});
		return true;
	}

	async function SetUpWatch() {
		return call(AM + '/create', {
			activity: {
				name: 'sortOrderWatch',
				description: 'This is the watch for updating the sortKey on every person when the sort order is changed in the contacts app',
				type: {persist: true, foreground: true},
				trigger: watchTrigger([{prop: PREF.listSortOrder, op: '!=', val: ''}]),
				callback: CALLBACK
			},
			start: true,
			replace: true
		});
	}

	const commands = {preBackup, countVCardContacts, readVCard, importVCard, vCardExportAll, vCardExportOne,
		favoritePerson, setFavoriteDefault, setCroppedContactPhoto, unfavoritePerson, findPersonByPhone,
		sortOrderChanged, deleteContactImage, SetUpWatch, refetchPhoto, updatePersonLocaleAll};
	const methods = {};
	for (const name of NAMES) {
		methods[name] = mojo.method(SERVICE, name, commands[name], {timeoutS: timeoutsS[name] || TIMEOUTS[name], log,
			subscribe: call.subscribe});
	}
	return methods;
}

module.exports = {createCommands, SERVICE, NAMES, LONG_TIMEOUT_S, TIMEOUTS, batchWriter, localPath};
