// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The parts that need no device frameworks: the mojoservice reply envelope,
	the PalmCall error text, the watch's rearm, job ids, the contact order of
	a merged person, link hashes, and how saveNewPersonAndContacts takes in
	and shows a contact, and the normalised phone numbers (over a stand-in
	phonenumberlib).
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

const mojo = require('../lib/mojo');
const watch = require('../lib/watch');
const {createJobIds, orderContactIds} = require('../lib/autolinker');
const {createLinkHash, idPart} = require('../lib/linkhash');
const {takeIn, shown} = require('../lib/savenew');
const {meetsThreshold, SIMILAR} = require('../lib/rankers');
const {createModel} = require('../lib/model');

describe('the mojoservice reply', () => {
	it('adds returnValue to an object, keeps true and a sentence as they are', () => {
		assert.deepEqual(mojo.reply({a: 1}), {a: 1, returnValue: true});
		assert.equal(mojo.reply(true), true);
		assert.equal(mojo.reply('Yield is not necessary'), 'Yield is not necessary');
		assert.deepEqual(mojo.reply(undefined), {returnValue: true});
		assert.deepEqual(mojo.reply(0), {returnValue: true});
	});

	it('an error with no errorCode becomes -9999 with the MojoService prefix', () => {
		const e = mojo.exception(new Error('boom'));
		assert.equal(e.errorCode, -9999);
		assert.equal(e.errorText, 'MojoService: no errorCode supplied boom');
		assert.equal(e.returnValue, false);
		assert.match(e.exception, /^Error: boom/);
	});

	it('an error with its own errorCode keeps it and its text', () => {
		const err = new Error('gone');
		err.errorCode = -3;
		assert.deepEqual(Object.assign(mojo.exception(err), {exception: ''}),
			{errorText: 'gone', errorCode: -3, exception: '', returnValue: false});
	});

	it('a command still running after its timeout answers 504', async () => {
		const m = mojo.method('svc', 'slow', () => new Promise(() => {}), {timeoutS: 0.05, log: {error() {}}});
		// The timeout's timer does not hold the process open; this does.
		const hold = setTimeout(() => {}, 1000);
		const r = await m.handler({});
		clearTimeout(hold);
		assert.equal(r.errorCode, 504);
		assert.equal(r.errorText, 'commandTimeout in svc/slow');
		assert.equal(m.raw, true);
	});
});

describe('PalmCall errors', () => {
	const failing = e => mojo.palmCall(async () => {
		throw e;
	});
	const busError = (code, text) => Object.assign(new Error(text), {errorCode: code, errorText: text});

	it('the reply\'s code and text after "palm://<uri> <args>: "', async () => {
		const call = failing(busError(-3, 'no account x'));
		await assert.rejects(call('luna://com.palm.service.accounts/getAccountInfo', {accountId: 'x'}), e => {
			assert.equal(e.message, 'palm://com.palm.service.accounts/getAccountInfo {"accountId":"x"}: no account x');
			assert.equal(e.errorCode, -3);
			return true;
		});
	});

	it('a reply with no errorCode is -1', async () => {
		await assert.rejects(failing(busError('BUS_ERROR', 'bad'))('luna://a/b', {}), e => e.errorCode === -1 &&
			e.message === 'palm://a/b {}: bad');
	});

	it('a reply with no errorText is "Unknown PalmCall failure"', async () => {
		await assert.rejects(failing(busError('BUS_ERROR', 'luna://a/b failed'))('luna://a/b', {}),
			e => e.message === 'palm://a/b {}: Unknown PalmCall failure' && e.errorCode === -1);
		await assert.rejects(failing(busError(7, 'luna://a/b failed'))('luna://a/b', {}),
			e => e.message === 'palm://a/b {}: Unknown PalmCall failure' && e.errorCode === 7);
	});

	it('a bus timeout is passed on as it is', async () => {
		const t = busError('BUS_TIMEOUT', 'luna://a/b timed out');
		await assert.rejects(failing(t)('luna://a/b', {}), e => e === t);
	});
});

