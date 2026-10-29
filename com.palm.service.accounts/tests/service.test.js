// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service on a stand-in bus, method by method, with the intent of the
	old tests (tests/accounts-test.js, which ran on the device): templates
	listed and filtered, accounts created, read, listed, modified and
	deleted, credentials read and written, callers without permission
	refused. All credentials are made up.
*/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {boot} = require('./boot');

const APP = {appId: 'com.palm.app.accounts'};
const MAIL = {
	templateId: 'com.test.mail', loc_name: 'Test Mail',
	icon: {loc_32x32: 'images/32.png'},
	readPermissions: ['com.test.reader'],
	writePermissions: ['com.test.*'],
	onCapabilitiesChanged: 'palm://com.test.mail/onCapabilitiesChanged',
	onCredentialsChanged: 'palm://com.test.mail/onCredentialsChanged',
	capabilityProviders: [
		{id: 'com.test.mail.imap', capability: 'MAIL', onEnabled: 'palm://com.test.mail/onEnabled',
			onCreate: 'palm://com.test.mail/onCreate', onDelete: 'palm://com.test.mail/onDelete',
			onCredentialsChanged: 'palm://com.test.mail/imapCredentialsChanged'},
		{id: 'com.test.mail.contacts', capability: 'CONTACTS', onEnabled: 'palm://com.test.mail/contactsEnabled'},
		{id: 'com.test.mail.always', capability: 'TASKS', alwaysOn: true}
	]
};
const CAL = {templateId: 'com.test.cal', loc_name: 'Another', capabilityProviders: [{id: 'com.test.cal.c', capability: 'CALENDAR'}]};
const PROFILE = {templateId: 'com.palm.palmprofile', loc_name: 'Profile', writePermissions: [],
	capabilityProviders: [{id: 'com.palm.palmprofile.contacts', capability: 'CONTACTS'}, {id: 'com.palm.palmprofile.calendar', capability: 'CALENDAR'}]};
const CREDS = {common: {password: 'fake-secret', authToken: 'fake-321'}, imap: {authToken: 'fake-FBAE'}};

async function withService(opts, fn) {
	const s = await boot(Object.assign({templates: {'com.test.mail': MAIL, 'com.test.cal': CAL, 'com.palm.palmprofile': PROFILE}}, opts));
	try {
		await fn(s);
	} finally {
		s.stop();
	}
}

async function create(s, extra, caller = {appId: 'com.test.app'}) {
	return s.ask('createAccount', Object.assign({templateId: 'com.test.mail', username: 'user@example.org',
		capabilityProviders: [{id: 'com.test.mail.imap'}, {id: 'com.test.mail.always'}], credentials: CREDS}, extra), caller);
}

test('listAccountTemplates: sorted by name, filtered by capability; tempdb gets the list of ids', async () => {
	await withService({}, async s => {
		const all = await s.ask('listAccountTemplates', {});
		assert.strictEqual(all.returnValue, true);
		assert.deepStrictEqual(all.results.map(t => t.templateId), ['com.test.cal', 'com.palm.palmprofile', 'com.test.mail']);
		assert.strictEqual(all.results[2].icon.loc_32x32, s.roots[0] + '/com.test.mail/images/32.png');
		const contacts = await s.ask('listAccountTemplates', {capability: 'CONTACTS'});
		assert.deepStrictEqual(contacts.results.map(t => t.templateId), ['com.palm.palmprofile', 'com.test.mail']);
		const two = await s.ask('listAccountTemplates', {capability: ['CALENDAR', 'TASKS']});
		assert.strictEqual(two.results.length, 3);
		await s.settle();
		assert.deepStrictEqual(s.tempdb.all('com.palm.signaling:1').map(r => r.templates),
			['com.palm.palmprofile,com.test.cal,com.test.mail']);
	});
});

