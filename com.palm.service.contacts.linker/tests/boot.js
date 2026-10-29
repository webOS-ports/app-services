// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service on a stand-in bus, with an in-memory db8 (fakedb.js), the
	accounts service, activitymanager and systemservice behind it.

	Globalization and phonenumberlib are the device's own (lib/frameworks.js
	says why they are not rewritten), so the tests that link need a frameworks
	root: LINKER_FRAMEWORKS, or /usr/palm/frameworks on a device. FRAMEWORKS
	is null when there is none, and those tests skip, saying so.
*/

const fs = require('fs');
const path = require('path');
const {createPalmbus} = require('./palmbus');
const {createFakeDb} = require('./fakedb');

const SERVICE = path.join(__dirname, '..');
const NAME = 'com.palm.service.contacts.linker';

function frameworksRoot() {
	for (const root of [process.env.LINKER_FRAMEWORKS, '/usr/palm/frameworks']) {
		if (root && fs.existsSync(path.join(root, 'globalization'))) {
			return root;
		}
	}
	return null;
}
const FRAMEWORKS = frameworksRoot();
const NO_FRAMEWORKS = FRAMEWORKS ? false : 'needs globalization and phonenumberlib: set LINKER_FRAMEWORKS';

const ACCOUNTS = {
	'acct-g': {username: 'user@gmail.com',
		capabilityProviders: [{id: 'com.google.contacts', dbkinds: {contact: 'com.palm.contact.google:1'}}]},
	'acct-e': {username: 'ex@corp.example',
		capabilityProviders: [{id: 'com.palm.eas.contacts', dbkinds: {contact: 'com.palm.contact.eas:1'}}]}
};

const quiet = {log() {}, warn() {}, error() {}, info() {}};

async function boot({completeFails = false, adoptFails = false} = {}) {
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
				return await db.handle(method, args);
			}
			if (service === 'com.palm.systemservice' && method === 'getPreferences') {
				return {returnValue: true, locale: {languageCode: 'en', countryCode: 'us'}};
			}
			if (service === 'com.palm.service.accounts' && method === 'getAccountInfo') {
				const a = ACCOUNTS[args.accountId];
				return a ? {returnValue: true, result: a} :
					{returnValue: false, errorCode: -3, errorText: 'no account ' + args.accountId};
			}
			if (service === 'com.palm.service.contacts.sim' && method === 'saveContact') {
				return {returnValue: true};
			}
			if (service === 'com.palm.activitymanager') {
				if (method === 'adopt' && adoptFails) {
					return {returnValue: false, errorCode: 11, errorText: 'Resource temporarily unavailable'};
				}
				if (method === 'adopt') {
					return {returnValue: true, adopted: true};
				}
				if (method === 'complete' && completeFails) {
					return {returnValue: false, errorCode: 2, errorText: 'Activity ID not found'};
				}
				return {returnValue: true, activityId: 900};
			}
			return {returnValue: false, errorCode: -1, errorText: 'unexpected ' + uri};
		} finally {
			pending--;
			last = Date.now();
		}
	}

	const pb = createPalmbus(onCall);
	const {start} = require(path.join(SERVICE, 'service'));
	const service = await start({palmbus: pb, idleMs: 0, log: quiet, frameworksRoot: FRAMEWORKS, exit() {}});

	// Quiet: no call in flight and none for a while (deleteOrphanedPerson works after it answers).
	async function settle(ms = 30) {
		for (;;) {
			await new Promise(r => setTimeout(r, 5));
			if (pending === 0 && Date.now() - last >= ms) {
				return;
			}
		}
	}

	// caller: {service} or {appId}, as the bus would say who sent it.
	async function ask(method, params, caller) {
		const reply = JSON.parse(await pb.request(NAME, method, params || {}, caller));
		await settle();
		return reply;
	}

	function persons() {
		return db.all('com.palm.person:1');
	}

	function personOf(contactId) {
		return persons().find(p => (p.contactIds || []).indexOf(contactId) >= 0);
	}

	// Contacts put straight into db8, as a sync would; returns them with their ids.
	async function putContacts(list) {
		const r = await db.put(list.map(c => Object.assign({_kind: 'com.palm.contact.palmprofile:1'}, c)));
		return r.map((x, i) => Object.assign({}, list[i], {_id: x.id}));
	}

	return {db, calls, ask, settle, persons, personOf, putContacts, service, pb,
		stop() {
			if (service.bus.stop) {
				service.bus.stop();
			}
		}};
}

module.exports = {boot, FRAMEWORKS, NO_FRAMEWORKS, SERVICE, NAME, ACCOUNTS, quiet};