describe('the watch', () => {
	function recorder(failComplete) {
		const calls = [];
		return {calls, call: async (uri, args) => {
			calls.push({uri, args});
			if (failComplete && uri.endsWith('/complete')) {
				throw new Error('Activity ID not found');
			}
			return {returnValue: true};
		}, log: {log() {}}};
	}

	it('is completed with restart and the _rev the run reached', async () => {
		const r = recorder(false);
		assert.equal(await watch.rearm(r, 42, {activityId: 7}), 'completed');
		assert.equal(r.calls.length, 1);
		assert.deepEqual(r.calls[0].args, {activityId: 7, restart: true, trigger: watch.trigger(42),
			callback: watch.callback(42)});
		assert.deepEqual(r.calls[0].args.trigger.params.query.where, [{prop: '_rev', op: '>', val: 42}]);
	});

	it('is created again, replacing any of its name, when it cannot be completed', async () => {
		const r = recorder(true);
		assert.equal(await watch.rearm(r, 5, {activityId: 7}), 'created');
		assert.deepEqual(r.calls[1].args, watch.activitySpec(5));
		assert.equal(r.calls[1].args.replace, true);
		assert.equal(r.calls[1].args.activity.name, 'linkerWatch');
	});

	it('is left alone for a call that came from no activity', async () => {
		const r = recorder(false);
		assert.equal(await watch.rearm(r, 5, undefined), 'none');
		assert.equal(r.calls.length, 0);
	});

	it('watches from -1 when it has no number', () => {
		assert.equal(watch.watchRevision('12'), -1);
		assert.equal(watch.watchRevision(undefined), -1);
		assert.equal(watch.watchRevision(NaN), -1);
		assert.equal(watch.watchRevision(12), 12);
	});
});

describe('job ids', () => {
	it('count aaa, aab, ... and wrap after zzz', () => {
		const next = createJobIds();
		assert.equal(next(), 'aaa');
		assert.equal(next(), 'aab');
		for (let i = 2; i < 26; i++) {
			next();
		}
		assert.equal(next(), 'aba');
		for (let i = 27; i < 26 * 26 * 26; i++) {
			next();
		}
		assert.equal(next(), 'aaa');
	});
});

describe('the contact order of a merged person', () => {
	const c = (id, kind) => ({_id: id, _kind: 'com.palm.contact.' + kind + ':1'});

	it('keeps the person\'s first contact first, then merges by sync source priority', () => {
		const person = {contacts: [c('p1', 'sim'), c('p2', 'google')]};
		const other = {contacts: [c('o1', 'eas'), c('o2', 'libpurple')]};
		assert.deepEqual(orderContactIds(person, [other]), ['p1', 'o1', 'p2', 'o2']);
	});

	it('puts a new contact in by its priority, keeping each person\'s own order', () => {
		const person = {contacts: [c('p1', 'sim'), c('p2', 'google')]};
		assert.deepEqual(orderContactIds(person, [], c('n', 'palmprofile')), ['n', 'p1', 'p2']);
		assert.deepEqual(orderContactIds(person, [], c('n', 'libpurple')), ['p1', 'p2', 'n']);
	});

	it('takes the earlier array on a tie', () => {
		const person = {contacts: [c('p0', 'google'), c('p1', 'eas')]};
		const other = {contacts: [c('o1', 'eas')]};
		assert.deepEqual(orderContactIds(person, [other]), ['p0', 'p1', 'o1']);
	});
});

