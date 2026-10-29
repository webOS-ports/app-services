// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service on a stand-in world (world.js) with a clock the test sets
	(clock.js). The clock replaces Date for the whole process, so a test file
	boots once per time zone it needs: process.env.TZ is read when it is set.

	const {world, clock} = await boot({now: Date.UTC(2026, 9, 25, 0, 30), tz: 'Europe/Amsterdam'});
*/

const path = require('path');
const {installClock} = require('./clock');
const {createWorld} = require('./world');

const SERVICE_DIR = path.join(__dirname, '..');
const quiet = {log() {}, warn() {}, error() {}, info() {}};

async function boot({now, tz = 'Etc/UTC', log = quiet} = {}) {
	process.env.TZ = tz;
	const clock = installClock(now);
	const world = createWorld({timezone: tz});
	const svc = require(SERVICE_DIR + '/service').start({palmbus: world.palmbus, idleMs: 0, log, exit() {}});
	await world.settle();
	return {world, clock, svc};
}

// A calendar event as the calendar app stores it, with a display alarm `trigger` before the start.
function event(fields) {
	const e = Object.assign({_kind: 'com.palm.calendarevent:1', calendarId: 'cal1', subject: 'Event',
		allDay: false, tzId: process.env.TZ}, fields);
	if (fields.trigger !== undefined) {
		e.alarm = [{action: 'display', alarmTrigger: {valueType: 'DURATION', value: fields.trigger}}];
		delete e.trigger;
	}
	return e;
}

module.exports = {boot, event, quiet};