test('createAccount: the account, its credentials in keymanager, the transports told in the background', async () => {
	await withService({}, async s => {
		const r = await create(s, {capabilityProviders: [{id: 'com.test.mail.imap'}, {id: 'nope'}, {id: 'com.test.mail.imap'}]});
		assert.strictEqual(r.returnValue, true);
		const a = r.result;
		assert.deepStrictEqual(a.capabilityProviders, [{id: 'com.test.mail.imap', capability: 'MAIL'}]);
		assert.strictEqual(a.beingDeleted, false);
		assert.deepStrictEqual(JSON.parse(s.keys.get(a._id)), CREDS);
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		const told = s.callsTo('com.test.mail/').map(c => c.method + ' ' + JSON.stringify(c.args)).sort();
		assert.deepStrictEqual(told, [
			'onCapabilitiesChanged {"accountId":"' + a._id + '","capabilityProviders":[{"id":"com.test.mail.imap","enabled":true},' +
				'{"id":"com.test.mail.contacts","enabled":false},{"id":"com.test.mail.always","enabled":false}]}',
			'onCreate {"accountId":"' + a._id + '"}',
			'onEnabled {"accountId":"' + a._id + '","capabilityProviderId":"com.test.mail.imap","enabled":true}'
		]);
		const dup = await create(s);
		assert.deepStrictEqual([dup.returnValue, dup.errorCode, dup.errorText], [false, 'DUPLICATE_ACCOUNT', 'Unable to create a duplicate account']);
	});
});

test('createAccount: refused without the arguments, a template or write permission', async () => {
	await withService({}, async s => {
		const missing = await s.ask('createAccount', {templateId: 'com.test.mail', capabilityProviders: []}, APP);
		assert.deepStrictEqual([missing.errorCode, missing.errorText], [-9999, 'MojoService: no errorCode supplied missing username']);
		const both = await create(s, {password: 'fake-pw'});
		assert.match(both.errorText, /can't have both password and credentials/);
		const none = await create(s, {templateId: 'no.such'});
		assert.match(none.errorText, /no account template for id=no.such/);
		const denied = await create(s, {}, {appId: 'org.other.app'});
		assert.deepStrictEqual([denied.returnValue, denied.errorCode, denied.errorText], [false, '',
			'Permission denied! org.other.app is not specified in template com.test.mail writePermissions']);
		assert.strictEqual(s.accounts().length, 0);
	});
});

test('getAccountInfo and listAccounts: the account with its template laid over it; read permission', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await create(s, {templateId: 'com.test.cal', capabilityProviders: [{id: 'com.test.cal.c'}], credentials: undefined}, APP);
		const info = await s.ask('getAccountInfo', {accountId: id}, {appId: 'com.test.reader 42'});
		assert.strictEqual(info.result.loc_name, 'Test Mail');
		assert.strictEqual(info.result.username, 'user@example.org');
		assert.strictEqual(info.result.capabilityProviders[0].onEnabled, 'palm://com.test.mail/onEnabled');
		const denied = await s.ask('getAccountInfo', {accountId: id}, {appId: 'com.test.app'});
		assert.match(denied.errorText, /^Permission denied! com.test.app is not specified in template com.test.mail readPermissions/);
		const unknown = await s.ask('getAccountInfo', {accountId: 'A99999999'}, APP);
		assert.strictEqual(unknown.errorText, 'MojoService: no errorCode supplied Assert.require failed');

		const list = p => s.ask('listAccounts', p, APP).then(r => r.results.map(a => a.templateId).sort());
		assert.deepStrictEqual(await list({}), ['com.test.cal', 'com.test.mail']);
		assert.deepStrictEqual(await list({templateId: 'com.test.mail'}), ['com.test.mail']);
		assert.deepStrictEqual(await list({templateId: 'fail'}), []);
		assert.deepStrictEqual(await list({capability: 'CALENDAR'}), ['com.test.cal']);
		assert.deepStrictEqual(await list({capability: 'FAIL'}), []);
		// An account whose template went is left out of the list.
		await s.db.merge([{_id: id, templateId: 'gone'}]);
		assert.deepStrictEqual(await list({}), ['com.test.cal']);
	});
});

