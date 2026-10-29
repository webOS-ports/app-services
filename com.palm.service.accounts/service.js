// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's accounts.js, Copyright (c) 2009-2013 LG Electronics, Inc., licensed
// under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	com.palm.service.accounts: the account templates the apps install, the
	accounts made from them (com.palm.account:1 in db8), and their
	credentials (in com.palm.keymanager).

	The launcher (run-js-service -> jsservicelauncher's bootstrap-node.js)
	requires this directory, as it has a package.json, and calls run().
	Nothing starts on require, so a test can start() it on a stand-in bus.
	The methods are in lib/commands.js, the templates in lib/templates.js.

	Start-up is the old service's (accounts.js): the locale, the templates
	read for it, tempdb's list of template ids brought up to date, a watch
	on the locale (a change quits the service, so that the next start reads
	the templates for the new one), and a call to its own stayRunning, which
	keeps it running for an hour. A call that comes in before the templates
	are read waits for them, as mojoservice held it.
*/

const {createBus} = require('./lib/bus');
const {createPalmCall} = require('./lib/palmcall');
const {createDb} = require('./lib/db');
const {createKeyStore} = require('./lib/keystore');
const {createTemplates, currentLocale} = require('./lib/templates');
const {createCommands, TIMEOUTS, SERVICE} = require('./lib/commands');
const {method, DEFAULT_TIMEOUT_S} = require('./lib/mojo');

const NAME = SERVICE;
const SELF = 'palm://com.palm.service.accounts/';
const SYSTEM = 'luna://com.palm.systemservice';

/*
	start({palmbus, ...}): the service on that bus. roots: where the
	templates are (the device's two directories by default); flagPath: the
	first-use flag createLocalAccount writes.
*/
async function start({palmbus, exit, idleMs, log = console, roots, schemas, flagPath} = {}) {
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log});
	const pc = createPalmCall(bus);
	const db = createDb(pc);
	const keystore = createKeyStore(pc);
	const T = createTemplates({roots, schemas, pc, log});
	let templates = [];
	let locale = 'en_us';

	function reloadTemplates() {
		log.log('Reloading templates ...');
		templates = T.load(locale);
		T.signal(() => templates);
	}

	// The locale as it is now; a change from it quits, as the old service did (by calling its own __quit).
	function watchLocale() {
		let watched;
		let done = false;
		let sub = null;
		const onEvent = r => {
			if (done) {
				return;
			}
			const l = r && r.locale;
			if (!l) {
				done = true;
				return;
			}
			const now = l.languageCode + '_' + l.countryCode;
			if (!watched) {
				watched = now;
			} else if (now !== watched) {
				log.log('Restarting service because of locale change from ' + watched + ' to ' + now);
				done = true;
				if (sub) {
					sub.cancel();
				}
				pc.fire(SELF + '__quit', '', {});
			}
		};
		log.log('Subscribing to locale changes ...');
		pc.subscribe(SYSTEM, 'getPreferences', {keys: ['locale'], subscribe: true}, onEvent).then(s => {
			sub = s;
			onEvent(s.first);
		}, () => {});
	}

	const ready = (async () => {
		try {
			const r = await pc.call(SYSTEM, 'getPreferences', {keys: ['locale']});
			locale = currentLocale(r.locale.languageCode, r.locale.countryCode);
		} catch (e) {
			log.error(NAME + ': no locale (' + ((e && e.message) || e) + '), using en_us');
		}
		templates = T.load(locale);
		T.signal(() => templates);
		watchLocale();
		// Running most of the time saves every call the start-up; an hour, as it was.
		pc.fire(SELF, 'stayRunning', {seconds: '3500'});
		log.log(NAME + ': up (' + templates.length + ' templates, ' + locale + ', node ' + process.version + ')');
	})();

	const {methods} = createCommands({db, pc, keystore, templates: () => templates, reloadTemplates, log, flagPath});
	const table = {};
	for (const name of Object.keys(methods)) {
		const timeoutS = TIMEOUTS[name] || DEFAULT_TIMEOUT_S;
		const m = method(NAME, name, methods[name], {timeoutS, log});
		table[name] = {
			raw: true,
			timeoutMs: (timeoutS + 10) * 1000,
			handler: async (params, ctx) => {
				await ready;
				return m.handler(params, ctx);
			}
		};
	}
	// mojoservice's __quit, which other components call too: answered, then gone 100 ms later.
	table.__quit = {
		raw: true,
		handler: () => {
			setTimeout(() => bus.leave(0, 'asked to quit (__quit)'), 100);
			return {returnValue: true};
		}
	};
	bus.serve(table);
	await ready;
	return {bus, methods, templates: () => templates};
}

let running = null;
function run() {
	if (running) {
		return running;
	}
	process.title = NAME;
	// palmbus is the launcher's: it is there on the device and nowhere else.
	running = start({palmbus: require('palmbus')});
	running.catch(e => {
		console.error(NAME + ': failed to start: ' + ((e && e.stack) || e));
		process.exit(1);
	});
	return running;
}

module.exports = {start, run, NAME};

if (require.main === module) {
	run();
}
