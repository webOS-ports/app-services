// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The hub lets the service call a method only when its client permissions
	(files/sysbus/*.perm.json) name a group that holds the method. The groups
	below are the ones the LuneOS VM's api-permissions.d gave for each method
	the service calls (2026-10-29), by the name the hub checks: the service's
	own name, not its com.palm alias.
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PERM = path.join(__dirname, '..', 'files', 'sysbus', 'com.palm.service.calendar.reminders.perm.json');

const CALLS = {
	'com.webos.service.db/find, get, put, merge, del, batch, watch': 'database.operation',
	'com.webos.service.activitymanager/create, complete, cancel, adopt': 'activity.operation',
	'com.webos.service.activitymanager/monitor': 'activity.query',
	'com.webos.service.systemservice/time/getSystemTime': 'time.query',
	'com.webos.service.systemservice/timezone/getTimeZoneRules': 'time.query',
	'com.webos.service.applicationManager/launch': 'application.launcher',
	'com.palm.service.calendar.reminders/onDBChanged': 'calendarremindersservice.operation'
};

describe('client permissions', () => {
	it('bug 14: name a group for every method the service calls', () => {
		const groups = JSON.parse(fs.readFileSync(PERM, 'utf8'))['com.palm.service.calendar.reminders'];
		for (const [call, group] of Object.entries(CALLS)) {
			assert.ok(groups.includes(group), call + ' needs ' + group);
		}
	});
});