test('the *Public methods: only the whitelisted apps, documents only', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		const no = await s.ask('listAccountsPublic', {capability: 'MAIL'}, {appId: 'com.quickoffice.webos'});
		assert.deepStrictEqual([no.errorCode, no.errorText], ['', 'Permission denied.']);
		const yes = await s.ask('listAccountsPublic', {capability: 'DOCUMENTS'}, {appId: 'com.quickoffice.webos'});
		assert.deepStrictEqual(yes.results, []);
		const cred = await s.ask('readCredentialsPublic', {accountId: id, name: 'common'}, {appId: 'com.other'});
		assert.strictEqual(cred.errorText, 'Permission denied.');
	});
});

test('readCredentials, writeCredentials, hasCredentials', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		const read = await s.ask('readCredentials', {accountId: id, name: 'common'}, {appId: 'com.test.reader'});
		assert.deepStrictEqual(read, {credentials: CREDS.common, returnValue: true});
		const denied = await s.ask('readCredentials', {accountId: id, name: 'common'}, {appId: 'com.evil'});
		assert.match(denied.errorText, /^Permission denied!/);
		const none = await s.ask('readCredentials', {accountId: id, name: 'nope'}, APP);
		assert.deepStrictEqual([none.errorCode, none.errorText, none.exception], ['CREDENTIALS_NOT_FOUND',
			'Credentials for key \'nope\' not found in account \'' + id + '\'', '[object Object]']);
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		s.calls.length = 0;
		const w = await s.ask('writeCredentials', {accountId: id, name: 'common', credentials: {password: 'fake-sauce'}}, {appId: 'com.test.x'});
		assert.deepStrictEqual(w, {returnValue: true});
		assert.deepStrictEqual((await s.ask('readCredentials', {accountId: id, name: 'common'}, APP)).credentials, {password: 'fake-sauce'});
		assert.deepStrictEqual((await s.ask('readCredentials', {accountId: id, name: 'imap'}, APP)).credentials, CREDS.imap);
		await s.settle();
		assert.deepStrictEqual(s.callsTo('com.test.mail/').map(c => c.method).sort(), ['imapCredentialsChanged', 'onCredentialsChanged']);
		const wdenied = await s.ask('writeCredentials', {accountId: id, name: 'common', credentials: {}}, {appId: 'com.evil'});
		assert.match(wdenied.errorText, /^Permission denied!/);
		assert.deepStrictEqual(await s.ask('hasCredentials', {accountId: id}), {value: true, returnValue: true});
		assert.deepStrictEqual(await s.ask('hasCredentials', {accountId: 'A99999999'}), {value: false, returnValue: true});
	});
});

test('modifyAccount: alias and providers saved, onEnabled to those turned on and off, alwaysOn kept', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		s.calls.length = 0;
		const r = await s.ask('modifyAccount', {accountId: id, object: {alias: 'new alias',
			capabilityProviders: [{id: 'com.test.mail.contacts'}, {id: 'com.test.mail.always'}]}}, {appId: 'com.test.app'});
		assert.deepStrictEqual(r, {returnValue: true});
		const a = s.accounts()[0];
		assert.strictEqual(a.alias, 'new alias');
		assert.deepStrictEqual(a.capabilityProviders.map(c => c.id), ['com.test.mail.contacts', 'com.test.mail.always']);
		const enabled = s.callsTo('com.test.mail/').filter(c => /nabled$/.test(c.method)).map(c => c.method + ' ' + c.args.enabled).sort();
		assert.deepStrictEqual(enabled, ['contactsEnabled true', 'onEnabled false']);

		const refused = await s.ask('modifyAccount', {accountId: id, object: {capabilityProviders: [{id: 'com.test.mail.contacts'}]}}, APP);
		assert.deepStrictEqual([refused.errorCode, refused.errorText], ['400_BAD_REQUEST', 'can\'t disable \'alwaysOn\' capabilities']);
		const denied = await s.ask('modifyAccount', {accountId: id, object: {alias: 'x'}}, {});
		assert.match(denied.errorText, /^Permission denied! {2}is not specified/);
	});
});

