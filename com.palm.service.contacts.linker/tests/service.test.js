// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service end to end on a stand-in bus, over an in-memory db8: what
	links and what does not, manual links and unlinks, the watch, and
	saveNewPersonAndContacts as the contacts app calls it. The answers are
	the ones the mojoservice linker gave (an A/B of the two on the same
	contacts is how they were found; see README.md).
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const {boot, NO_FRAMEWORKS} = require('./boot');
const {b64md5} = require('../lib/person');

const name = (givenName, familyName) => ({name: {givenName, familyName}});

describe('the linker', {skip: NO_FRAMEWORKS}, () => {
	it('registers the 13 methods of the old service', async () => {
		const env = await boot();
		const methods = env.pb.services['com.palm.service.contacts.linker'].methods.map(m => m.replace(/^\//, ''));
		for (const m of ['manualLink', 'manualUnlink', 'saveNewPersonAndContacts', 'forceAutolink',
			'dbUpdatedRelinkChanges', 'yieldAutolink', 'setupWatch', 'deleteOrphanedPerson', 'resetCLBDB',
			'performedManualLink', 'performedUnlink', 'getManualLinks', 'getUnlinkLinks']) {
			assert.ok(methods.includes(m), m);
		}
		env.stop();
	});

	it('links contacts with the same name, and keeps others apart', async () => {
		const env = await boot();
		const [a, b, c] = await env.putContacts([name('Ann', 'Lee'), name('ann', 'LEE'), name('Bob', 'Lee')]);
		assert.equal(await env.ask('forceAutolink'), true);
		assert.equal(env.persons().length, 2);
		assert.deepEqual(env.personOf(a._id).contactIds.slice().sort(), [a._id, b._id].sort());
		assert.deepEqual(env.personOf(c._id).contactIds, [c._id]);
		env.stop();
	});

	it('links on an email whatever its case', async () => {
		const env = await boot();
		const [c, d] = await env.putContacts([{emails: [{value: 'Ann@Example.com'}]}, {emails: [{value: 'ann@example.com '}]}]);
		await env.ask('forceAutolink');
		assert.equal(env.personOf(c._id)._id, env.personOf(d._id)._id);
		env.stop();
	});

	it('does not link on a 10-digit mobile number, not even the same one (README: Q7.15)', async () => {
		// The old service looked a mobile number up by a key (Globalization's subscriber number)
		// that is not a prefix of the one the person stores it under (phonenumberlib's), for a
		// 10-digit US number. Kept until the commit that mends it.
		const env = await boot();
		const [a, b] = await env.putContacts([{phoneNumbers: [{value: '2125551111', type: 'type_mobile'}]},
			{phoneNumbers: [{value: '2125551111', type: 'type_mobile'}]}]);
		await env.ask('forceAutolink');
		assert.notEqual(env.personOf(a._id)._id, env.personOf(b._id)._id);
		env.stop();
	});

	it('manualLink joins two persons and remembers it; manualUnlink parts them for good', async () => {
		const env = await boot();
		const [a, b] = await env.putContacts([name('Ann', 'Lee'), name('Bob', 'Kay')]);
		await env.ask('forceAutolink');
		const pa = env.personOf(a._id), pb = env.personOf(b._id);
		assert.equal(await env.ask('manualLink', {personToLinkTo: pa._id, personToLink: pb._id}), true);
		assert.deepEqual(env.personOf(b._id)._id, pa._id);
		assert.equal(env.db.all('com.palm.manualLink:1').length, 1);

		const r = await env.ask('manualUnlink', {personToRemoveLinkFrom: pa._id, contactToRemoveFromPerson: b._id});
		assert.equal(r.returnValue, true);
		assert.notEqual(env.personOf(b._id)._id, pa._id);
		assert.equal(env.db.all('com.palm.manualUnlink:1').length, 1);

		// Same name now, but the unlink outweighs it.
		await env.db.merge([{_id: b._id, name: {givenName: 'Ann', familyName: 'Lee'}}]);
		await env.ask('forceAutolink');
		assert.notEqual(env.personOf(a._id)._id, env.personOf(b._id)._id);
		env.stop();
	});

	it('answers a missing argument as the old service did', async () => {
		const env = await boot();
		const r = await env.ask('manualLink', {});
		assert.equal(r.returnValue, false);
		assert.equal(r.errorCode, -9999);
		assert.equal(r.errorText, 'MojoService: no errorCode supplied The \'personToLinkTo\' parameter was not ' +
			'specified. The \'personToLink\' parameter was not specified.');
		env.stop();
	});

	it('relinks what changed when the watch fires, and rearms it at the _rev it reached', async () => {
		const env = await boot();
		await env.putContacts([name('Ann', 'Lee')]);
		await env.ask('forceAutolink');
		const [b] = await env.putContacts([name('Ann', 'Lee')]);
		const rev = env.db.records.get(b._id)._rev;
		env.calls.length = 0;
		assert.equal(await env.ask('dbUpdatedRelinkChanges', {revChangedStart: rev - 1, $activity: {activityId: 7}}), true);
		assert.equal(env.persons().length, 1);
		const complete = env.calls.find(c => c.method === 'complete');
		assert.equal(complete.args.activityId, 7);
		assert.equal(complete.args.callback.params.revChangedStart, rev);
		env.stop();
	});

	it('adopts the activity activitymanager calls back with, answers at once, and completes it', async () => {
		const env = await boot();
		await env.putContacts([name('Ann', 'Lee'), name('Ann', 'Lee')]);
		const r = await env.ask('dbUpdatedRelinkChanges', {revChangedStart: 0, $activity: {activityId: 7}},
			{service: 'com.palm.activitymanager'});
		assert.deepEqual(r, {returnValue: true});
		assert.equal(env.persons().length, 1);
		const am = env.calls.filter(c => c.service === 'com.palm.activitymanager').map(c => c.method);
		assert.deepEqual(am, ['adopt', 'complete']);
		assert.equal(env.calls.find(c => c.method === 'adopt').args.activityId, 7);
		env.stop();
	});

	it('runs nothing for a callback it cannot adopt', async () => {
		const env = await boot({adopt: 'busy'});
		await env.putContacts([name('Ann', 'Lee'), name('Ann', 'Lee')]);
		const r = await env.ask('dbUpdatedRelinkChanges', {revChangedStart: 0, $activity: {activityId: 7}},
			{service: 'com.palm.activitymanager'});
		assert.equal(r.returnValue, true);
		assert.equal(r.status, 'adopt failed');
		assert.match(r.error, /adopt \{"activityId":7,"subscribe":true,"wait":true\}: Resource temporarily unavailable$/);
		assert.equal(env.persons().length, 0);
		assert.equal(env.calls.filter(c => c.method === 'complete' || c.method === 'create').length, 0);
		env.stop();
	});

	it('waits for an activity still held, and runs when it is handed over', async () => {
		// After a run completes linkerWatch with restart:true and contacts are left, activitymanager
		// calls back before that run lets go of it; the old service's adopt failed and linkerWatch
		// stopped (README.md).
		const env = await boot({adopt: 'queued'});
		await env.putContacts([name('Ann', 'Lee'), name('Ann', 'Lee')]);
		const r = await env.send('dbUpdatedRelinkChanges', {revChangedStart: 0, $activity: {activityId: 7}},
			{service: 'com.palm.activitymanager'});
		assert.deepEqual(r, {returnValue: true});
		await env.settle();
		assert.equal(env.calls.find(c => c.method === 'adopt').args.wait, true);
		assert.equal(env.persons().length, 0);
		assert.ok(!env.calls.some(c => c.method === 'complete'));
		env.handOver('orphan');
		await env.settle();
		assert.equal(env.persons().length, 1);
		assert.equal(env.calls.find(c => c.method === 'complete').args.activityId, 7);
		env.stop();
	});

	it('runs nothing when the activity it waits for is cancelled', async () => {
		const env = await boot({adopt: 'queued'});
		await env.putContacts([name('Ann', 'Lee'), name('Ann', 'Lee')]);
		await env.send('dbUpdatedRelinkChanges', {revChangedStart: 0, $activity: {activityId: 7}},
			{service: 'com.palm.activitymanager'});
		await env.settle();
		env.handOver('cancel');
		await env.settle();
		assert.equal(env.persons().length, 0);
		assert.equal(env.calls.filter(c => c.method === 'complete' || c.method === 'create').length, 0);
		// It has given up: the same callback again is taken as a new one, not as a repeat.
		const again = await env.send('dbUpdatedRelinkChanges', {revChangedStart: 0, $activity: {activityId: 7}},
			{service: 'com.palm.activitymanager'});
		assert.deepEqual(again, {returnValue: true});
		env.handOver('cancel');
		await env.settle();
		env.stop();
	});

	it('runs a callback delivered again while the first runs only once', async () => {
		const env = await boot({adopt: 'queued'});
		await env.putContacts([name('Ann', 'Lee'), name('Ann', 'Lee')]);
		const cb = {revChangedStart: 0, $activity: {activityId: 7}};
		await env.send('dbUpdatedRelinkChanges', cb, {service: 'com.palm.activitymanager'});
		await env.settle();
		const again = await env.send('dbUpdatedRelinkChanges', cb, {service: 'com.palm.activitymanager'});
		assert.equal(again.returnValue, true);
		assert.match(again.status, /from _rev 0 delivered again while it runs$/);
		env.handOver('orphan');
		await env.settle();
		assert.equal(env.calls.filter(c => c.method === 'adopt').length, 1);
		assert.equal(env.calls.filter(c => c.method === 'complete').length, 1);
		// Once it is done, the same _rev is a new callback (a run that reached no further).
		await env.send('dbUpdatedRelinkChanges', cb, {service: 'com.palm.activitymanager'});
		await env.settle();
		assert.equal(env.calls.filter(c => c.method === 'adopt').length, 2);
		env.handOver('orphan');
		await env.settle();
		assert.equal(env.calls.filter(c => c.method === 'complete').length, 2);
		env.stop();
	});

	it('monitors an activity an app passes, rather than adopting it', async () => {
		const env = await boot();
		await env.ask('dbUpdatedRelinkChanges', {revChangedStart: 0, $activity: {activityId: 7}}, {appId: 'com.palm.app.contacts'});
		assert.ok(env.calls.some(c => c.method === 'monitor'));
		assert.ok(!env.calls.some(c => c.method === 'adopt'));
		env.stop();
	});

	it('forceAutolink links every contact, not only the first page of 500', async () => {
		const env = await boot();
		const list = [name('Ann', 'Lee')];
		for (let i = 0; i < 598; i++) {
			list.push({note: 'n' + i});
		}
		list.push(name('Ann', 'Lee'));
		const put = await env.putContacts(list);
		assert.equal(await env.ask('forceAutolink'), true);
		assert.equal(env.persons().length, 599);
		assert.deepEqual(env.personOf(put[599]._id).contactIds.slice().sort(), [put[0]._id, put[599]._id].sort());
		env.stop();
	});

	it('takes a deleted contact out of its person, and deletes a person left with none', async () => {
		const env = await boot();
		const [a, b] = await env.putContacts([name('Ann', 'Lee'), name('Ann', 'Lee')]);
		await env.ask('forceAutolink');
		await env.db.del([a._id]);
		await env.ask('forceAutolink');
		assert.deepEqual(env.personOf(b._id).contactIds, [b._id]);
		await env.db.del([b._id]);
		await env.ask('forceAutolink');
		assert.equal(env.persons().length, 0);
		env.stop();
	});

	it('deleteOrphanedPerson answers at once, then deletes the person if it has no contacts', async () => {
		const env = await boot();
		const [r] = await env.db.put([{_kind: 'com.palm.person:1', contactIds: []}]);
		assert.deepEqual(await env.ask('deleteOrphanedPerson', {personId: r.id}), {returnValue: true});
		await env.settle();
		assert.equal(env.persons().length, 0);
		env.stop();
	});

	it('yieldAutolink wants a job id', async () => {
		const env = await boot();
		const r = await env.ask('yieldAutolink', {});
		assert.equal(r.returnValue, false);
		env.stop();
	});
});

describe('saveNewPersonAndContacts', {skip: NO_FRAMEWORKS}, () => {
	it('saves the person first with the new contact\'s id, then the contact, and shows it', async () => {
		const env = await boot();
		const r = await env.ask('saveNewPersonAndContacts', {person: {favorite: true},
			contacts: [Object.assign(name('Ann', 'Lee'), {_kind: 'com.palm.contact.palmprofile:1',
				phoneNumbers: [{value: '2125551111', type: 'type_mobile'}]})]});
		assert.equal(r.returnValue, true);
		assert.equal(r.saveResult, true);
		assert.equal(r.contacts.length, 1);
		const id = r.contacts[0]._id;
		assert.deepEqual(r.person.contactIds, [id]);
		assert.equal(r.person.favorite, true);
		assert.ok(env.db.records.get(id), 'the contact is in db8');
		assert.equal(env.personOf(id)._id, r.person._id);
		// The contact's phone entry has what the person's entry was given.
		assert.equal(r.contacts[0].phoneNumbers[0].speedDial, '');
		assert.deepEqual(r.contacts[0].phoneNumbers[0].favoriteData, {});
		assert.ok(r.contacts[0].phoneNumbers[0].normalizedValue);
		// Every field, with its default.
		assert.deepEqual(r.contacts[0].emails, []);
		assert.equal(r.contacts[0].birthday, '');
		env.stop();
	});

	it('gives the new contact\'s entry the speed dial its person got back from a backup', async () => {
		// The framework's person and contact shared their entries, so a speed dial restored onto the
		// person's number was on the contact's number too, in the reply and in db8 (A/B seed 24).
		const env = await boot();
		const [old] = await env.putContacts([Object.assign(name('Ann', 'Lee'), {remoteId: 'R1'})]);
		await env.db.put([{_kind: 'com.palm.person.speeddialbackup:1', contactBackupHash: 'Local|R1',
			speedDials: [{hashedPhoneNumber: b64md5('5551234'), key: '4'}]}]);
		const r = await env.ask('saveNewPersonAndContacts', {person: {}, contacts: [{_id: old._id},
			Object.assign(name('Ann', 'Lee'), {_kind: 'com.palm.contact.palmprofile:1',
				phoneNumbers: [{value: '5551234', type: 'type_fax'}]})]});
		assert.equal(r.returnValue, true);
		const phone = r.contacts[0].phoneNumbers[0];
		assert.equal(phone.speedDial, '4');
		assert.equal(env.db.records.get(r.contacts[0]._id).phoneNumbers[0].speedDial, '4');
		env.stop();
	});

	it('gives the second of two contacts that have an _id a new one (README: Q7.5)', async () => {
		// The loop that takes out the contacts with an _id splices as it goes and skips the one after.
		const env = await boot();
		const [a, b] = await env.putContacts([name('Ann', 'Lee'), name('Bob', 'Kay')]);
		const r = await env.ask('saveNewPersonAndContacts', {person: {}, contacts: [
			{_id: a._id, _kind: 'com.palm.contact.palmprofile:1'}, {_id: b._id, _kind: 'com.palm.contact.palmprofile:1'}]});
		assert.equal(r.contacts.length, 1);
		assert.notEqual(r.contacts[0]._id, b._id);
		assert.deepEqual(r.person.contactIds, [a._id, r.contacts[0]._id]);
		env.stop();
	});

	it('wants a person and an array of contacts', async () => {
		const env = await boot();
		const r = await env.ask('saveNewPersonAndContacts', {person: {}});
		assert.equal(r.errorText, 'MojoService: no errorCode supplied Autolinker.saveNewPersonAndContacts: ' +
			'You must specify an array of contacts to save.');
		env.stop();
	});
});

describe('the manual unlink lookups', {skip: NO_FRAMEWORKS}, () => {
	it('are made for every contact of the matching persons at once, and the first failure is the answer', async () => {
		// Autolinker.manualUnlinks ran them through Foundations' mapReduce: all at once, and the
		// first to fail was the error once all were done. One after the other, a failing first
		// contact would hide the lookups of the next, and a later failure could be the answer
		// instead (A/B seed 38).
		const env = await boot();
		const [bad, good] = await env.putContacts([
			Object.assign(name('Ann', 'Lee'), {_kind: 'com.palm.contact.libpurple:1', accountId: 'acct-none'}),
			Object.assign(name('Ann', 'Lee'), {remoteId: 'R7'})
		]);
		await env.db.put([{_kind: 'com.palm.person:1', contactIds: [bad._id, good._id],
			names: [{givenName: 'Ann', familyName: 'Lee'}]}]);
		const [x] = await env.putContacts([name('Ann', 'Lee')]);
		env.calls.length = 0;
		const r = await env.ask('dbUpdatedRelinkChanges', {revChangedStart: env.db.records.get(x._id)._rev - 1});
		assert.equal(r.returnValue, false);
		assert.match(r.errorText, /getAccountInfo \{"accountId":"acct-none"\}: no account acct-none$/);
		assert.ok(env.calls.some(c => c.method === 'find' && c.args.query.from === 'com.palm.manualUnlink:1' &&
			c.args.query.where[0].val === 'Local|R7'), 'no unlink lookup for the contact after the failing one');
		env.stop();
	});
});
