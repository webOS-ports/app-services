// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	restoreCompleted and the profile account. First use always leaves a
	palmprofile account (createLocalAccount, or the community account sign-in);
	restoring a backup afterwards puts the backed-up one back under its own
	_id and deletes nothing, so there were two, the restored data pointing at
	the old one. Seen on a Pixel 3a. The profile accounts made on the device
	are kept in a list next to the first-use flag, and after a restore the one
	from the backup is kept.

	A restore is stood in for by putting the backed-up account straight into
	db8 under its own _id, as com.palm.db's load does.
*/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {boot} = require('./boot');

const PROFILE_ID = 'com.palm.palmprofile';
const PROFILE = {templateId: PROFILE_ID, loc_name: 'Profile', writePermissions: [],
	capabilityProviders: [{id: 'com.palm.palmprofile.contacts', capability: 'CONTACTS'}, {id: 'com.palm.palmprofile.calendar', capability: 'CALENDAR'}]};
const MAIL = {templateId: 'com.test.mail', loc_name: 'Test Mail', writePermissions: ['com.test.*'],
	capabilityProviders: [{id: 'com.test.mail.imap', capability: 'MAIL'}]};
// The accounts service itself may write any template; the bridge's own permission is in profile-template.test.js.
const AS_SERVICE = {appId: 'com.palm.service.accounts'};
const BACKUP = {appId: 'com.palm.app.backup'};

async function withService(fn) {
	const s = await boot({templates: {[PROFILE_ID]: PROFILE, 'com.test.mail': MAIL}});
	try {
		await fn(s);
	} finally {
		s.stop();
	}
}

const madeHerePath = s => path.join(path.dirname(s.flagPath), 'accounts-profiles-made-here.json');
const madeHere = s => JSON.parse(fs.readFileSync(madeHerePath(s), 'utf8'));
const live = s => s.accounts().filter(a => a.templateId === PROFILE_ID && !a._del && !a.beingDeleted);

async function waitFor(what, cond, ms = 8000) {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) {
			throw new Error('timed out waiting for ' + what);
		}
		await new Promise(r => setTimeout(r, 20));
	}
}

// What com.palm.db's restore does with the account from the backup.
async function restoreAccount(s, _id, username) {
	await s.db.handle('put', {objects: [{_kind: 'com.palm.account:1', _id, _sync: true, templateId: PROFILE_ID,
		username, beingDeleted: false, capabilityProviders: [{id: 'com.palm.palmprofile.contacts', capability: 'CONTACTS'}]}]});
}

async function firstUse(s) {
	assert.deepStrictEqual(await s.ask('createLocalAccount', {}, {}), {returnValue: true, accountCreated: true});
	await waitFor('the local profile', () => live(s).length === 1);
	return live(s)[0]._id;
}

test('the profile accounts made here are written down, and only those', async () => {
	await withService(async s => {
		const id = await firstUse(s);
		await s.ask('createAccount', {templateId: 'com.test.mail', username: 'a@example.org',
			capabilityProviders: [{id: 'com.test.mail.imap'}]}, {appId: 'com.test.app'});
		assert.deepStrictEqual(madeHere(s), [id]);
		assert.strictEqual(fs.statSync(madeHerePath(s)).mode & 0o777, 0o600);
		assert.deepStrictEqual(fs.readdirSync(path.dirname(s.flagPath)).filter(f => f.endsWith('.tmp')), []);
	});
});

test('first use, then a restore: the restored profile is kept, the one first use made goes', async () => {
	await withService(async s => {
		const made = await firstUse(s);
		await restoreAccount(s, 'OLDPROFILE1', 'LuneOS');
		assert.strictEqual(live(s).length, 2);

		assert.deepStrictEqual(await s.ask('restoreCompleted', {}, BACKUP), {returnValue: true});
		assert.deepStrictEqual(live(s).map(a => a._id), ['OLDPROFILE1'], 'at once out of the lists');
		await waitFor('the surplus profile deleted', () => s.accounts().some(a => a._id === made && a._del));
		assert.deepStrictEqual(s.accounts().filter(a => a.templateId === PROFILE_ID && !a._del).map(a => a._id),
			['OLDPROFILE1']);
		assert.strictEqual(live(s)[0].username, 'LuneOS');
		assert.deepStrictEqual(madeHere(s), ['OLDPROFILE1'], 'the kept one is this device\'s now');
		assert.ok(fs.existsSync(s.flagPath), 'and first use stays done');
	});
});