test('modifyAccount: a transport that fails is flipped back, TRANSPORT_FAILURE', async () => {
	const transports = uri => (uri.endsWith('/contactsEnabled') ? {returnValue: false, errorCode: 7, errorText: 'no'} : {returnValue: true});
	await withService({transports}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		const r = await s.ask('modifyAccount', {accountId: id, object: {capabilityProviders: [{id: 'com.test.mail.imap'},
			{id: 'com.test.mail.contacts'}, {id: 'com.test.mail.always'}]}}, APP);
		assert.deepStrictEqual([r.errorCode, r.errorText], ['TRANSPORT_FAILURE', 'Failed to notify transports: palm://com.test.mail/contactsEnabled']);
		assert.deepStrictEqual(s.accounts()[0].capabilityProviders.map(c => c.id), ['com.test.mail.imap', 'com.test.mail.always']);
	});
});

test('deleteAccount: hidden at once, a DELETE sync state, then the transports, the credentials and the record go', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		const denied = await s.ask('deleteAccount', {accountId: id}, {appId: 'org.other'});
		assert.match(denied.errorText, /^Permission denied!/);
		const t0 = Date.now();
		const r = await s.ask('deleteAccount', {accountId: id, keepData: true}, APP);
		assert.deepStrictEqual(r, {returnValue: true});
		// The reply waits the 1.5 s the apps are given to drop it from their lists.
		assert.ok(Date.now() - t0 >= 1400, 'answered after ' + (Date.now() - t0) + ' ms');
		assert.strictEqual(s.accounts()[0].beingDeleted, true);
		assert.deepStrictEqual((await s.ask('listAccounts', {}, APP)).results, []);
		assert.deepStrictEqual(s.tempdb.all('com.palm.account.syncstate:1').map(x => [x.accountId, x.syncState]), [[id, 'DELETE']]);
		const again = await s.ask('deleteAccount', {accountId: id}, APP);
		assert.strictEqual(again.errorText, 'MojoService: no errorCode supplied Account is being deleted');
		await new Promise(res => setTimeout(res, 2300));
		await s.settle();
		assert.strictEqual(s.accounts()[0]._del, true);
		assert.ok(!s.keys.has(id));
		assert.deepStrictEqual(s.tempdb.all('com.palm.account.syncstate:1'), []);
		const onDelete = s.callsTo('com.test.mail/onDelete');
		assert.deepStrictEqual(onDelete.map(c => c.args), [{accountId: id, keepData: true, templateId: 'com.test.mail'}]);
		const gone = await s.ask('deleteAccount', {accountId: id}, APP);
		assert.strictEqual(gone.errorText, 'MojoService: no errorCode supplied Account has been deleted');
	});
});

test('createLocalAccount: the profile account once, and the first-use flag', async () => {
	await withService({}, async s => {
		const r = await s.ask('createLocalAccount', {}, {});
		assert.deepStrictEqual(r, {returnValue: true, accountCreated: true});
		await s.settle();
		assert.ok(fs.existsSync(s.flagPath));
		const a = s.accounts()[0];
		assert.deepStrictEqual([a.templateId, a.username], ['com.palm.palmprofile', 'LuneOS']);
		assert.deepStrictEqual(await s.ask('createLocalAccount', {}, {}), {returnValue: true, accountCreated: false});
	});
});

test('setPrefs and appsChanged: the device name on the profile account; templates read again', async () => {
	await withService({}, async s => {
		await s.ask('createLocalAccount', {}, {});
		await s.settle();
		await s.ask('setPrefs', {deviceName: 'My Device'}, {});
		await s.settle();
		assert.strictEqual(s.accounts()[0].deviceName, 'My Device');
		fs.rmSync(path.join(s.roots[0], 'com.test.cal'), {recursive: true});
		assert.deepStrictEqual(await s.ask('appsChanged', {}, {}), {returnValue: true});
		const all = await s.ask('listAccountTemplates', {});
		assert.deepStrictEqual(all.results.map(t => t.templateId), ['com.palm.palmprofile', 'com.test.mail']);
		await s.settle();
		assert.deepStrictEqual(s.tempdb.all('com.palm.signaling:1').map(x => x.templates), ['com.palm.palmprofile,com.test.mail']);
	});
});

