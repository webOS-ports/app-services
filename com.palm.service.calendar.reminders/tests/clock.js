// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	A clock the tests set: Date is replaced by a subclass whose "now" (new
	Date() with no arguments, and Date.now()) is the time set. Everything
	else is the engine's Date, so local time, time zones and DST are what
	they are for process.env.TZ. Install it before the service is loaded:
	the calendar code keeps the year it started in.
*/

const RealDate = Date;
let current = RealDate.now();

class ClockDate extends RealDate {
	constructor(...args) {
		if (args.length === 0) {
			super(current);
		} else {
			super(...args);
		}
	}

	static now() {
		return current;
	}
}

function installClock(startMs) {
	if (startMs !== undefined) {
		current = startMs;
	}
	global.Date = ClockDate;
	return {
		now: () => current,
		set(ms) {
			current = ms;
		},
		advance(ms) {
			current += ms;
		},
		RealDate
	};
}

module.exports = {installClock, RealDate};
