// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// The rules on their own: model.js, templates.js, palmcall.js, keystore.js, mojo.js, under.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../lib/model');
const {createTemplates, localized, currentLocale} = require('../lib/templates');
const {createPalmCall, mapReduce, address} = require('../lib/palmcall');
const {createKeyStore} = require('../lib/keystore');
const {reply, exception} = require('../lib/mojo');
const _ = require('../lib/under');
const {quiet} = require('./boot');

test('annotate: template properties win, providers get the template provider laid over them', () => {
	const templates = [{templateId: 't', loc_name: 'T', username: 'from template',
		capabilityProviders: [{id: 'a', capability: 'MAIL', onEnabled: 'palm://x/on'}, {id: 'b', capability: 'CONTACTS'}]}];
	const acct = M.annotate(M.account({_id: 'A1', templateId: 't', username: 'u', capabilityProviders: [{id: 'a', _id: '1'}, {id: 'zz'}]}),
		templates, quiet);
	assert.strictEqual(acct.username, 'from template');
	assert.strictEqual(acct._kind, 'com.palm.account:1');
	assert.deepStrictEqual(acct.capabilityProviders, [{id: 'a', _id: '1', capability: 'MAIL', onEnabled: 'palm://x/on'}, {id: 'zz'}]);
	assert.throws(() => M.annotate({templateId: 'nope', capabilityProviders: []}, templates, quiet), /template not found: nope/);
	assert.throws(() => M.annotate({templateId: 't'}, templates, quiet), /reading 'map'/);
});

test('hasPermission: the accounts app and service, template globs, the process number stripped', () => {
	const t = {templateId: 't', writePermissions: ['com.test.*', 'org.app?']};
	assert.ok(M.hasPermission('writePermissions', t, {appId: 'com.palm.app.accounts 123', sender: ''}, quiet));
	assert.ok(M.hasPermission('writePermissions', {}, {appId: '', sender: 'com.palm.service.accounts'}, quiet));
	assert.ok(M.hasPermission('writePermissions', t, {appId: 'com.test.x 99', sender: ''}, quiet));
	assert.ok(M.hasPermission('writePermissions', t, {appId: '', sender: 'org.app1'}, quiet));
	// . is literal, ? one character only
	assert.throws(() => M.hasPermission('writePermissions', t, {appId: 'comXtest.x', sender: ''}, quiet),
		e => e.errorCode === '' && /Permission denied! comXtest.x is not specified in template t writePermissions/.test(e.message));
	assert.throws(() => M.hasPermission('writePermissions', t, {appId: 'org.app12', sender: ''}, quiet), /Permission denied!/);
	assert.throws(() => M.hasPermission('readPermissions', t, {appId: 'com.test.x', sender: ''}, quiet), /Permission denied!/);
});

test('the public whitelist: quickoffice, documents only', () => {
	assert.ok(M.publicByIdAndCapability('com.quickoffice.webos 12', 'DOCUMENTS'));
	assert.ok(!M.publicByIdAndCapability('com.quickoffice.webos', 'MAIL'));
	assert.ok(!M.publicByIdAndCapability('com.quickoffice.webos', undefined));
	assert.ok(M.publicById('com.quickoffice.ar'));
	assert.ok(!M.publicById('com.other'));
});

test('underscore 0.6 quirks: pluck of undefined fails, objects are walked by key', () => {
	assert.throws(() => _.pluck(undefined, 'id'), /reading 'map'/);
	assert.deepStrictEqual(_.pluck({a: {id: 1}, b: {id: 2}}, 'id'), [1, 2]);
	assert.strictEqual(_.detect([1, 2, 3], x => x > 1), 2);
	assert.deepStrictEqual(_.compact([0, 'a', '', null, 'b']), ['a', 'b']);
});

function writeTemplates(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-tmpl-'));
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
		fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
	}
	return root;
}

const tmpl = (id, extra) => Object.assign({templateId: id, loc_name: id.toUpperCase(),
	capabilityProviders: [{id: id + '.c', capability: 'MAIL', icon: {loc_32x32: 'c.png'}}]}, extra);