test('__quit: answered, then the service gives its name back', async () => {
	await withService({}, async s => {
		assert.deepStrictEqual(await s.ask('__quit', {}, {}), {returnValue: true});
		await new Promise(res => setTimeout(res, 150));
		assert.ok(s.service.bus.handle.unregistered);
	});
});

test('B1: a transport that fails does not stop the others, and a deleted account still goes', async () => {
	await withService({}, async s => {
		s.fail['com.test.mail/onCreate'] = 1;
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		assert.deepStrictEqual(s.callsTo('com.test.mail/').map(c => c.method).sort(), ['onCapabilitiesChanged', 'onCreate', 'onEnabled']);
		s.fail['com.test.mail/onDelete'] = 1;
		s.fail['com.test.mail/onEnabled'] = 1;
		assert.strictEqual((await s.ask('deleteAccount', {accountId: id}, APP)).returnValue, true);
		await new Promise(res => setTimeout(res, 2300));
		await s.settle();
		assert.strictEqual(s.accounts()[0]._del, true);
		assert.ok(!s.keys.has(id));
		assert.deepStrictEqual(s.tempdb.all('com.palm.account.syncstate:1'), []);
	});
});

test('B2: createAccount with a password: made only when every validator takes it', async () => {
	const VAL = {templateId: 'com.test.val', loc_name: 'Validated', validator: 'palm://com.test.val/checkCredentials',
		writePermissions: ['com.test.*'],
		capabilityProviders: [{id: 'com.test.val.mail', capability: 'MAIL', validator: 'palm://com.test.val/checkMail'}]};
	const answers = {};
	const transports = (address, args) => answers[address](args);
	await withService({templates: {'com.test.val': VAL}, transports}, async s => {
		const ask = () => s.ask('createAccount', {templateId: 'com.test.val', username: 'v@example.org',
			capabilityProviders: [{id: 'com.test.val.mail'}], password: 'fake-pw'}, {appId: 'com.test.app'});
		answers['palm://com.test.val/checkCredentials'] = () => ({returnValue: true, credentials: {common: {token: 'fake-t1'}}});
		answers['palm://com.test.val/checkMail'] = () => ({returnValue: false, errorCode: 'BAD_PW', errorText: 'turned down'});
		const r = await ask();
		assert.deepStrictEqual([r.returnValue, r.errorCode], [false, 'BAD_PW']);
		assert.match(r.errorText, /turned down$/);
		assert.ok(!/fake-pw/.test(JSON.stringify(r)));
		assert.deepStrictEqual(s.accounts(), []);
		assert.strictEqual(s.keys.size, 0);
		answers['palm://com.test.val/checkMail'] = () => ({returnValue: true, credentials: {mail: {token: 'fake-t2'}}});
		const ok = await ask();
		assert.strictEqual(ok.returnValue, true);
		assert.deepStrictEqual(JSON.parse(s.keys.get(ok.result._id)), {common: {token: 'fake-t1'}, mail: {token: 'fake-t2'}});
	});
});

test('B4: modifyAccount refused for an alwaysOn capability changes nothing, credentials included', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		await s.tempdb.handle('put', {objects: [{_kind: 'com.palm.account.syncstate:1', accountId: id, syncState: 'ERROR'}]});
		const before = s.keys.get(id);
		const refused = await s.ask('modifyAccount', {accountId: id, object: {capabilityProviders: [{id: 'com.test.mail.imap'}],
			credentials: {common: {password: 'fake-other'}}}}, APP);
		assert.deepStrictEqual([refused.errorCode, refused.errorText], ['400_BAD_REQUEST', 'can\'t disable \'alwaysOn\' capabilities']);
		assert.strictEqual(s.keys.get(id), before);
		assert.deepStrictEqual(s.tempdb.all('com.palm.account.syncstate:1').map(x => x.syncState), ['ERROR']);
	});
});

