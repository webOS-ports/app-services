// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's utils.js and reminder-assistant.js, Copyright (c)
// 2010-2013 LG Electronics, Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	When an event's alarm goes off, as the old service worked it out: the
	first "display" alarm with a DURATION trigger (RFC 5545 "-PT15M") that is
	not "none", applied to the occurrence's start through DateJS's local-time
	arithmetic (datejs.js).
*/

const D = require('./datejs');

// The index of the alarm to show, or null.
function findDisplayAlarm(eventAlarm) {
	const numAlarms = eventAlarm && eventAlarm.length;
	for (let i = 0; i < numAlarms; i++) {
		if (eventAlarm[i].action && eventAlarm[i].action.toLowerCase() !== 'display') {
			continue;
		}
		if (eventAlarm[i].alarmTrigger &&
				eventAlarm[i].alarmTrigger.valueType == 'DURATION' && // jshint ignore:line
				eventAlarm[i].alarmTrigger.value &&
				eventAlarm[i].alarmTrigger.value.toLowerCase() !== 'none') {
			return i;
		}
	}
	return null;
}

/*
	The duration taken apart as the old code read it (P, weeks and days, T,
	hours, minutes, seconds, a leading "-" making every part negative, and
	no anchoring at either end), but with any number of digits per part, and
	weeks and days added up. The old expression took one to three digits, so
	"-PT1440M" was no offset at all, and kept only the last of W and D, so
	"-P1W2D" was two days (README.md, bug 7).
*/
function parseDuration(alarmString, startTime) {
	let weeks = 0, days = 0;
	const negative = alarmString[0] === '-' ? -1 : 1;
	const tokens = /P((?:[0-9]+[WD])*)T*(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?/.exec(alarmString);
	if (!tokens) {
		return 0;
	}
	const dateParts = /([0-9]+)([WD])/g;
	let part;
	while ((part = dateParts.exec(tokens[1]))) {
		if (part[2] === 'W') {
			weeks += parseInt(part[1], 10) * negative;
		} else {
			days += parseInt(part[1], 10) * negative;
		}
	}
	const n = t => (t === undefined ? 0 : parseInt(t, 10) * negative);
	const date = new Date(startTime);
	D.add(date, {seconds: n(tokens[4]), minutes: n(tokens[3]), hours: n(tokens[2]), days});
	D.addWeeks(date, weeks);
	return date.getTime();
}

// A DATE-TIME trigger: not reached, as findDisplayAlarm takes DURATION triggers only; kept as it was.
function parseDateTime(alarmString) {
	let date;
	switch (alarmString.length) {
	case 15:
		date = D.parseExact(alarmString, 'yyyyMMddTHHmmss');
		break;
	case 16:
		date = D.parseExact(alarmString.substr(0, 15), 'yyyyMMddTHHmmss');
		D.addMinutes(date, -date.getTimezoneOffset());
		break;
	default:
		return 0;
	}
	return date.getTime();
}

function calculateAlarmTime(startTime, alarm) {
	if (!alarm || !alarm.alarmTrigger) {
		return 0;
	}
	const alarmType = alarm.alarmTrigger.valueType;
	const alarmString = alarm.alarmTrigger.value;
	if (!alarmType || !alarmString) {
		return 0;
	}
	if (alarmType === 'DATE-TIME') {
		return parseDateTime(alarmString);
	}
	return parseDuration(alarmString, startTime);
}

// "YYYY-MM-DD HH:MM:SSZ" in UTC, activitymanager's schedule format.
function utcDateString(timestamp) {
	const date = new Date(timestamp);
	const pad = n => (n > 9 ? n : '0' + n);
	return '' + date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) + ' ' +
		pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds()) + 'Z';
}

module.exports = {findDisplayAlarm, parseDuration, calculateAlarmTime, utcDateString};
