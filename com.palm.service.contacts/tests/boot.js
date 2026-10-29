// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The service on a stand-in bus, with an in-memory db8 (fakedb.js), and
	the accounts, file cache, image, SIM, activitymanager and systemservice
	services behind it.

	Globalization and phonenumberlib are the device's own (lib/frameworks.js
	says why they are not rewritten), so the service needs a frameworks
	root: CONTACTS_FRAMEWORKS, or /usr/palm/frameworks on a device.
	FRAMEWORKS is null when there is none, and those tests skip, saying so.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const {createPalmbus} = require('./palmbus');
const {createFakeDb} = require('./fakedb');

const SERVICE = path.join(__dirname, '..');
const NAME = 'com.palm.service.contacts';

function frameworksRoot() {
	for (const root of [process.env.CONTACTS_FRAMEWORKS, '/usr/palm/frameworks']) {
		if (root && fs.existsSync(path.join(root, 'globalization'))) {
			return root;
		}
	}
	return null;
}
const FRAMEWORKS = frameworksRoot();
const NO_FRAMEWORKS = FRAMEWORKS ? false : 'needs globalization and phonenumberlib: set CONTACTS_FRAMEWORKS';

const ACCOUNTS = {
	'acct-p': {_id: 'acct-p', templateId: 'com.palm.palmprofile', username: 'me',
		capabilityProviders: [{capability: 'CONTACTS', id: 'com.palm.palmprofile.contacts'}]},
	'acct-g': {_id: 'acct-g', templateId: 'com.google.google', username: 'user@gmail.com',
		capabilityProviders: [{capability: 'CONTACTS', id: 'com.google.contacts', dbkinds: {contact: 'com.palm.contact.google:1'}}]},
	'acct-n': {_id: 'acct-n', templateId: 'x', username: 'n', capabilityProviders: [{capability: 'CONTACTS', id: 'x.contacts'}]}
};

const quiet = {log() {}, warn() {}, error() {}, info() {}, debug() {}};

// A directory of its own for a test's files (vCards in, vCards out).
function tmpDir() {
	return fs.mkdtempSync(path.join(process.env.CONTACTS_TEST_TMP || os.tmpdir(), 'contacts-test-'));
}

async function boot({profileAccounts = ['acct-p'], timeoutsS, cacheDir = '/var/file-cache', photoDir} = {}) {
	const db = createFakeDb({prefix: 'C'});
	const calls = [];
	let pending = 0, last = Date.now();

	async function onCall(uri, args) {
		pending++;
		last = Date.now();
		try {
			const [, service, method] = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri);
			calls.push({service, method, args});
			if (service === 'com.palm.db') {
				await new Promise(r => setImmediate(r));
				return await db.handle(method, args);
			}
			if (service === 'com.palm.systemservice' && method === 'getPreferences') {
				return {returnValue: true, locale: {languageCode: 'en', countryCode: 'us'}};
			}
			if (service === 'com.palm.service.accounts' && method === 'listAccounts') {
				return {returnValue: true, results: profileAccounts.map(a => ACCOUNTS[a])};
			}
			if (service === 'com.palm.service.accounts' && method === 'getAccountInfo') {
				const a = ACCOUNTS[args.accountId];
				return a ? {returnValue: true, result: a} : {returnValue: false, errorCode: -3, errorText: 'no account ' + args.accountId};
			}
			if (service === 'com.palm.filecache' && method === 'InsertCacheObject') {
				return [{returnValue: true, pathName: cacheDir + '/' + args.typeName + '/' + path.basename(String(args.fileName)),
					subscribed: true}];
			}
			if (service === 'com.palm.activitymanager' && (method === 'adopt' || method === 'monitor')) {
				return [{returnValue: true, adopted: true, subscribed: true}];
			}
			if (service === 'com.palm.activitymanager' && method === 'create') {
				return {returnValue: true, activityId: 900};
			}
			return {returnValue: true};
		} finally {
			pending--;
			last = Date.now();
		}
	}

	const pb = createPalmbus(onCall);
	const {start} = require(path.join(SERVICE, 'service'));
	const service = await start({palmbus: pb, idleMs: 0, log: quiet, frameworksRoot: FRAMEWORKS, exit() {},
		now: () => 1700000000000, timeoutsS, photoDir});

	async function settle(ms = 30) {
		for (;;) {
			await new Promise(r => setTimeout(r, 5));
			if (pending === 0 && Date.now() - last >= ms) {
				return;
			}
		}
	}

	async function ask(method, params, caller) {
		const reply = JSON.parse(await pb.request(NAME, method, params || {}, caller));
		await settle();
		return reply;
	}

	// The first reply, or "NO REPLY" after ms.
	async function askWithin(ms, method, params, caller) {
		const reply = await Promise.race([pb.request(NAME, method, params || {}, caller).then(JSON.parse),
			new Promise(r => setTimeout(() => r('NO REPLY'), ms))]);
		await settle();
		return reply;
	}

	return {db, calls, ask, askWithin, settle, pb, service,
		of: (service2, method) => calls.filter(c => c.service === service2 && c.method === method),
		stop() {
			if (service.bus.stop) {
				service.bus.stop();
			}
		}};
}

module.exports = {boot, tmpDir, FRAMEWORKS, NO_FRAMEWORKS, SERVICE, NAME, ACCOUNTS, quiet};
