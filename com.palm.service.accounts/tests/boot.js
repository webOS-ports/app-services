// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service on a stand-in bus (palmbus.js), with an in-memory db8 and
	tempdb (fakedb.js), keymanager, systemservice, and transports behind it.

	templates: {dir: [template, ...]} written as <root>/<dir>/<dir>.json in
	a fresh temporary root. transports(address, args) answers a transport's
	call (a reply, undefined for none); by default {returnValue: true}.

	Credentials in the tests are made up; the keymanager here keeps them in
	a Map and nowhere else.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const {createPalmbus} = require('./palmbus');
const {createFakeDb} = require('./fakedb');

const SERVICE = path.join(__dirname, '..');
const NAME = 'com.palm.service.accounts';
const quiet = {log() {}, warn() {}, error() {}, info() {}};

function keymgrError(text) {
	return {errorText: 'MojoService: no errorCode supplied ' + text, errorCode: -9999, exception: '[object Object]', returnValue: false};
}

async function boot({templates = {}, transports = null, locale = {languageCode: 'en', countryCode: 'us'}, timers = null} = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-test-'));
	const roots = [path.join(root, 'public'), path.join(root, 'cryptofs')];
	fs.mkdirSync(roots[0]);
	for (const dir of Object.keys(templates)) {
		fs.mkdirSync(path.join(roots[0], dir));
		fs.writeFileSync(path.join(roots[0], dir, dir + '.json'), JSON.stringify(templates[dir]));
	}
	const flagPath = path.join(root, 'first-use-profile-created');
	const db = createFakeDb({prefix: 'A'});
	const tempdb = createFakeDb({prefix: 'T', tempdb: true});
	const keys = new Map();
	const calls = [];
	const fail = {};
	let pending = 0, last = Date.now();
	let pb = null;

	function keymanager(method, args) {
		const k = args.keyname;
		switch (method) {
		case 'fetchKey':
			return keys.has(k) ? {returnValue: true, keyname: k, keydata: keys.get(k)} : keymgrError('Key not found');
		case 'keyInfo':
			return keys.has(k) ? {returnValue: true, keyname: k} : keymgrError('Key not found');
		case 'remove':
			if (!keys.has(k)) {
				return keymgrError('Key not found.');
			}
			keys.delete(k);
			return {returnValue: true};
		case 'store':
			if (keys.has(k)) {
				return keymgrError('Key already exists');
			}
			keys.set(k, args.keydata);
			return {returnValue: true};
		default:
			return keymgrError('no method');
		}
	}

	async function onCall(uri, args) {
		const [, service, method] = /^luna:\/\/([^/]+)\/?(.*)$/.exec(uri);
		const key = service + '/' + method;
		calls.push({service, method, args});
		if (fail[key] > 0) {
			fail[key]--;
			return {returnValue: false, errorCode: -4242, errorText: 'failed ' + key};
		}
		if (service === NAME) {
			// __quit, and the hour-long stayRunning of the start-up (which would keep a test alive), answered here.
			if (method === '__quit' || (method === 'stayRunning' && args.seconds === '3500')) {
				return {returnValue: true};
			}
			return pb.request(NAME, method, args, {service: NAME}).then(JSON.parse);
		}
		pending++;
		last = Date.now();
		try {
			await new Promise(r => setImmediate(r));
			if (service === 'com.palm.db') {
				return await db.handle(method, args);
			}
			if (service === 'com.palm.tempdb') {
				return await tempdb.handle(method, args);
			}
			if (service === 'com.palm.keymanager') {
				return keymanager(method, args);
			}
			if (key === 'com.palm.systemservice/getPreferences') {
				return args.keys[0] === 'locale' ? {returnValue: true, locale} : {returnValue: true, deviceName: 'Test Device'};
			}
			if (transports) {
				return transports(uri.replace(/^luna:/, 'palm:'), args);
			}
			return {returnValue: true};
		} finally {
			pending--;
			last = Date.now();
		}
	}

	pb = createPalmbus(onCall);
	const {start} = require(path.join(SERVICE, 'service'));
	const service = await start({palmbus: pb, idleMs: 0, log: quiet, roots, flagPath, exit() {}});

	async function settle(ms = 20) {
		for (;;) {
			await new Promise(r => setTimeout(r, 5));
			if (pending === 0 && Date.now() - last >= ms) {
				return;
			}
		}
	}

	// caller: {appId} or {service}, as the bus would say who sent it.
	async function ask(method, params, caller = {appId: 'com.palm.app.accounts'}) {
		return JSON.parse(await pb.request(NAME, method, params || {}, caller));
	}

	return {
		db, tempdb, keys, calls, fail, ask, settle, service, pb, roots, flagPath,
		callsTo: prefix => calls.filter(c => (c.service + '/' + c.method).startsWith(prefix)),
		accounts: () => db.all('com.palm.account:1', {deleted: true}),
		stop() {
			service.bus.stop();
			fs.rmSync(root, {recursive: true, force: true});
		},
		timers
	};
}

module.exports = {boot, SERVICE, NAME, quiet};