describe('link hashes', () => {
	const accounts = {
		'acct-g': {username: 'u@gmail.com', capabilityProviders: [
			{id: 'com.google.contacts', dbkinds: {contact: 'com.palm.contact.google:1'}}]}
	};
	const call = async (uri, args) => {
		const a = accounts[args.accountId];
		if (!a) {
			throw new Error('no account');
		}
		return {returnValue: true, result: a};
	};
	const {linkHash, linkHashNow} = createLinkHash({call});

	it('of a local, SIM and AT&T contact, at once', () => {
		assert.deepEqual(linkHashNow({_id: 'a', _kind: 'com.palm.contact.palmprofile:1', remoteId: 'R1'}),
			{linkHash: 'Local|R1', shouldBackup: true});
		assert.deepEqual(linkHashNow({_id: 'a', _kind: 'com.palm.contact.palmprofile:1'}),
			{linkHash: 'Local|~~:(!)~~a', shouldBackup: false});
		assert.deepEqual(linkHashNow({_id: 's', _kind: 'com.palm.contact.sim:1', remoteId: 'R'}),
			{linkHash: 'SIM|~~:(!)~~s', shouldBackup: false});
		assert.equal(linkHashNow({_id: 'g', _kind: 'com.palm.contact.google:1'}), undefined);
	});

	it('of an account\'s contact: the capability provider and the account\'s user name', async () => {
		assert.deepEqual(await linkHash({_id: 'g', _kind: 'com.palm.contact.google:1', accountId: 'acct-g',
			remoteId: 'R9'}), {linkHash: 'com.google.contacts|R9|u@gmail.com', shouldBackup: true});
		assert.equal(idPart('com.google.contacts|R9|u@gmail.com'), 'R9');
	});

	it('fails with the accounts service', async () => {
		await assert.rejects(linkHash({_id: 'g', _kind: 'com.palm.contact.google:1', accountId: 'nope'}));
	});
});

describe('a new contact as saveNewPersonAndContacts takes it in', () => {
	it('gets the framework\'s defaults written into its own objects', () => {
		const phone = {value: '555'};
		const c = takeIn({name: {givenName: 'A'}, phoneNumbers: [phone], organizations: [{name: 'X'}]});
		assert.equal(c.phoneNumbers[0], phone);
		assert.equal(phone.type, '');
		assert.equal(phone.primary, false);
		assert.equal(c.name.familyName, '');
		assert.equal(typeof c.organizations[0].location, 'object');
		assert.equal(c.organizations[0].location._origData, undefined);
	});

	it('is shown with every field, its own keys first', () => {
		const s = shown({_id: 'x', _kind: 'k', tags: 'one'});
		assert.deepEqual(Object.keys(s).slice(0, 3), ['_id', '_kind', 'tags']);
		assert.deepEqual(s.tags, ['one']);
		assert.deepEqual(s.emails, []);
		assert.deepEqual(s.syncSource, {name: null, extended: {}});
	});
});

describe('similarity', () => {
	it('links at 100, and a manual unlink outweighs everything', () => {
		assert.equal(meetsThreshold({weight: 100}), true);
		assert.equal(meetsThreshold({weight: 99}), false);
		const all = SIMILAR.name.weight + SIMILAR.mobile.weight + SIMILAR.email.weight + SIMILAR.im.weight;
		assert.equal(meetsThreshold({weight: all + SIMILAR.manualUnlink.weight}), false);
	});
});

describe('normalised phone numbers', () => {
	// phonenumberlib's parse of a US number with no leading digit, counted.
	function parser() {
		const P = {parses: 0, Parse(value) {
			P.parses++;
			const digits = value.replace(/\D/g, '');
			return digits ? {regionMetaData: {countryCode: '1'}, leadingDigit: '', nationalNumber: digits} : undefined;
		}};
		return P;
	}

	it('the stored and the search form of one number, asked for in either order', () => {
		for (const searchFirst of [true, false]) {
			const model = createModel({G: {}, P: parser()});
			const ask = [['408-555-1234', true], ['408-555-1234', false]];
			for (const [value, search] of searchFirst ? ask : ask.reverse()) {
				assert.equal(model.normalizePhoneNumber(value, search), search ? '-4321555804-' : '-4321555804--1-+');
			}
		}
	});

	it('parses a number once, however often it is asked for', () => {
		const P = parser();
		const model = createModel({G: {}, P});
		for (let i = 0; i < 3; i++) {
			assert.equal(model.normalizePhoneNumber('555 1234', true), '-4321555-');
			assert.equal(model.normalizePhoneNumber('555 1234'), '-4321555--1-+');
		}
		assert.equal(P.parses, 2);
	});

	it('a number with no digits, and an object, keep the old forms', () => {
		const model = createModel({G: {}, P: parser()});
		assert.equal(model.normalizePhoneNumber('abc'), '-cba---');
		assert.equal(model.normalizePhoneNumber({subscriberNumber: '123'}, true), '-321-');
		assert.throws(() => model.normalizePhoneNumber(5), /number passed is not a string or an object/);
	});
});
