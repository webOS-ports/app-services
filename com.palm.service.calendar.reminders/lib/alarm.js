// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0
//
// From the old service's utils.js and reminder-assistant.js,
// Copyright (c) 2010-2013 LG Electronics, Inc., Apache License 2.0.

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
	The duration taken apart as the old code did, with one regular expression:
	P, then weeks or days (only the last of them counts), T, hours, minutes,
	seconds, each of one to three digits. A part of four digits ends the match
	there, so "-PT1440M" is no offset at all (README.md). A leading "-" makes
	every part negative.
*/
function parseDuration(alarmString, startTime) {
	let weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0;
	const negative = alarmString[0] === '-' ? -1 : 1;
	const tokens = /P([0-9]{1,3}[WD])*T*([0-9]{1,3}H)*([0-9]{1,3}M)*([0-9]{1,3}S)*/.exec(alarmString);
	if (!tokens) {
		return 0;
	}
	// tokens[0], the whole match, goes through this too: its number is NaN, and the part after it puts it right.
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined) {
			continue;
		}
		const end = token.length - 1;
		const number = parseInt(token.substr(0, end), 10);
		switch (token[end]) {
		case 'W':
			weeks = number * negative;
			break;
		case 'D':
			days = number * negative;
			break;
		case 'H':
			hours = number * negative;
			break;
		case 'M':
			minutes = number * negative;
			break;
		case 'S':
			seconds = number * negative;
			break;
		}
	}
	const date = new Date(startTime);
	D.add(date, {seconds, minutes, hours, days});
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