test('templates: locales, duplicates, broken files, icons, the sort, localized copies', () => {
	const root = writeTemplates({
		'a/a.json': tmpl('b', {icon: {loc_32x32: 'i.png'}}),
		'b/b.json': [tmpl('a'), {templateId: 'nolocname', capabilityProviders: []}, tmpl('afterbroken')],
		'c/c.json': tmpl('b', {loc_name: 'second b'}),
		'd/d.json': tmpl('de', {allowed_locales: ['de_de']}),
		'e/e.json': tmpl('notus', {disallowed_locales: ['en_us']}),
		'f/f.json': '{ broken',
		'g/g.json': tmpl('g'),
		'g/resources/en/g.json': tmpl('g', {loc_name: 'localized g'}),
		'h/notes.txt': 'x',
		'i/i.json': tmpl('constructor')
	});
	const T = createTemplates({roots: [root, '/nonexistent'], log: quiet});
	const list = T.load('en_us');
	assert.deepStrictEqual(list.map(t => t.templateId), ['a', 'b', 'g']);
	const b = list.find(t => t.templateId === 'b');
	assert.strictEqual(b.loc_name, 'B');
	assert.strictEqual(b.icon.loc_32x32, root + '/a/i.png');
	assert.strictEqual(b.capabilityProviders[0].icon.loc_32x32, root + '/a/c.png');
	assert.strictEqual(list.find(t => t.templateId === 'g').loc_name, 'localized g');
	assert.deepStrictEqual(T.load('de_de').map(t => t.templateId), ['a', 'b', 'de', 'g', 'notus']);
	fs.rmSync(root, {recursive: true, force: true});
});

test('localized: region, language, locale, en, then the file itself', () => {
	const root = writeTemplates({
		'x.json': 'root', 'resources/en/x.json': 'en', 'resources/de/x.json': 'de', 'resources/de/at/x.json': 'de-at',
		'resources/fr_ca/x.json': 'fr_ca', 'resources/it/x.json': ''
	});
	assert.strictEqual(localized(root, 'de_at', 'x.json').text, 'de-at');
	assert.strictEqual(localized(root, 'de_de', 'x.json').text, 'de');
	assert.strictEqual(localized(root, 'fr_ca', 'x.json').text, 'fr_ca');
	assert.strictEqual(localized(root, 'it_it', 'x.json').text, 'en');
	assert.strictEqual(localized(root, 'nl_nl', 'y.json').text, undefined);
	assert.strictEqual(currentLocale('en', 'us'), 'en_us');
	fs.rmSync(root, {recursive: true, force: true});
});

function fakeBus(answer) {
	const seen = [];
	return {seen, call: async (uri, args) => {
		seen.push({uri, args});
		const r = answer(uri, args);
		if (r && r.returnValue === false) {
			const e = new Error(r.errorText || 'x');
			e.errorCode = r.errorCode;
			e.reply = r;
			throw e;
		}
		return r;
	}};
}

test('PalmCall: the address joined as it was, failures worded as it worded them, secrets hidden', async () => {
	assert.strictEqual(address('palm://a/', 'm'), 'palm://a/m');
	assert.strictEqual(address('palm://a', 'm'), 'palm://a/m');
	assert.strictEqual(address('palm://a/m', ''), 'palm://a/m');
	const bus = fakeBus(uri => (uri.includes('fail') ? {returnValue: false, errorCode: 3, errorText: 'no'} :
		uri.includes('notext') ? {returnValue: false} : uri.includes('soft') ? {returnValue: true, errorText: 'soft'} : {returnValue: true}));
	const pc = createPalmCall(bus);
	await assert.rejects(pc.call('palm://com.x.fail/', 'm', {a: 1}), e => e.message === 'palm://com.x.fail/m {"a":1}: no' && e.errorCode === 3);
	await assert.rejects(pc.call('palm://com.x.notext/m', '', {}), e => e.message === 'palm://com.x.notext/m {}: Unknown PalmCall failure' && e.errorCode === -1);
	await assert.rejects(pc.call('palm://com.x.soft/m', '', {}), e => e.message.endsWith(': soft') && e.errorCode === -1);
	await assert.rejects(pc.call('palm://com.x.fail/m', '', {keyname: 'k', keydata: 'fake-secret', password: 'fake-pw'}),
		e => e.message === 'palm://com.x.fail/m {"keyname":"k","keydata":"<hidden>","password":"<hidden>"}: no');
	assert.strictEqual(bus.seen[0].uri, 'luna://com.x.fail/m');
});

