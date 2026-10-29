// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	com.palm.service.contacts.linker: links contacts into persons.

	The launcher (run-js-service -> jsservicelauncher's bootstrap-node.js)
	requires this directory, as it has a package.json, and calls run().
	Nothing starts on require, so a test can start() it on a stand-in bus.
	The methods are in lib/commands.js; how a contact finds its person is in
	lib/autolinker.js and lib/rankers.js.

	The contacts framework is not loaded: its rules are in lib/model.js and
	lib/person.js. Globalization and phonenumberlib, which the names, sort
	keys and phone numbers need, are loaded from the device's frameworks
	(lib/frameworks.js), for the locale the system has.
*/

const {createBus} = require('./lib/bus');
const {createDb} = require('./lib/db');
const {loadGlobalization, loadPhoneNumberLib} = require('./lib/frameworks');
const {createModel} = require('./lib/model');
const {createLinkHash} = require('./lib/linkhash');
const {createPersons} = require('./lib/person');
const {createClb} = require('./lib/clb');
const {createRankers} = require('./lib/rankers');
const {createAutolinker} = require('./lib/autolinker');
const {createSaveNew} = require('./lib/savenew');
const {createCommands, SERVICE, NAMES, LONG_TIMEOUT_S} = require('./lib/commands');
const {palmCall} = require('./lib/mojo');

const NAME = SERVICE;
const SYSTEM = 'luna://com.palm.systemservice';

// The system locale, as mojoservice read it for the frameworks: en/us when it cannot be had.
async function locale(call, log) {
	try {
		const r = await call(SYSTEM + '/getPreferences', {keys: ['locale']});
		const l = r.locale || {};
		return {language: l.languageCode || 'en', region: l.countryCode || 'us'};
	} catch (e) {
		log.error(NAME + ': no locale (' + ((e && e.message) || e) + '), using en_us');
		return {language: 'en', region: 'us'};
	}
}

/*
	start({palmbus, ...}): the service on that bus. frameworksRoot is where
	globalization and phonenumberlib are (the device's /usr/palm/frameworks
	by default).
*/
async function start({palmbus, exit, idleMs, log = console, frameworksRoot} = {}) {
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log});
	const call = palmCall(Object.assign((uri, args, opts) => bus.call(uri, args, opts), {subscribe: bus.subscribe}));
	// The methods answer from the start; a call that comes in while the frameworks load waits.
	let methods = null;
	const ready = (async () => {
		const {language, region} = await locale(call, log);
		const G = loadGlobalization({root: frameworksRoot, language, region});
		const P = loadPhoneNumberLib({root: frameworksRoot});
		const model = createModel({G, P, phoneRegion: region});
		const db = createDb({call});
		const linkHash = createLinkHash({call});
		const persons = createPersons({db, call, model, G, linkHash, log});
		const clb = createClb({db, linkHash});
		const rankers = createRankers({db, persons, model, G, clb, linkHash});
		const autolinker = createAutolinker({db, persons, rankers, log});
		const saveNew = createSaveNew({db, call, persons, model});
		methods = createCommands({db, call, persons, autolinker, clb, saveNew, log});
		log.log(NAME + ': up (' + Object.keys(methods).length + ' methods, ' + language + '_' + region + ', node ' +
			process.version + ')');
		return methods;
	})();
	const table = {};
	for (const name of NAMES) {
		table[name] = {
			raw: true,
			timeoutMs: (LONG_TIMEOUT_S + 10) * 1000,
			handler: async (params, ctx) => (await ready)[name].handler(params, ctx)
		};
	}
	bus.serve(table);
	await ready;
	return {bus, methods};
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