test('a name signed in to during first use goes over to the restored profile', async () => {
	await withService(async s => {
		// What the community account bridge does when nobody made a profile yet.
		const r = await s.ask('createAccount', {templateId: PROFILE_ID, username: 'Herrie',
			capabilityProviders: [{id: 'com.palm.palmprofile.contacts'}], credentials: {}}, AS_SERVICE);
		const made = r.result._id;
		await restoreAccount(s, 'OLDPROFILE1', 'LuneOS');
		await s.ask('restoreCompleted', {}, BACKUP);
		await waitFor('the surplus profile deleted', () => s.accounts().some(a => a._id === made && a._del));
		assert.deepStrictEqual(live(s).map(a => [a._id, a.username]), [['OLDPROFILE1', 'Herrie']]);
	});
});

test('without a sign-in here, the restored profile keeps its own name', async () => {
	await withService(async s => {
		const made = await firstUse(s);
		await restoreAccount(s, 'OLDPROFILE1', 'Herrie');
		await s.ask('restoreCompleted', {}, BACKUP);
		await waitFor('the surplus profile deleted', () => s.accounts().some(a => a._id === made && a._del));
		assert.deepStrictEqual(live(s).map(a => [a._id, a.username]), [['OLDPROFILE1', 'Herrie']]);
	});
});

test('restoring this device\'s own backup leaves its one profile alone', async () => {
	await withService(async s => {
		const made = await firstUse(s);
		await restoreAccount(s, made, 'LuneOS');
		await s.ask('restoreCompleted', {}, BACKUP);
		await s.settle(100);
		assert.deepStrictEqual(live(s).map(a => a._id), [made]);
		assert.deepStrictEqual(s.callsTo('com.palm.service.accounts/notifyAccountDeleted'), []);
	});
});

test('two profiles it cannot tell apart are left as they are', async () => {
	await withService(async s => {
		// No list (a device from before it was kept), or both from the backup.
		await restoreAccount(s, 'OLDPROFILE1', 'LuneOS');
		await restoreAccount(s, 'OLDPROFILE2', 'LuneOS');
		await s.ask('restoreCompleted', {}, BACKUP);
		await s.settle(100);
		assert.deepStrictEqual(live(s).map(a => a._id).sort(), ['OLDPROFILE1', 'OLDPROFILE2']);
		assert.deepStrictEqual(s.callsTo('com.palm.service.accounts/notifyAccountDeleted'), []);
	});
});

test('a backup that already had two profiles: nothing is picked from them', async () => {
	await withService(async s => {
		const made = await firstUse(s);
		await restoreAccount(s, 'OLDPROFILE1', 'LuneOS');
		await restoreAccount(s, 'OLDPROFILE2', 'LuneOS');
		await s.ask('restoreCompleted', {}, BACKUP);
		await s.settle(100);
		assert.deepStrictEqual(live(s).map(a => a._id).sort(), [made, 'OLDPROFILE1', 'OLDPROFILE2'].sort());
		assert.deepStrictEqual(s.callsTo('com.palm.service.accounts/notifyAccountDeleted'), []);
		assert.deepStrictEqual(madeHere(s), [made]);
	});
});

test('a list that is not one is taken as no list', async () => {
	await withService(async s => {
		await firstUse(s);
		fs.writeFileSync(madeHerePath(s), '{"not": "a list"');
		await restoreAccount(s, 'OLDPROFILE1', 'LuneOS');
		await s.ask('restoreCompleted', {}, BACKUP);
		await s.settle(100);
		assert.strictEqual(live(s).length, 2, 'nothing deleted on a guess');
	});
});

test('the other accounts are set up after a restore as before', async () => {
	await withService(async s => {
		await firstUse(s);
		await s.ask('createAccount', {templateId: 'com.test.mail', username: 'a@example.org',
			capabilityProviders: [{id: 'com.test.mail.imap'}]}, {appId: 'com.test.app'});
		await restoreAccount(s, 'OLDPROFILE1', 'LuneOS');
		await s.ask('restoreCompleted', {}, BACKUP);
		await s.settle(100);
		assert.strictEqual(s.accounts().filter(a => a.templateId === 'com.test.mail' && !a._del).length, 1);
	});
});