test('mapReduce: the first failure in, or the reduce over the outcomes in the order they came', async () => {
	// Each comes in after as many ms as its name is long.
	const slow = v => new Promise((res, rej) => setTimeout(() => (v.startsWith('f') ? rej(new Error(v)) : res(v)), v.length * 5));
	await assert.rejects(mapReduce(['fslow', 'f', 'ok'], slow), e => e.message === 'f');
	const out = await mapReduce(['fslow', 'ok', 'f'], slow, r => r.map(o => o.item + ':' + ('exception' in o)));
	assert.deepStrictEqual(out, ['f:true', 'ok:false', 'fslow:true']);
	assert.deepStrictEqual(await mapReduce([], slow), []);
	await assert.rejects(mapReduce(['a'], () => {
		throw new Error('sync');
	}), /sync/);
});

function fakeKeymanager() {
	const keys = new Map();
	let failStore = 0;
	const nf = {returnValue: false, errorCode: -9999, errorText: 'Key not found'};
	const bus = fakeBus((uri, a) => {
		const m = uri.split('/').pop();
		if (m === 'fetchKey') {
			return keys.has(a.keyname) ? {returnValue: true, keydata: keys.get(a.keyname)} : nf;
		}
		if (m === 'keyInfo') {
			return keys.has(a.keyname) ? {returnValue: true} : nf;
		}
		if (m === 'remove') {
			return keys.delete(a.keyname) ? {returnValue: true} : nf;
		}
		if (failStore > 0) {
			failStore--;
			return {returnValue: false, errorCode: 1, errorText: 'store failed'};
		}
		keys.set(a.keyname, a.keydata);
		return {returnValue: true};
	});
	return {keys, bus, failStore: n => {
		failStore = n;
	}};
}

test('keystore: one key per account holding every named set, calls one at a time', async () => {
	const km = fakeKeymanager();
	const ks = createKeyStore(createPalmCall(km.bus));
	assert.deepStrictEqual(await ks.has('A1'), {value: false});
	await Promise.all([ks.put('A1', 'common', {password: 'fake-1'}), ks.put('A1', 'imap', {token: 'fake-2'})]);
	assert.deepStrictEqual(JSON.parse(km.keys.get('A1')), {common: {password: 'fake-1'}, imap: {token: 'fake-2'}});
	assert.deepStrictEqual(await ks.get('A1', 'imap'), {credentials: {token: 'fake-2'}});
	await assert.rejects(ks.get('A1', 'nope'), e => e.errorCode === 'CREDENTIALS_NOT_FOUND' &&
		e.message === 'Credentials for key \'nope\' not found in account \'A1\'');
	assert.deepStrictEqual(await ks.has('A1'), {value: true});
	await ks.del('A1');
	assert.deepStrictEqual(await ks.has('A1'), {value: false});
});

test('mojo replies: returnValue added, -9999 for no errorCode, a plain object as [object Object]', () => {
	assert.deepStrictEqual(reply(undefined), {returnValue: true});
	assert.deepStrictEqual(reply({a: 1}), {a: 1, returnValue: true});
	const e = exception(new Error('boom'));
	assert.strictEqual(e.errorCode, -9999);
	assert.strictEqual(e.errorText, 'MojoService: no errorCode supplied boom');
	const p = exception({message: 'dup', errorCode: 'DUPLICATE_ACCOUNT'});
	assert.deepStrictEqual([p.errorText, p.errorCode, p.exception], ['dup', 'DUPLICATE_ACCOUNT', '[object Object]']);
	const d = new Error('Permission denied.');
	d.errorCode = '';
	assert.strictEqual(exception(d).errorCode, '');
});
