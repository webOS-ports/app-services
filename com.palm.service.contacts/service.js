// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	com.palm.service.contacts: the contacts app's helper service (vCards,
	favourites, contact photos, sort keys, phone-number lookups).

	The launcher (run-js-service -> jsservicelauncher's bootstrap-node.js)
	requires this directory, as it has a package.json, and calls run().
	Nothing starts on require, so a test can start() it on a stand-in bus.
	The methods are in lib/commands.js.

	The contacts framework is not loaded: what this service used of it is in
	lib/records.js, lib/person.js, lib/photos.js, lib/prefs.js and
	lib/vcard.js. Globalization and phonenumberlib are loaded from the
	device's frameworks (lib/frameworks.js), for the locale the system has.
*/

const {createBus} = require('./lib/bus');
const {createDb} = require('./lib/db');
const {loadGlobalization, loadPhoneNumberLib} = require('./lib/frameworks');
const {createModel} = require('./lib/model');
const {createLinkHash} = require('./lib/linkhash');
const {createPersons} = require('./lib/person');
const {createPhotos} = require('./lib/photos');
const {createPrefs} = require('./lib/prefs');
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
	by default). now, timeoutsS ({method: seconds}) and photoDir (where
	deleteContactImage may remove photos) are for tests.
*/
async function start({palmbus, exit, idleMs, log = console, frameworksRoot, now, timeoutsS,
	photoDir} = {}) {
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log});
	const call = palmCall(Object.assign((uri, args, opts) => bus.call(uri, args, opts), {subscribe: bus.subscribe}));
	// The methods answer from the start; a call that comes in while the frameworks load waits.
	const ready = (async () => {
		const {language, region} = await locale(call, log);
		const G = loadGlobalization({root: frameworksRoot, language, region});
		const P = loadPhoneNumberLib({root: frameworksRoot});
		const model = createModel({G, P, phoneRegion: region});
		const db = createDb({call});
		const linkHash = createLinkHash({call});
		const persons = createPersons({db, model, linkHash});
		const photos = createPhotos({call, db, log, now});
		const prefs = createPrefs({db, log});
		const methods = createCommands({db, call, persons, photos, prefs, model, G, P, log, timeoutsS, photoDir});
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
	const methods = await ready;
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
