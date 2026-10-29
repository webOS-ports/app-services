// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The pieces of DateJS and of the calendar framework the service uses
	(lib/datejs.js, lib/alarm.js, lib/calendar.js), on their own, in
	Europe/Amsterdam. They were compared with the originals on generated
	input as well (README.md); these are the cases worth naming.
*/

process.env.TZ = 'Europe/Amsterdam';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/datejs');
const {findDisplayAlarm, parseDuration, calculateAlarmTime, utcDateString} = require('../lib/alarm');
const {createTimezoneManager, createEventManager} = require('../lib/calendar');
const {getTimeZoneRules} = require('./tzrules');

const MIN = 60000, DAY = 86400000;

describe('datejs', () => {
	it('addMilliseconds goes through local time: a day, or 24 hours, over the end of summer time is 25 hours', () => {
		const d = new Date(Date.UTC(2026, 9, 24, 7, 0)); // 09:00 CEST
		assert.equal(D.addDays(new Date(d), 1).getTime(), Date.UTC(2026, 9, 25, 8, 0));
		assert.equal(D.addMilliseconds(new Date(d), DAY).getTime(), Date.UTC(2026, 9, 25, 8, 0));
		assert.equal(D.addHours(new Date(d), 24).getTime(), Date.UTC(2026, 9, 25, 8, 0));
		// Into summer time: 23 hours.
		const m = new Date(Date.UTC(2026, 2, 28, 8, 0)); // 09:00 CET
		assert.equal(D.addMinutes(new Date(m), 24 * 60).getTime(), Date.UTC(2026, 2, 29, 7, 0));
	});

	it('parseExact reads the two formats the calendar uses, and nothing else', () => {
		assert.equal(D.parseExact('20261024', 'yyyyMMdd').getTime(), new Date(2026, 9, 24).getTime());
		assert.equal(D.parseExact('20261024T093000', 'yyyyMMddTHHmmss').getTime(), new Date(2026, 9, 24, 9, 30).getTime());
		assert.equal(D.parseExact('20260231', 'yyyyMMdd'), null);
		assert.equal(D.parseExact('2026102', 'yyyyMMdd'), null);
		assert.equal(D.parseExact('20261024T2515', 'yyyyMMddTHHmmss'), null);
	});

	it('clearTime and setTime work in local time', () => {
		const d = D.clearTime(new Date(Date.UTC(2026, 9, 24, 22, 30))); // 00:30 CEST on the 25th
		assert.equal(d.getTime(), new Date(2026, 9, 25).getTime());
		assert.equal(D.setTime(d, {hour: 9, minute: 15}).getTime(), Date.UTC(2026, 9, 25, 8, 15));
	});
});

describe('alarm', () => {
	it('findDisplayAlarm: the first display alarm with a duration that is not "none"', () => {
		assert.equal(findDisplayAlarm([{action: 'audio', alarmTrigger: {valueType: 'DURATION', value: '-PT5M'}},
			{action: 'display', alarmTrigger: {valueType: 'DURATION', value: 'none'}},
			{alarmTrigger: {valueType: 'DURATION', value: '-PT15M'}}]), 2);
		assert.equal(findDisplayAlarm([]), null);
		assert.equal(findDisplayAlarm(undefined), null);
	});

	it('parseDuration: negative and positive offsets', () => {
		const start = Date.UTC(2026, 9, 23, 12, 0);
		assert.equal(parseDuration('-PT15M', start), start - 15 * MIN);
		assert.equal(parseDuration('PT1H30M', start), start + 90 * MIN);
		assert.equal(parseDuration('-P1D', start), start - DAY);
		assert.equal(parseDuration('-P1W', start), start - 7 * DAY);
	});

	it('parseDuration, bug 7: any number of digits, and weeks and days added up', () => {
		const start = Date.UTC(2026, 9, 23, 12, 0);
		assert.equal(parseDuration('-PT1440M', start), start - DAY);
		assert.equal(parseDuration('-PT1000S', start), start - 1000 * 1000);
		assert.equal(parseDuration('-P1W2D', start), start - 9 * DAY);
		assert.equal(parseDuration('P1DT2H', start), start + DAY + 2 * 3600000);
		assert.equal(parseDuration('none', start), 0);
	});

	it('calculateAlarmTime: a DATE-TIME trigger is that time, a duration is from the start', () => {
		const start = Date.UTC(2026, 9, 23, 12, 0);
		const trigger = (valueType, value) => ({alarmTrigger: {valueType, value}});
		assert.equal(calculateAlarmTime(start, trigger('DURATION', '-PT10M')), start - 10 * MIN);
		assert.equal(calculateAlarmTime(start, trigger('DATE-TIME', '20261023T101500Z')), Date.UTC(2026, 9, 23, 10, 15));
		assert.equal(calculateAlarmTime(start, trigger('DATE-TIME', '20261023T101500')), Date.UTC(2026, 9, 23, 8, 15));
		assert.equal(calculateAlarmTime(start, trigger('DATE-TIME', '2026-10-23')), 0);
		assert.equal(calculateAlarmTime(start, {}), 0);
	});

	it('utcDateString: what activitymanager takes for a schedule', () => {
		assert.equal(utcDateString(Date.UTC(2026, 9, 5, 7, 4, 3)), '2026-10-05 07:04:03Z');
	});
});

