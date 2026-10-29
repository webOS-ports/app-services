// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	com.palm.service.calendar.reminders: works out when each calendar
	event's reminder is due, keeps those in its own db8 kind, wakes itself
	through activitymanager to have the calendar app show them, and closes
	them again.

	The launcher (run-js-service -> jsservicelauncher's bootstrap-node.js)
	requires this directory, as it has a package.json, and calls run().
	Nothing starts on require, so a test can start() it on a stand-in bus.
	The methods are in lib/commands.js, the work they share in
	lib/reminders.js, and the calendar framework's recurrence rules, which
	the service used to load from the device, in lib/calendar.js.
*/

const {createBus} = require('./lib/bus');
const {createDb} = require('./lib/db');
const {palmCall} = require('./lib/mojo');
const {createTimezoneManager, createEventManager} = require('./lib/calendar');
const {createReminders} = require('./lib/reminders');
const {createCommands, SERVICE, NAMES} = require('./lib/commands');

const NAME = SERVICE;
// mojoservice's: a command gets 60 s; the service leaves 5 s after its last one.
const IDLE_MS = 5000;

function start({palmbus, exit, idleMs = IDLE_MS, log = console} = {}) {
	const bus = createBus({palmbus, name: NAME, exit, idleMs, log});
	const call = palmCall(Object.assign((uri, args, opts) => bus.call(uri, args, opts), {subscribe: bus.subscribe}));
	const db = createDb({call});
	const tzm = createTimezoneManager({call, subscribe: bus.subscribe, log});
	const events = createEventManager(tzm);
	const rem = createReminders({db, call, events, log});
	const methods = createCommands({db, call, rem, log});
	bus.serve(methods);
	log.log(NAME + ': up (' + NAMES.length + ' methods, node ' + process.version + ')');
	return {bus, methods, tzm};
}

let running = null;
function run() {
	if (running) {
		return running;
	}
	process.title = NAME;
	// palmbus is the launcher's: it is there on the device and nowhere else.
	running = start({palmbus: require('palmbus')});
	return running;
}

module.exports = {start, run, NAME};

if (require.main === module) {
	run();
}