test('B5: new credentials: onCredentialsChanged to the template and the providers kept, not to those just enabled', async () => {
	await withService({}, async s => {
		const id = (await create(s, {capabilityProviders: [{id: 'com.test.mail.always'}]})).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		s.calls.splice(0);
		const r = await s.ask('modifyAccount', {accountId: id, object: {capabilityProviders: [{id: 'com.test.mail.always'}, {id: 'com.test.mail.imap'}],
			credentials: {common: {password: 'fake-new'}}}}, APP);
		assert.deepStrictEqual(r, {returnValue: true});
		assert.deepStrictEqual(s.callsTo('com.test.mail/').map(c => c.method).sort(), ['onCapabilitiesChanged', 'onCredentialsChanged', 'onEnabled']);
	});
});

test('B6: modifyAccount: each onEnabled call names its own provider', async () => {
	const TWO = {templateId: 'com.test.two', loc_name: 'Two', writePermissions: ['com.test.*'], capabilityProviders: [
		{id: 'com.test.two.a', capability: 'MAIL', onEnabled: 'palm://com.test.two/aEnabled'},
		{id: 'com.test.two.b', capability: 'CONTACTS', onEnabled: 'palm://com.test.two/bEnabled'}]};
	await withService({templates: {'com.test.two': TWO}}, async s => {
		const id = (await s.ask('createAccount', {templateId: 'com.test.two', username: 'two@example.org', capabilityProviders: []}, APP)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		const r = await s.ask('modifyAccount', {accountId: id, object: {capabilityProviders: [{id: 'com.test.two.a'}, {id: 'com.test.two.b'}]}}, APP);
		assert.deepStrictEqual(r, {returnValue: true});
		assert.deepStrictEqual(s.callsTo('com.test.two/').map(c => c.method + ' ' + c.args.capabilityProviderId).sort(),
			['aEnabled com.test.two.a', 'bEnabled com.test.two.b']);
	});
});

test('B7: a failed onCredentialsChanged fails with TRANSPORT_FAILURE and leaves the providers as they are', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		const providers = () => s.accounts()[0].capabilityProviders.map(c => c.id);
		const before = providers();
		for (const which of ['onCredentialsChanged', 'imapCredentialsChanged']) {
			s.fail['com.test.mail/' + which] = 1;
			const r = await s.ask('modifyAccount', {accountId: id, object: {credentials: {common: {password: 'fake-' + which}}}}, APP);
			assert.deepStrictEqual([r.errorCode, r.errorText], ['TRANSPORT_FAILURE', 'Failed to notify transports: palm://com.test.mail/' + which]);
			assert.deepStrictEqual(providers(), before);
		}
		s.fail['com.test.mail/imapCredentialsChanged'] = 1;
		const r = await s.ask('modifyAccount', {accountId: id, object: {capabilityProviders: [{id: 'com.test.mail.imap'}, {id: 'com.test.mail.always'}],
			credentials: {common: {password: 'fake-3'}}}}, APP);
		assert.strictEqual(r.errorCode, 'TRANSPORT_FAILURE');
		assert.deepStrictEqual(providers(), before);
	});
});

test('B8: a delete resumed by stayRunning keeps its keepData', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		// A delete cut off after its first step, as deleteAccount leaves the record.
		await s.db.handle('merge', {objects: [{_id: id, beingDeleted: true, keepData: true}]});
		assert.deepStrictEqual(await s.ask('stayRunning', {seconds: 1}, {service: 'com.palm.service.accounts'}), {returnValue: true});
		await new Promise(res => setTimeout(res, 2300));
		await s.settle();
		assert.deepStrictEqual(s.callsTo('com.test.mail/onDelete').map(c => c.args.keepData), [true]);
		assert.strictEqual(s.accounts()[0]._del, true);
	});
});

test('B8: deleteAccount keeps keepData on the record', async () => {
	await withService({}, async s => {
		const id = (await create(s)).result._id;
		await new Promise(res => setTimeout(res, 1200));
		await s.settle();
		const pending = s.ask('deleteAccount', {accountId: id, keepData: true}, APP);
		await new Promise(res => setTimeout(res, 300));
		assert.deepStrictEqual([s.accounts()[0].beingDeleted, s.accounts()[0].keepData], [true, true]);
		await pending;
		await new Promise(res => setTimeout(res, 2300));
		await s.settle();
	});
});