describe('calendar: findNextOccurrence', () => {
	const call = async (uri, args) => {
		if (/getSystemTime$/.test(uri)) {
			return {returnValue: true, timezone: 'Europe/Amsterdam', utc: Math.floor(Date.now() / 1000)};
		}
		if (/getTimeZoneRules$/.test(uri)) {
			return getTimeZoneRules(args);
		}
		throw new Error('no ' + uri);
	};
	const subscribe = () => ({cancel() {}});
	const tzm = createTimezoneManager({call, subscribe, log: {log() {}, error() {}}});
	const em = createEventManager(tzm);
	const ev = fields => Object.assign({allDay: false, tzId: 'Europe/Amsterdam'}, fields);
	const now = Date.UTC(2026, 9, 23, 12, 0);

	it('a daily event keeps its local time over the end of summer time', async () => {
		const e = ev({dtstart: Date.UTC(2026, 9, 22, 7, 0), dtend: Date.UTC(2026, 9, 22, 8, 0), rrule: {freq: 'DAILY'}});
		await em.findNextOccurrenceTimezonePrep([e]);
		assert.equal(em.findNextOccurrence(e, Date.UTC(2026, 9, 24, 8, 0) + MIN), Date.UTC(2026, 9, 25, 8, 0));
	});

	it('an exdate skips that occurrence (weekly)', async () => {
		const e = ev({dtstart: Date.UTC(2026, 10, 8, 8, 0), dtend: Date.UTC(2026, 10, 8, 9, 0), rrule: {freq: 'WEEKLY'},
			exdates: ['20261115T090000']});
		await em.findNextOccurrenceTimezonePrep([e]);
		assert.equal(em.findNextOccurrence(e, Date.UTC(2026, 10, 9, 12, 0)), Date.UTC(2026, 10, 22, 8, 0));
	});

	it('bug 5: an exception date of another length does not end the check of the others', async () => {
		const e = ev({dtstart: Date.UTC(2026, 10, 8, 8, 0), dtend: Date.UTC(2026, 10, 8, 9, 0), rrule: {freq: 'WEEKLY'},
			exdates: ['2026-11-15', '20261115T090000']});
		await em.findNextOccurrenceTimezonePrep([e]);
		assert.equal(em.findNextOccurrence(e, Date.UTC(2026, 10, 9, 12, 0)), Date.UTC(2026, 10, 22, 8, 0));
	});

	it('bug 13: an exception date of a daily event skips that day only', async () => {
		const e = ev({dtstart: Date.UTC(2026, 9, 22, 7, 0), dtend: Date.UTC(2026, 9, 22, 8, 0), rrule: {freq: 'DAILY'},
			exdates: ['20261024T090000']});
		await em.findNextOccurrenceTimezonePrep([e]);
		// The 24th is excluded; next is the 25th, 09:00 CET (08:00Z).
		assert.equal(em.findNextOccurrence(e, now), Date.UTC(2026, 9, 25, 8, 0));
	});

	it('bug 13: an exception date of a weekly event on two days skips that day only', async () => {
		const e = ev({dtstart: Date.UTC(2026, 10, 9, 8, 0), dtend: Date.UTC(2026, 10, 9, 9, 0),
			rrule: {freq: 'WEEKLY', rules: [{ruleType: 'BYDAY', ruleValue: [{day: 1}, {day: 3}]}]},
			exdates: ['20261116T090000']});
		await em.findNextOccurrenceTimezonePrep([e]);
		// Monday the 16th is excluded; Wednesday the 18th is next.
		assert.equal(em.findNextOccurrence(e, Date.UTC(2026, 10, 14, 12, 0)), Date.UTC(2026, 10, 18, 8, 0));
	});

	it('an exception date counts as one of a COUNT\'s occurrences', async () => {
		const e = ev({dtstart: Date.UTC(2026, 9, 20, 7, 0), dtend: Date.UTC(2026, 9, 20, 8, 0),
			rrule: {freq: 'DAILY', count: 5}, exdates: ['20261024T090000']});
		await em.findNextOccurrenceTimezonePrep([e]);
		// The 20th to the 24th, the 24th excluded: nothing after the 23rd.
		assert.equal(em.findNextOccurrence(e, Date.UTC(2026, 9, 23, 12, 0)), false);
	});

	it('a count or an until ends the series', async () => {
		const counted = ev({dtstart: Date.UTC(2026, 9, 20, 7, 0), dtend: Date.UTC(2026, 9, 20, 8, 0),
			rrule: {freq: 'DAILY', count: 3}});
		const until = ev({dtstart: Date.UTC(2026, 9, 20, 7, 0), dtend: Date.UTC(2026, 9, 20, 8, 0),
			rrule: {freq: 'DAILY', until: Date.UTC(2026, 9, 22, 23, 0)}});
		await em.findNextOccurrenceTimezonePrep([counted, until]);
		assert.equal(em.findNextOccurrence(counted, now), false);
		assert.equal(em.findNextOccurrence(until, now), false);
	});

	it('the time zone manager: offsets in and out of summer time', async () => {
		await em.findNextOccurrenceTimezonePrep([ev({tzId: 'America/New_York', dtstart: now, dtend: now + MIN,
			rrule: {freq: 'DAILY'}})]);
		assert.equal(tzm.getOffset(2026, 'America/New_York', Date.UTC(2026, 6, 1) / 1000), -4 * 3600);
		assert.equal(tzm.getOffset(2026, 'America/New_York', Date.UTC(2026, 11, 1) / 1000), -5 * 3600);
		assert.equal(tzm.getOffset(2026, 'Europe/Amsterdam', Date.UTC(2026, 2, 29, 0, 59) / 1000), 3600);
		assert.equal(tzm.getOffset(2026, 'Europe/Amsterdam', Date.UTC(2026, 2, 29, 1, 0) / 1000), 2 * 3600);
		assert.equal(tzm.getOffset(2026, 'Europe/Amsterdam', Date.UTC(2026, 9, 25, 0, 59) / 1000), 2 * 3600);
		assert.equal(tzm.getOffset(2026, 'Europe/Amsterdam', Date.UTC(2026, 9, 25, 1, 0) / 1000), 3600);
		assert.equal(tzm.convertTime(Date.UTC(2026, 6, 1, 12), 'Europe/Amsterdam', 'America/New_York'),
			Date.UTC(2026, 6, 1, 6));
	});

	it('old bug 6: where summer time spans the new year, the time zone manager never sees it', async () => {
		await em.findNextOccurrenceTimezonePrep([ev({tzId: 'Australia/Sydney', dtstart: now, dtend: now + MIN,
			rrule: {freq: 'DAILY'}})]);
		// January is summer time in Sydney (UTC+11); the old test gives the standard offset.
		assert.equal(tzm.getOffset(2026, 'Australia/Sydney', Date.UTC(2026, 0, 15) / 1000), 10 * 3600);
		assert.equal(tzm.getOffset(2026, 'Australia/Sydney', Date.UTC(2026, 6, 15) / 1000), 10 * 3600);
	});

	it('a monthly event on the last Friday', async () => {
		const e = ev({dtstart: Date.UTC(2026, 8, 25, 13, 0), dtend: Date.UTC(2026, 8, 25, 14, 0),
			rrule: {freq: 'MONTHLY', rules: [{ruleType: 'BYDAY', ruleValue: [{ord: -1, day: 5}]}]}});
		await em.findNextOccurrenceTimezonePrep([e]);
		// 2026-10-30, 15:00 CET.
		assert.equal(em.findNextOccurrence(e, now), Date.UTC(2026, 9, 30, 14, 0));
	});
});
