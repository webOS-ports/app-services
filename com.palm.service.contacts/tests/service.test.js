// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service end to end on a stand-in bus, over an in-memory db8. The
	answers are the ones the mojoservice service gave, bugs included (an
	A/B of the two is how they were found; README.md lists the bugs).
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {boot, tmpDir, NO_FRAMEWORKS} = require('./boot');

const PERSON = 'com.palm.person:1';
const AM = {service: 'com.palm.activitymanager'};

function person(id, extra) {
	return Object.assign({_id: id, _kind: PERSON, contactIds: [], name: {givenName: 'Ann', familyName: 'Lee'}}, extra);
}

describe('com.palm.service.contacts', {skip: NO_FRAMEWORKS}, () => {
	it('registers the 16 methods of the old service', async () => {
		const env = await boot();
		const methods = env.pb.services['com.palm.service.contacts'].methods.map(m => m.replace(/^\//, ''));
		for (const m of ['preBackup', 'countVCardContacts', 'readVCard', 'importVCard', 'vCardExportAll', 'vCardExportOne',
			'favoritePerson', 'setFavoriteDefault', 'setCroppedContactPhoto', 'unfavoritePerson', 'findPersonByPhone',
			'sortOrderChanged', 'deleteContactImage', 'SetUpWatch', 'refetchPhoto', 'updatePersonLocaleAll']) {
			assert.ok(methods.includes(m), m);
		}
		env.stop();
	});

	it('preBackup lists the Palm Profile contacts\' original photos, "" for one with no value', async () => {
		const env = await boot();
		await env.db.put([{_id: 'c1', _kind: 'com.palm.contact.palmprofile:1', accountId: 'acct-p',
			photos: [{value: '/media/internal/a.jpg', localPath: '/var/x.jpg'}, {type: 'type_big'}]},
		{_id: 'c2', _kind: 'com.palm.contact.google:1', accountId: 'acct-g', photos: [{value: '/g.jpg'}]}]);
		assert.deepEqual(await env.ask('preBackup'), {version: '1.0', description: 'Backup of 2 palm profile contact photos.',
			files: ['/media/internal/a.jpg', ''], ignoreMissingFiles: true, returnValue: true});
		env.stop();
	});

	it('preBackup with no Palm Profile account fails', async () => {
		const env = await boot({profileAccounts: []});
		const r = await env.ask('preBackup');
		assert.equal(r.returnValue, false);
		assert.equal(r.errorCode, -9999);
		assert.match(r.errorText, /There were no palm profile accounts/);
		env.stop();
	});

	it('counts and reads a vCard; a card ended twice is read twice', async () => {
		const env = await boot();
		const dir = tmpDir();
		const file = path.join(dir, 'a.vcf');
		fs.writeFileSync(file, 'BEGIN:VCARD\r\nN:Doe;John;;;\r\nTEL;TYPE=CELL:555 1234\r\nEMAIL;TYPE=WORK:j@x.org\r\n' +
			'END:VCARD\r\nEND:VCARD\r\nBEGIN:VCARD\r\nN:Roe;Jane\r\nEND:VCARD\r\n');
		assert.deepEqual(await env.ask('countVCardContacts', {filePath: 'file://' + file}), {count: 2, returnValue: true});
		const r = await env.ask('readVCard', {filePath: 'file://' + file});
		assert.equal(r.contacts.length, 3);
		assert.deepEqual(r.contacts[0].name, r.contacts[1].name);
		assert.equal(r.contacts[0].name.familyName, 'Doe');
		assert.deepEqual(r.contacts[0].phoneNumbers.map(n => [n.value, n.type]), [['555 1234', 'type_mobile']]);
		assert.equal(r.contacts[0].emails[0].type, 'type_work');
		assert.equal(r.contacts[2].name.givenName, 'Jane');
		env.stop();
	});

	it('a vCard path must be a file:// URL', async () => {
		const env = await boot();
		const r = await env.ask('readVCard', {filePath: '/x.vcf'});
		assert.equal(r.errorText, 'MojoService: no errorCode supplied getPathFromFileTypeSchemaPath did not specify a target to a local file');
		env.stop();
	});

	it('importVCard saves the cards to the default account and answers success (C1)', async () => {
		const env = await boot();
		const dir = tmpDir();
		const file = path.join(dir, 'a.vcf');
		fs.writeFileSync(file, 'BEGIN:VCARD\nN:Doe;John\nEND:VCARD\nBEGIN:VCARD\nN:Roe;Jane\nEND:VCARD\n');
		await env.db.put([{_kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'LAST_FIRST', defaultAccountId: 'acct-g'}]);
		assert.deepEqual(await env.ask('importVCard', {filePath: 'file://' + file}), {returnValue: true});
		const saved = env.db.all('com.palm.contact:1');
		assert.deepEqual(saved.map(c => [c._kind, c.accountId, c.name.familyName]),
			[['com.palm.contact.google:1', 'acct-g', 'Doe'], ['com.palm.contact.google:1', 'acct-g', 'Roe']]);
		env.stop();
	});

	it('importVCard to an account with no contacts kind answers NO_PROVIDER_FOR_CONTACTS, with its text (C1)', async () => {
		const env = await boot();
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, 'a.vcf'), 'BEGIN:VCARD\nN:Doe;John\nEND:VCARD\n');
		await env.db.put([{_kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'LAST_FIRST', defaultAccountId: 'acct-n'}]);
		const r = await env.ask('importVCard', {filePath: 'file://' + dir + '/a.vcf'});
		assert.equal(r.errorCode, 'NO_PROVIDER_FOR_CONTACTS');
		assert.equal(r.errorText, 'no provider for contacts could be retrieved for account: "acct-n"');
		env.stop();
	});

	it('importVCard of a file that is not there fails, and saves nothing (C1)', async () => {
		const env = await boot();
		const dir = tmpDir();
		await env.db.put([{_kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'LAST_FIRST', defaultAccountId: 'acct-g'}]);
		const r = await env.ask('importVCard', {filePath: 'file://' + dir + '/missing.vcf'});
		assert.match(r.errorText, /^MojoService: no errorCode supplied ENOENT: no such file or directory/);
		assert.equal(env.db.all('com.palm.contact:1').length, 0);
		env.stop();
	});

	it('importVCard with an account that cannot be read fails at once (C2)', async () => {
		const env = await boot({timeoutsS: {importVCard: 5}});
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, 'a.vcf'), 'BEGIN:VCARD\nN:Doe;John\nEND:VCARD\n');
		await env.db.put([{_kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'LAST_FIRST', defaultAccountId: 'gone'}]);
		const r = await env.askWithin(1000, 'importVCard', {filePath: 'file://' + dir + '/a.vcf'});
		assert.equal(r.errorText, 'palm://com.palm.service.accounts/getAccountInfo {"accountId":"gone"}: no account gone');
		env.stop();
	});

	it('importVCard whose save fails fails at once, with the cards before it saved (C2)', async () => {
		const env = await boot({timeoutsS: {importVCard: 5}});
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, 'a.vcf'), 'BEGIN:VCARD\nN:Doe;John\nEND:VCARD\nBEGIN:VCARD\nN:Roe;Jane\nEND:VCARD\n');
		await env.db.put([{_kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'LAST_FIRST', defaultAccountId: 'acct-g'}]);
		const put = env.db.handle.bind(env.db);
		let puts = 0;
		env.db.handle = (method, args) => {
			if (method === 'put' && ++puts === 2) {
				env.db.failNext('put');
			}
			return put(method, args);
		};
		const r = await env.askWithin(1000, 'importVCard', {filePath: 'file://' + dir + '/a.vcf'});
		assert.equal(r.errorCode, -3999);
		assert.deepEqual(env.db.all('com.palm.contact:1').map(c => c.name.familyName), ['Doe']);
		env.stop();
	});

	it('exports one person as a 3.0 vCard, each URL with its own label (C7)', async () => {
		const env = await boot();
		const dir = tmpDir();
		await env.db.put([person('p1', {phoneNumbers: [{value: '(408) 555-1234', type: 'type_mobile'}],
			emails: [{value: 'a@b.com', type: 'type_work'}], urls: [{value: 'http://w', type: 'type_work'},
			{value: 'http://h', type: 'type_home'}, {value: 'http://o', type: 'type_other'}]})]);
		const file = path.join(dir, 'one.vcf');
		assert.deepEqual(await env.ask('vCardExportOne', {filePath: file, personId: 'p1'}),
			{success: true, filePath: file, returnValue: true});
		const text = fs.readFileSync(file, 'utf8');
		assert.match(text, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nN:Lee;Ann;;;\r\nFN:Ann Lee\r\n/);
		assert.match(text, /TEL;TYPE=CELL,VOICE:\(408\) 555-1234\r\n/);
		assert.match(text, /EMAIL;TYPE=WORK,INTERNET:a@b\.com\r\n/);
		assert.match(text, /\r\nURL;TYPE=WORK:http:\/\/w\r\nURL;TYPE=HOME:http:\/\/h\r\nURL:http:\/\/o\r\n/);
		assert.match(text, /END:VCARD\r\n\r\n$/);
		env.stop();
	});

	it('exports a 2.1 vCard when asked, with CHARSET=UTF-8 unless another charset is asked for (C6)', async () => {
		const env = await boot();
		const dir = tmpDir();
		await env.db.put([person('p1', {phoneNumbers: [{value: '(408) 555-1234', type: 'type_mobile'}],
			emails: [{value: 'a@b.com', type: 'type_work'}], addresses: [{streetAddress: '1 Main', type: 'type_home'}]})]);
		const one = path.join(dir, 'one.vcf');
		assert.equal((await env.ask('vCardExportOne', {filePath: one, personId: 'p1', vCardVersion: '2.1'})).success, true);
		const all = path.join(dir, 'all.vcf');
		assert.equal((await env.ask('vCardExportAll', {filePath: all, vCardVersion: '2.1'})).success, true);
		for (const text of [fs.readFileSync(one, 'utf8'), fs.readFileSync(all, 'utf8')]) {
			assert.match(text, /^BEGIN:VCARD\r\nVERSION:2\.1\r\nN;CHARSET=UTF-8:Lee;Ann;;;\r\nFN;CHARSET=UTF-8:Ann Lee\r\n/);
			assert.match(text, /TEL;CHARSET=UTF-8;CELL;VOICE:\(408\) 555-1234\r\n/);
			assert.match(text, /EMAIL;WORK;INTERNET:a@b\.com\r\n/);
			assert.match(text, /ADR;HOME:;;1 Main;;;;\r\n/);
		}
		const ascii = path.join(dir, 'ascii.vcf');
		await env.ask('vCardExportOne', {filePath: ascii, personId: 'p1', vCardVersion: '2.1', charset: 'US-ASCII'});
		assert.match(fs.readFileSync(ascii, 'utf8'), /VERSION:2\.1\r\nN:Lee;Ann;;;\r\nFN:Ann Lee\r\nTEL;CELL;VOICE:/);
		const v3 = path.join(dir, 'v3.vcf');
		await env.ask('vCardExportOne', {filePath: v3, personId: 'p1', vCardVersion: '3.0', charset: 'UTF-8'});
		assert.match(fs.readFileSync(v3, 'utf8'), /VERSION:3\.0\r\nN:Lee;Ann;;;\r\nFN:Ann Lee\r\nTEL;TYPE=CELL,VOICE:/);
		env.stop();
	});

	it('exports to the file cache when asked', async () => {
		const dir = tmpDir();
		fs.mkdirSync(dir + '/contactvcard');
		const env = await boot({cacheDir: dir});
		await env.db.put([person('p1')]);
		const r = await env.ask('vCardExportOne', {filePath: dir + '/x.vcf', personId: 'p1', useFileCache: true});
		assert.equal(r.filePath, dir + '/contactvcard/x.vcf');
		assert.match(fs.readFileSync(r.filePath, 'utf8'), /^BEGIN:VCARD/);
		assert.equal(env.of('com.palm.filecache', 'InsertCacheObject')[0].args.typeName, 'contactvcard');
		env.stop();
	});

	it('exports every person, only those with phone numbers when asked', async () => {
		const env = await boot();
		const dir = tmpDir();
		await env.db.put([person('p1', {phoneNumbers: [{value: '+1 650 555 0000', type: 'type_home'}]}),
			person('p2', {name: {givenName: 'Bob', familyName: 'Ray'}})]);
		const file = path.join(dir, 'all.vcf');
		assert.equal((await env.ask('vCardExportAll', {filePath: file, onlyPhoneNumbers: true})).success, true);
		const text = fs.readFileSync(file, 'utf8');
		assert.equal(text.split('BEGIN:VCARD').length - 1, 1);
		assert.match(text, /TEL;TYPE=HOME,VOICE:\+16505550000\r\n/);
		env.stop();
	});

	it('vCardExportAll without a file path fails as the exporter did', async () => {
		const env = await boot();
		assert.equal((await env.ask('vCardExportAll', {})).errorText,
			'MojoService: no errorCode supplied File path must be specified to make a VCardImporter');
		env.stop();
	});

	it('favoritePerson makes a favourite and backs up its defaults', async () => {
		const env = await boot();
		await env.db.put([{_id: 'c1', _kind: 'com.palm.contact.palmprofile:1', remoteId: 'R1'},
			person('p1', {contactIds: ['c1'], phoneNumbers: [{value: '4085551234', type: 'type_mobile', speedDial: '2'}]})]);
		assert.equal(await env.ask('favoritePerson', {personId: 'p1'}), true);
		const p = env.db.all(PERSON)[0];
		assert.equal(p.favorite, true);
		assert.equal(p.phoneNumbers[0].normalizedValue, '-4321555804--1-+');
		assert.equal(env.db.all('com.palm.person.favoritebackup:1')[0].contactBackupHash, 'Local|R1');
		assert.equal(env.db.all('com.palm.person.speeddialbackup:1')[0].speedDials[0].key, '2');
		env.stop();
	});

	it('favoritePerson with defaultData makes a favourite with that default, in one save (C5)', async () => {
		const env = await boot();
		await env.db.put([person('p1', {phoneNumbers: [{value: '111', type: 'type_home'},
			{value: '4085551234', type: 'type_mobile'}]}),
		person('p2', {favorite: true, phoneNumbers: [{value: '222', type: 'type_home'},
			{value: '4085550000', type: 'type_mobile'}]})]);
		const dd = v => ({value: v, type: 'type_mobile', contactPointType: 'contact_point_type_phoneNumber', listIndex: 2});
		assert.equal(await env.ask('favoritePerson', {personId: 'p1', defaultData: dd('4085551234')}), true);
		assert.equal(await env.ask('favoritePerson', {personId: 'p2', defaultData: dd('4085550000')}), true);
		for (const p of env.db.all(PERSON)) {
			assert.equal(p.favorite, true);
			assert.deepEqual(p.phoneNumbers.map(n => n.favoriteData), [{'com.palm.app.phone': {listIndex: 2}}, {}]);
		}
		const r = await env.ask('favoritePerson', {personId: 'p1', defaultData: dd('999')});
		assert.match(r.errorText, /Could not find a contact point with value - 999/);
		env.stop();
	});

	it('setFavoriteDefault puts the default first, for the app given, the phone app\'s by default', async () => {
		const env = await boot();
		await env.db.put([person('p1', {favorite: true, phoneNumbers: [{value: '111', type: 'type_home'},
			{value: '4085551234', type: 'type_mobile'}]})]);
		assert.equal(await env.ask('setFavoriteDefault', {personId: 'p1', defaultData: {value: '4085551234',
			type: 'type_mobile', contactPointType: 'contact_point_type_phoneNumber', listIndex: 3, auxData: {a: 1}}}), true);
		const p = env.db.all(PERSON)[0];
		assert.equal(p.phoneNumbers[0].value, '4085551234');
		assert.deepEqual(p.phoneNumbers[0].favoriteData, {'com.palm.app.phone': {listIndex: 3, auxData: {a: 1}}});
		assert.deepEqual(p.phoneNumbers[1].favoriteData, {});
		env.stop();
	});

	it('a default set on one point is on that point alone, of that person alone (C4)', async () => {
		const env = await boot();
		await env.db.put([person('p1', {favorite: true, phoneNumbers: [{value: '111', type: 'type_home'},
			{value: '4085551234', type: 'type_mobile'}], emails: [{value: 'a@b.com', type: 'type_home'}]}),
		person('p2', {favorite: true, phoneNumbers: [{value: '222', type: 'type_home'}]})]);
		assert.equal(await env.ask('setFavoriteDefault', {personId: 'p1', defaultData: {value: '4085551234',
			type: 'type_mobile', contactPointType: 'contact_point_type_phoneNumber', listIndex: 0}}), true);
		assert.equal(await env.ask('setFavoriteDefault', {personId: 'p2', defaultData: {value: 'x', type: 'type_home',
			contactPointType: 'contact_point_type_phoneNumber', listIndex: 0}}).then(r => r.returnValue), false);
		await env.ask('favoritePerson', {personId: 'p2'});
		const [p1, p2] = env.db.all(PERSON);
		assert.deepEqual(p1.phoneNumbers.map(n => n.favoriteData), [{'com.palm.app.phone': {listIndex: 0}}, {}]);
		assert.deepEqual(p1.emails[0].favoriteData, {});
		assert.deepEqual(p2.phoneNumbers[0].favoriteData, {});
		env.stop();
	});

	it('setFavoriteDefault with no such point fails', async () => {
		const env = await boot();
		await env.db.put([person('p1', {favorite: true, emails: [{value: 'a@b.com', type: 'type_home'}]})]);
		const r = await env.ask('setFavoriteDefault', {personId: 'p1', defaultData: {value: 'x@y.org', type: 'type_home',
			contactPointType: 'contact_point_type_emailAddress', listIndex: 0}});
		assert.match(r.errorText, /Could not find a contact point with value - x@y\.org - on person/);
		env.stop();
	});

	it('unfavoritePerson clears the favourite and every default', async () => {
		const env = await boot();
		await env.db.put([person('p1', {favorite: true, emails: [{value: 'a@b.com', type: 'type_home',
			favoriteData: {'com.palm.app.email': {listIndex: 0}}}]})]);
		assert.equal(await env.ask('unfavoritePerson', {personId: 'p1'}), true);
		const p = env.db.all(PERSON)[0];
		assert.equal(p.favorite, false);
		assert.deepEqual(p.emails[0].favoriteData, {});
		env.stop();
	});

	it('findPersonByPhone finds the person, the matching number with it when asked', async () => {
		const env = await boot();
		// The form updatePersonLocaleAll writes; the linker's own form is not found (README.md).
		await env.db.put([person('p1', {phoneNumbers: [{value: '(408) 555-1234', type: 'type_mobile',
			normalizedValue: '-4321555---'}]}), person('p9', {phoneNumbers: [{value: '(212) 555-1234', type: 'type_mobile',
			normalizedValue: '-4321555212--1-+'}]})]);
		const r = await env.ask('findPersonByPhone', {phoneNumber: '4085551234'});
		assert.equal(r._id, 'p1');
		assert.equal(r.returnValue, true);
		const m = await env.ask('findPersonByPhone', {phoneNumber: '408-555-1234', params: {includeMatchingItem: true}});
		assert.equal(m.item.value, '(408) 555-1234');
		assert.deepEqual(await env.ask('findPersonByPhone', {phoneNumber: '2125550000', params: {returnAllMatches: true}}), []);
		assert.deepEqual(await env.ask('findPersonByPhone', {phoneNumber: '2125550000'}), {returnValue: true});
		env.stop();
	});

	it('findPersonByPhone with returnAllMatches lists the best match first (C8)', async () => {
		const env = await boot();
		await env.db.put([person('pb', {phoneNumbers: [{value: '555-1234', normalizedValue: '-4321555---'}]}),
			person('pa', {phoneNumbers: [{value: '(408) 555-1234', normalizedValue: '-4321555---'}]}),
			person('pc', {phoneNumbers: [{value: '555-1234', normalizedValue: '-4321555---'}]})]);
		const r = await env.ask('findPersonByPhone', {phoneNumber: '4085551234', params: {returnAllMatches: true}});
		// Equal matches keep the order db8 gave them.
		assert.deepEqual(r.map(p => p._id), ['pa', 'pb', 'pc']);
		env.stop();
	});

	it('setCroppedContactPhoto crops into the file cache and puts the photo first', async () => {
		const env = await boot();
		await env.db.put([{_id: 'c1', _kind: 'com.palm.contact.google:1', accountId: 'acct-g',
			photos: [{value: '/old.jpg', type: 'type_big', localPath: '/var/file-cache/old.jpg'}, {value: '/sq.jpg', type: 'type_square'}]},
		person('p1', {contactIds: ['c1']})]);
		assert.equal(await env.ask('setCroppedContactPhoto', {personId: 'p1', path: '/media/internal/new.jpg',
			cropInfo: {focusX: 0.5, focusY: 0.5, suggestedXsize: 192}, photoType: 'type_big'}), true);
		const c = env.db.all('com.palm.contact:1')[0];
		assert.deepEqual(c.photos.map(p => [p.value, p.type]), [['/media/internal/new.jpg', 'type_big'], ['/sq.jpg', 'type_square']]);
		assert.equal(c.photos[0].localPath, '/var/file-cache/contactphoto/new.jpg');
		assert.deepEqual(env.of('com.palm.filecache', 'ExpireCacheObject').map(x => x.args.pathName), ['/var/file-cache/old.jpg']);
		assert.equal(env.of('com.webos.service.image', 'convert')[0].args.scale, 0.5);
		env.stop();
	});

	it('a Palm Profile photo is cropped to /media/internal/.contactphotos', async () => {
		const env = await boot();
		await env.db.put([{_id: 'c1', _kind: 'com.palm.contact.palmprofile:1', accountId: 'acct-p'},
			person('p1', {contactIds: ['c1']})]);
		await env.ask('setCroppedContactPhoto', {personId: 'p1', path: '/new.jpg', cropInfo: {focusX: 0, focusY: 0,
			suggestedXsize: 196}, photoType: 'type_square'});
		const c = env.db.all('com.palm.contact:1')[0];
		assert.equal(c.photos[0].value, '/media/internal/.contactphotos/1700000000000.jpg');
		assert.equal(c.photos[0].localPath, c.photos[0].value);
		env.stop();
	});

	it('refetchPhoto crops the photo again and saves the contact; an unknown photo answers {}', async () => {
		const env = await boot();
		await env.db.put([{_id: 'c1', _kind: 'com.palm.contact.google:1', accountId: 'acct-g',
			photos: [{_id: 'ph1', value: '/o.jpg', type: 'type_list'}]}]);
		assert.deepEqual(await env.ask('refetchPhoto', {contactId: 'c1', photoId: 'nope'}), {returnValue: true});
		assert.equal(await env.ask('refetchPhoto', {contactId: 'c1', photoId: 'ph1'}), true);
		assert.equal(env.of('com.webos.service.image', 'ezResize').length, 1);
		assert.equal(env.db.all('com.palm.contact:1')[0].photos[0].localPath, '/var/file-cache/contactphoto/o.jpg');
		env.stop();
	});

	it('deleteContactImage removes a contact photo, and nothing outside the photo directory (C3)', async () => {
		const dir = tmpDir();
		const photos = path.join(dir, '.contactphotos');
		fs.mkdirSync(photos);
		fs.writeFileSync(path.join(photos, 'i.jpg'), 'x');
		fs.writeFileSync(path.join(dir, 'o.jpg'), 'x');
		fs.mkdirSync(photos + '-not');
		fs.writeFileSync(photos + '-not/o.jpg', 'x');
		const env = await boot({photoDir: photos});
		assert.deepEqual(await env.ask('deleteContactImage', {path: photos + '/i.jpg'}), {returnValue: true});
		assert.ok(!fs.existsSync(path.join(photos, 'i.jpg')));
		for (const p of [dir + '/o.jpg', photos + '/../o.jpg', photos + '-not/o.jpg']) {
			const r = await env.ask('deleteContactImage', {path: p});
			assert.equal(r.returnValue, false);
			assert.equal(r.errorCode, 'NOT_A_CONTACT_PHOTO');
		}
		assert.ok(fs.existsSync(path.join(dir, 'o.jpg')) && fs.existsSync(photos + '-not/o.jpg'));
		assert.equal((await env.ask('deleteContactImage', {path: photos + '/gone.jpg'})).returnValue, false);
		env.stop();
	});

	it('deleteContactImage with no path answers at once (C3)', async () => {
		const env = await boot({timeoutsS: {deleteContactImage: 1}});
		assert.deepEqual(await env.askWithin(500, 'deleteContactImage', {}), {returnValue: true});
		env.stop();
	});

	it('sortOrderChanged writes every sort key and restarts the watch', async () => {
		const env = await boot();
		await env.db.put([{_id: 'pr', _kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'FIRST_LAST'},
			person('p1'), person('p2', {name: {givenName: '', familyName: ''}, organization: {name: 'Acme', title: 'CEO'}})]);
		assert.deepEqual(await env.ask('sortOrderChanged', {$activity: {activityId: 5, trigger: {returnValue: true}}}, AM),
			{returnValue: true});
		assert.deepEqual(env.db.all(PERSON).map(p => p.sortKey), ['ann\tlee', 'ceo, acme']);
		const c = env.of('com.palm.activitymanager', 'complete')[0].args;
		assert.equal(c.activityId, 5);
		assert.equal(c.restart, true);
		assert.deepEqual(c.trigger, {method: 'palm://com.palm.db/watch', key: 'fired', params: {subscribe: true,
			query: {from: 'com.palm.app.contacts.prefs:1', where: [{prop: '_id', op: '=', val: 'pr'},
				{prop: 'listSortOrder', op: '!=', val: 'FIRST_LAST'}]}}});
		assert.deepEqual(c.callback, {method: 'palm://com.palm.service.contacts/sortOrderChanged', params: {}});
		env.stop();
	});

	it('sortOrderChanged called by hand writes the keys and answers true (C9)', async () => {
		const env = await boot();
		await env.db.put([person('p1')]);
		assert.equal(await env.ask('sortOrderChanged', {}), true);
		assert.equal(env.db.all(PERSON)[0].sortKey, 'lee\tann');
		assert.equal(env.of('com.palm.activitymanager', 'complete').length, 0);
		env.stop();
	});

	it('sortOrderChanged writes only the sort keys that change (C9)', async () => {
		const env = await boot();
		await env.db.put([{_id: 'pr', _kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'FIRST_LAST'},
			person('p1', {sortKey: 'ann\tlee'}), person('p2', {sortKey: 'lee\tann'})]);
		await env.ask('sortOrderChanged', {$activity: {activityId: 5, trigger: {returnValue: true}}}, AM);
		const merged = env.of('com.palm.db', 'merge').map(c => c.args.objects);
		assert.deepEqual(merged, [[{_id: 'p2', sortKey: 'ann\tlee'}]]);
		assert.deepEqual(env.db.all(PERSON).map(p => p.sortKey), ['ann\tlee', 'ann\tlee']);
		env.stop();
	});

	it('SetUpWatch creates the sort-order watch', async () => {
		const env = await boot();
		assert.deepEqual(await env.ask('SetUpWatch', {}), {returnValue: true, activityId: 900});
		const a = env.of('com.palm.activitymanager', 'create')[0].args;
		assert.equal(a.activity.name, 'sortOrderWatch');
		assert.deepEqual(a.activity.trigger.params.query.where, [{prop: 'listSortOrder', op: '!=', val: ''}]);
		env.stop();
	});

	it('updatePersonLocaleAll normalises the numbers again and saves the region', async () => {
		const env = await boot();
		await env.db.put([{_id: 'pr', _kind: 'com.palm.app.contacts.prefs:1', listSortOrder: 'LAST_FIRST'},
			person('p1', {phoneNumbers: [{value: '4085551234', normalizedValue: 'old'}]}), person('p2')]);
		assert.deepEqual(await env.ask('updatePersonLocaleAll', {locale: 'de'}), {returnValue: true});
		const [p1, p2] = env.db.all(PERSON);
		assert.equal(p1.phoneNumbers[0].normalizedValue, '-4321555804---');
		assert.deepEqual(p2.phoneNumbers, []);
		assert.equal(env.db.all('com.palm.app.contacts.prefs:1')[0].contactsPhoneRegion, 'de');
		// A person whose numbers are already so is not written again.
		const merges = env.of('com.palm.db', 'merge').length;
		await env.ask('updatePersonLocaleAll', {locale: 'de'});
		assert.equal(env.of('com.palm.db', 'merge').length, merges + 1);
		assert.deepEqual(env.of('com.palm.db', 'merge').pop().args.objects.map(o => o._id), ['pr']);
		env.stop();
	});
});
