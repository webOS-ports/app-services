// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0
//
// Ported from the calendar framework (vm-frameworks/calendar/version/1.0/javascript:
// event-manager.js, rrule-manager.js, timezone-manager.js, utils.js),
// Copyright (c) 2010-2013 LG Electronics, Inc., Apache License 2.0.

'use strict';

/*
	The part of the calendar framework the reminders use: when the next
	occurrence of a repeating event starts (EventManager.findNextOccurrence),
	and the time zone rules it needs first (findNextOccurrenceTimezonePrep).

	The rules are the framework's own, line for line, its faults included,
	because they decide when a reminder goes off; README.md lists the faults.
	Only the shape changed: no Foundations classes or futures, and DateJS as
	the functions in datejs.js.

	As in the framework there is one of each per service process: the time
	zone rules it has fetched, and the system time zone, which it keeps up to
	date through a getSystemTime subscription, stay between calls.
*/

const D = require('./datejs');

const SYSTEM = 'luna://com.palm.systemservice';

// ---- utils.js ----------------------------------------------------------------------------------

const leapYearDaysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leapYearDaysCumulative = [31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];
const regularYearDaysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const regularYearDaysCumulative = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
const leapYearDaysCumulativeReverse = [366, 335, 306, 275, 245, 214, 184, 153, 122, 92, 61, 31];
const regularYearDaysCumulativeReverse = [365, 334, 306, 275, 245, 214, 184, 153, 122, 92, 61, 31];

function isLeapYear(year) {
	if (year % 4) {
		return false;
	}
	if (year % 400 === 0) {
		return true;
	}
	if (year % 100 === 0) {
		return false;
	}
	return true;
}

function howManyDaysSinceJanuaryFirst(date) {
	let howManyDays = 0;
	const day = date.getDate();
	const year = date.getFullYear();
	const previousMonth = date.getMonth() - 1;
	if (previousMonth >= 0) {
		howManyDays = isLeapYear(year) ? leapYearDaysCumulative[previousMonth] : regularYearDaysCumulative[previousMonth];
	}
	howManyDays += (day - 1);
	return howManyDays;
}

function howManyDaysTillDecember31(date) {
	let howManyDays = 0;
	const day = date.getDate();
	const year = date.getFullYear();
	const month = date.getMonth();
	const nextMonth = date.getMonth() + 1;
	let daysInMonthArray = regularYearDaysInMonth;
	if (nextMonth < 12) {
		if (isLeapYear(year)) {
			daysInMonthArray = leapYearDaysInMonth;
			howManyDays = leapYearDaysCumulativeReverse[nextMonth];
		} else {
			howManyDays = regularYearDaysCumulativeReverse[nextMonth];
		}
	}
	howManyDays += (daysInMonthArray[month] - day);
	return howManyDays;
}

function howManyDaysBetweenShortRange(startDate, endDate) {
	let howManyDays = 0;
	let daysInMonthArray = regularYearDaysInMonth;
	let cumulativeArray = regularYearDaysCumulative;
	const startMonth = startDate.getMonth();
	const startDay = startDate.getDate();
	const year = startDate.getFullYear();
	const endMonth = endDate.getMonth();
	const endDay = endDate.getDate();
	const monthDiff = endMonth - startMonth;
	if (monthDiff === 0) {
		return (endDay - startDay);
	}
	if (isLeapYear(year)) {
		daysInMonthArray = leapYearDaysInMonth;
		cumulativeArray = leapYearDaysCumulative;
	}
	howManyDays += (daysInMonthArray[startMonth] - startDay);
	howManyDays += endDay;
	if (monthDiff > 1) {
		howManyDays += (cumulativeArray[endMonth - 1] - cumulativeArray[startMonth]);
	}
	return howManyDays;
}

function howManyDaysBetween(startDate, endDate) {
	let howManyDays = 0;
	const startYear = startDate.getFullYear();
	const endYear = endDate.getFullYear();
	if (startYear == endYear) { // jshint ignore:line
		howManyDays = howManyDaysBetweenShortRange(startDate, endDate);
	} else {
		howManyDays += howManyDaysTillDecember31(startDate);
		howManyDays += howManyDaysSinceJanuaryFirst(endDate) + 1;
		for (let year = startYear + 1; year < endYear; year++) {
			howManyDays += isLeapYear(year) ? 366 : 365;
		}
	}
	return howManyDays;
}

function howManyMonthsBetween(startDate, endDate) {
	let howManyMonths = 0;
	const startMonth = startDate.getMonth();
	const startYear = startDate.getFullYear();
	const endMonth = endDate.getMonth();
	const endYear = endDate.getFullYear();
	if (startYear == endYear) { // jshint ignore:line
		return endMonth - startMonth;
	}
	howManyMonths += (12 - startMonth);
	howManyMonths += endMonth;
	howManyMonths += (endYear - startYear - 1) * 12;
	return howManyMonths;
}

function howManyWeeksBetween(startDate, endDate) {
	return Math.floor(howManyDaysBetween(startDate, endDate) / 7);
}

// ---- rrule-manager.js --------------------------------------------------------------------------

const flagPositions = {byMonth: 0, byMonthDay: 1, byDay: 2, byYearDay: 3, byWeekNumber: 4};
const hasRules = {byMonth: 1, byMonthDay: 2, byDay: 4, byYearDay: 8, byWeekNumber: 16};

const cloneDate = d => new Date(d.getTime());

function findMonthPosition(date, findPositivePosition) {
	let daysApart;
	if (findPositivePosition) {
		const firstOfMonth = cloneDate(date);
		firstOfMonth.setDate(1);
		daysApart = howManyDaysBetweenShortRange(firstOfMonth, date);
		return Math.floor(daysApart / 7) + 1;
	}
	const lastOfMonth = cloneDate(date);
	if (isLeapYear(lastOfMonth.getFullYear())) {
		lastOfMonth.setDate(leapYearDaysInMonth[lastOfMonth.getMonth()]);
	} else {
		lastOfMonth.setDate(regularYearDaysInMonth[lastOfMonth.getMonth()]);
	}
	daysApart = howManyDaysBetweenShortRange(date, lastOfMonth);
	return Math.floor((daysApart / 7) + 1) * -1;
}

function getNegativeDayOfMonth(date) {
	const lastOfMonth = cloneDate(date);
	if (isLeapYear(lastOfMonth.getFullYear())) {
		lastOfMonth.setDate(leapYearDaysInMonth[lastOfMonth.getMonth()]);
	} else {
		lastOfMonth.setDate(regularYearDaysInMonth[lastOfMonth.getMonth()]);
	}
	const daysApart = howManyDaysBetweenShortRange(date, lastOfMonth);
	return (daysApart + 1) * -1;
}

function getWeekNumber(date) {
	let ordinalDay;
	let weekday = date.getDay();
	if (weekday === 0) {
		weekday = 7;
	}
	if (date.getMonth() === 0) {
		ordinalDay = date.getDate();
	} else if (isLeapYear(date.getFullYear())) {
		ordinalDay = leapYearDaysCumulative[date.getMonth() - 1] + date.getDate();
	} else {
		ordinalDay = regularYearDaysCumulative[date.getMonth() - 1] + date.getDate();
	}
	return Math.floor((ordinalDay - weekday + 10) / 7);
}

function getNegativeWeekNumber(date) {
	const endOfYear = new Date(date.getFullYear(), 11, 31);
	const weeksInYear = getWeekNumber(endOfYear);
	const positiveWeekNumber = getWeekNumber(date);
	return (weeksInYear - positiveWeekNumber + 1) * -1;
}

function setPresentFlag(flags, position) {
	flags.rulesPresent = flags.rulesPresent | (1 << position);
}

function setTrueFlag(flags, position) {
	flags.rulesTrue = flags.rulesTrue | (1 << position);
}

/* jshint eqeqeq: false */
function byMonthTest(rule, todayDate, flags) {
	const flagPosition = flagPositions.byMonth;
	setPresentFlag(flags, flagPosition);
	const month = todayDate.getMonth() + 1;
	const ruleLength = rule.ruleValue.length;
	for (let i = 0; i < ruleLength; i++) {
		if (rule.ruleValue[i].ord == month) { // jshint ignore:line
			setTrueFlag(flags, flagPosition);
			break;
		}
	}
}

function byMonthDayTest(rule, todayDate, flags) {
	const flagPosition = flagPositions.byMonthDay;
	setPresentFlag(flags, flagPosition);
	const dayOfMonth = todayDate.getDate();
	const negativeDayOfMonth = getNegativeDayOfMonth(todayDate);
	const ruleLength = rule.ruleValue.length;
	for (let i = 0; i < ruleLength; i++) {
		const ord = rule.ruleValue[i].ord;
		if (ord == dayOfMonth || ord == negativeDayOfMonth) { // jshint ignore:line
			setTrueFlag(flags, flagPosition);
			break;
		}
	}
}

function byDayTest(rule, todayDate, flags) {
	const flagPosition = flagPositions.byDay;
	setPresentFlag(flags, flagPosition);
	let positiveMonthPosition;
	let negativeMonthPosition;
	let monthPosition;
	const ruleLength = rule.ruleValue.length;
	for (let i = 0; i < ruleLength; i++) {
		const ord = rule.ruleValue[i].ord;
		const day = rule.ruleValue[i].day;
		if (ord) {
			if (ord > 0) {
				if (!positiveMonthPosition) {
					positiveMonthPosition = findMonthPosition(todayDate, true);
				}
				monthPosition = positiveMonthPosition;
			} else {
				if (!negativeMonthPosition) {
					negativeMonthPosition = findMonthPosition(todayDate, false);
				}
				monthPosition = negativeMonthPosition;
			}
			if (ord == monthPosition && day == todayDate.getDay()) { // jshint ignore:line
				setTrueFlag(flags, flagPosition);
				break;
			}
		} else if (day == todayDate.getDay()) { // jshint ignore:line
			setTrueFlag(flags, flagPosition);
			break;
		}
	}
}

function byWeekNumberTest(rule, todayDate, flags) {
	const flagPosition = flagPositions.byWeekNumber;
	setPresentFlag(flags, flagPosition);
	const weekNumber = getWeekNumber(todayDate);
	const negativeWeekNumber = getNegativeWeekNumber(todayDate);
	const ruleLength = rule.ruleValue.length;
	for (let i = 0; i < ruleLength; i++) {
		const ord = rule.ruleValue[i].ord;
		if (ord == weekNumber || ord == negativeWeekNumber) { // jshint ignore:line
			setTrueFlag(flags, flagPosition);
			break;
		}
	}
}

function byYearDayTest(rule, todayDate, flags) {
	const flagPosition = flagPositions.byYearDay;
	setPresentFlag(flags, flagPosition);
	const yearDayNumber = howManyDaysSinceJanuaryFirst(todayDate) + 1;
	const negativeYearDayNumber = (howManyDaysTillDecember31(todayDate) + 1) * -1;
	const ruleLength = rule.ruleValue.length;
	for (let i = 0; i < ruleLength; i++) {
		const ord = rule.ruleValue[i].ord;
		if (ord == yearDayNumber || ord == negativeYearDayNumber) { // jshint ignore:line
			setTrueFlag(flags, flagPosition);
			break;
		}
	}
}
/* jshint eqeqeq: true */

/*
	Is the day of date one of the exceptions? The exdates are strings of
	three kinds, told apart by length: 8 (a date: the time of the test date is
	given to it), 15 (a local date and time) and 16 (the same with a Z, read
	as UTC). Any other length ends the search with "no", whatever the rest of
	the list says. A string of one of those lengths that DateJS cannot parse
	throws, as it did in the framework (README.md).
*/
function evaluateExceptions(date, exdates, eventStart) {
	const exdatesLength = exdates.length;
	const testDate = new Date(date);
	const startTime = new Date(eventStart);
	D.setTime(testDate, {hour: startTime.getHours(), minute: startTime.getMinutes(), second: startTime.getSeconds(),
		millisecond: startTime.getMilliseconds()});
	if (exdates && exdatesLength !== 0) {
		for (let i = 0; i < exdatesLength; i++) {
			let exdate;
			switch (exdates[i].length) {
			case 8:
				exdate = D.parseExact(exdates[i], 'yyyyMMdd');
				if (exdate === null) {
					throw new TypeError('Cannot read properties of null (reading \'set\')');
				}
				D.setTime(exdate, {hour: testDate.getHours(), minute: testDate.getMinutes(), second: testDate.getSeconds(),
					millisecond: testDate.getMilliseconds()});
				break;
			case 15:
				exdate = D.parseExact(exdates[i], 'yyyyMMddTHHmmss');
				break;
			case 16: {
				exdate = D.parseExact(exdates[i].substr(0, 15), 'yyyyMMddTHHmmss');
				if (exdate === null) {
					throw new TypeError('Cannot read properties of null (reading \'getTimezoneOffset\')');
				}
				D.addMinutes(exdate, -exdate.getTimezoneOffset());
				break;
			}
			default:
				// Bug 5: a date of another length is not one; the framework stopped checking the others here.
				continue;
			}
			if (exdate === null) {
				throw new TypeError('Cannot read properties of null (reading \'equals\')');
			}
			if (D.equals(exdate, testDate)) {
				return true;
			}
		}
	}
	return false;
}

function evaluateRules(rules, todayDate, flags) {
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		switch (rule.ruleType) {
		case 'BYMONTH':
			byMonthTest(rule, todayDate, flags);
			break;
		case 'BYWEEKNO':
			byWeekNumberTest(rule, todayDate, flags);
			break;
		case 'BYMONTHDAY':
			byMonthDayTest(rule, todayDate, flags);
			break;
		case 'BYDAY':
			byDayTest(rule, todayDate, flags);
			break;
		case 'BYYEARDAY':
			byYearDayTest(rule, todayDate, flags);
			break;
		}
	}
}

// The frequency tests add the rules the RRULE leaves to the start date to the event's own rrule, as the framework did.
function frequencyTypeDaily(today, eventStart, rrule) {
	const flags = {rulesPresent: 0, rulesTrue: 0};
	const todayDate = new Date(today);
	const eventStartDate = new Date(eventStart);
	if (!rrule.interval) {
		rrule.interval = 1;
	}
	if (rrule.interval !== 1) {
		const days = howManyDaysBetween(eventStartDate, todayDate);
		if (days % rrule.interval !== 0) {
			return false;
		}
	}
	if (rrule.rules && rrule.rules.length > 0) {
		evaluateRules(rrule.rules, todayDate, flags);
	}
	return flags.rulesPresent === flags.rulesTrue;
}

function frequencyTypeWeekly(today, eventStart, rrule) {
	const flags = {rulesPresent: 0, rulesTrue: 0};
	const todayDate = new Date(today);
	const eventStartDate = new Date(eventStart);
	const defaultRule = {ruleType: 'BYDAY', ruleValue: [{day: eventStartDate.getDay()}]};
	let hasByDayRule = false;
	if (!rrule.interval) {
		rrule.interval = 1;
	}
	if (rrule.interval !== 1) {
		const weeks = howManyWeeksBetween(eventStartDate, todayDate);
		if (weeks % rrule.interval !== 0) {
			return false;
		}
	}
	if (rrule.rules && rrule.rules.length > 0) {
		for (let i = 0; i < rrule.rules.length; i++) {
			if (rrule.rules[i].ruleType == 'BYDAY') { // jshint ignore:line
				hasByDayRule = true;
			}
		}
	}
	if (rrule.rules && !hasByDayRule) {
		rrule.rules.push(defaultRule);
	} else if (!rrule.rules) {
		rrule.rules = [defaultRule];
	}
	evaluateRules(rrule.rules, todayDate, flags);
	return flags.rulesPresent === flags.rulesTrue;
}

function frequencyTypeMonthly(today, eventStart, rrule) {
	const flags = {rulesPresent: 0, rulesTrue: 0};
	let hasByDayRule = false;
	let hasByMonthDayRule = false;
	const todayDate = new Date(today);
	const eventStartDate = new Date(eventStart);
	const defaultRule = {ruleType: 'BYMONTHDAY', ruleValue: [{ord: eventStartDate.getDate()}]};
	if (!rrule.interval) {
		rrule.interval = 1;
	}
	if (rrule.interval != 1) { // jshint ignore:line
		const months = howManyMonthsBetween(eventStartDate, todayDate);
		if (months % rrule.interval !== 0) {
			return false;
		}
	}
	if (rrule.rules && rrule.rules.length > 0) {
		for (let i = 0; i < rrule.rules.length; i++) {
			if (rrule.rules[i].ruleType == 'BYDAY') { // jshint ignore:line
				hasByDayRule = true;
			}
			if (rrule.rules[i].ruleType == 'BYMONTHDAY') { // jshint ignore:line
				hasByMonthDayRule = true;
			}
		}
	}
	if (rrule.rules && !hasByDayRule && !hasByMonthDayRule) {
		rrule.rules.push(defaultRule);
	} else if (!rrule.rules) {
		rrule.rules = [defaultRule];
	}
	evaluateRules(rrule.rules, todayDate, flags);
	return flags.rulesPresent === flags.rulesTrue;
}

function frequencyTypeYearly(today, eventStart, rrule) {
	const flags = {rulesPresent: 0, rulesTrue: 0};
	const todayDate = new Date(today);
	const eventStartDate = new Date(eventStart);
	if (!rrule.interval) {
		rrule.interval = 1;
	}
	if (rrule.interval !== 1) {
		const years = todayDate.getFullYear() - eventStartDate.getFullYear();
		if (years % rrule.interval !== 0) {
			return false;
		}
	}
	if (!rrule.rules || rrule.rules.length === 0) {
		rrule.rules = [
			{ruleType: 'BYMONTH', ruleValue: [{ord: eventStartDate.getMonth() + 1}]},
			{ruleType: 'BYMONTHDAY', ruleValue: [{ord: eventStartDate.getDate()}]}
		];
	}
	for (let i = 0; i < rrule.rules.length; i++) {
		const rule = rrule.rules[i];
		/* jshint eqeqeq: false */
		if (rule.ruleType == 'BYMONTH') {
			setPresentFlag(flags, flagPositions.byMonth);
		} else if (rule.ruleType == 'BYMONTHDAY') {
			setPresentFlag(flags, flagPositions.byMonthDay);
		} else if (rule.ruleType == 'BYDAY') {
			setPresentFlag(flags, flagPositions.byDay);
		} else if (rule.ruleType == 'BYWEEKNO') {
			setPresentFlag(flags, flagPositions.byWeekNumber);
		} else if (rule.ruleType == 'BYYEARDAY') {
			setPresentFlag(flags, flagPositions.byYearDay);
		}
		/* jshint eqeqeq: true */
	}
	if ((flags.rulesPresent & hasRules.byMonth) && (!(flags.rulesPresent & hasRules.byDay) &&
			!(flags.rulesPresent & hasRules.byMonthDay))) {
		rrule.rules.push({ruleType: 'BYMONTHDAY', ruleValue: [{ord: eventStartDate.getDate()}]});
	}
	if (!(flags.rulesPresent & hasRules.byMonth) && (flags.rulesPresent & hasRules.byMonthDay)) {
		rrule.rules.push({ruleType: 'BYMONTH', ruleValue: [{ord: eventStartDate.getMonth() + 1}]});
	}
	if ((flags.rulesPresent & hasRules.byWeekNumber) && !(flags.rulesPresent & hasRules.byDay)) {
		rrule.rules.push({ruleType: 'BYDAY', ruleValue: [{day: eventStartDate.getDay()}]});
	}
	evaluateRules(rrule.rules, todayDate, flags);
	return flags.rulesPresent === flags.rulesTrue;
}

// true: repeats on date; false: not; -1: repeats, but date is an exception.
function evaluateRRule(date, eventStart, eventOriginalStart, rrule, exdates, eventTzID, countInfo) {
	if (rrule.until && rrule.until < date) {
		return false;
	} else if (countInfo && ((countInfo.until && countInfo.until < date) ||
			(countInfo.estimateEnd && countInfo.estimateEnd < date))) {
		return false;
	}
	if (exdates && evaluateExceptions(date, exdates, eventOriginalStart, eventTzID)) {
		return -1;
	}
	switch (rrule.freq) {
	case 'DAILY':
		return frequencyTypeDaily(date, eventStart, rrule);
	case 'WEEKLY':
		return frequencyTypeWeekly(date, eventStart, rrule);
	case 'MONTHLY':
		return frequencyTypeMonthly(date, eventStart, rrule);
	case 'YEARLY':
		return frequencyTypeYearly(date, eventStart, rrule);
	default:
		return false;
	}
}

// ---- timezone-manager.js -----------------------------------------------------------------------

/*
	The time zone rules, per year and zone, as systemservice's
	timezone/getTimeZoneRules gives them ({utcOffset, dstOffset, dstStart,
	dstEnd} in seconds), and the system time zone, from time/getSystemTime.
	call(uri, args) -> the reply, or throws; subscribe(uri, args, {onEvent})
	-> {first, cancel}.
*/
function createTimezoneManager({call, subscribe, log = console}) {
	const tm = {
		timezones: {},
		timezone: undefined,
		gotLocalTz: false,
		defaultYears: [],
		requested: false,
		waiters: []
	};
	for (let year = new Date().getFullYear(), i = -5; i < 6; ++i) {
		tm.defaultYears.push(year + i);
	}

	function setTimezone(response) {
		tm.timezone = response.timezone;
		tm.gotLocalTz = false;
	}

	// Bug 11: with no zone from systemservice, the zone the process runs in (the device's /etc/localtime).
	function ownTimezone() {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC';
	}

	/*
		Resolves once the system time zone is known. The first caller asks
		getSystemTime; on its answer every caller waiting goes on, and the
		subscription that keeps the zone current is made. A getSystemTime
		that fails, or one that names no zone, left every caller waiting for
		good in the framework (README.md, bug 11); the process's own zone is
		taken then.
	*/
	function setup() {
		if (!tm.timezone) {
			const p = new Promise(resolve => tm.waiters.push(resolve));
			if (!tm.requested) {
				tm.requested = true;
				const release = () => {
					let w;
					while ((w = tm.waiters.pop())) {
						w();
					}
				};
				call(SYSTEM + '/time/getSystemTime', {subscribe: false}).then(result => {
					if (!(result && result.timezone)) {
						log.error('calendar: getSystemTime named no time zone; taking ' + ownTimezone());
					}
					setTimezone(result && result.timezone ? result : {timezone: ownTimezone()});
					release();
					subscribe(SYSTEM + '/time/getSystemTime', {subscribe: true}, {
						onEvent: r => {
							if (r && r.returnValue !== false && r.timezone) {
								setTimezone(r);
							}
						}
					}).then(sub => {
						if (sub.first && sub.first.timezone) {
							setTimezone(sub.first);
						}
					}, () => {});
				}, e => {
					log.error('calendar: getSystemTime failed: ' + ((e && e.message) || e) + '; taking ' + ownTimezone());
					setTimezone({timezone: ownTimezone()});
					release();
				});
			}
			return p;
		}
		return Promise.resolve();
	}

	function hasTimezoneInfo(tzId, year) {
		return !!(tm.timezones[year] && tm.timezones[year][tzId]);
	}

	function makeTimezoneYearPair(tzId, years) {
		let allYears;
		if (!years || years.length === 0) {
			allYears = tm.defaultYears;
		} else if (JSON.stringify(years) !== JSON.stringify(tm.defaultYears)) {
			allYears = years.concat(tm.defaultYears);
		} else {
			allYears = years;
		}
		return {tz: tzId, years: allYears};
	}

	function findTzYearPairsNotInCache(tzIds, years) {
		const tzPairs = [];
		for (let i = 0; i < tzIds.length; i++) {
			const timezone = tzIds[i];
			const tzYears = [];
			for (let j = 0; j < years.length; j++) {
				if (!hasTimezoneInfo(timezone, years[j])) {
					tzYears.push(years[j]);
				}
			}
			if (tzYears.length > 0) {
				tzPairs.push(makeTimezoneYearPair(timezone, tzYears));
			}
		}
		return tzPairs;
	}

	// Fetch what is not cached yet. A failure leaves the cache as it is, and is not one to the caller.
	async function loadTimezones(tzIds, years) {
		if (!tzIds || tzIds.length === 0) {
			tzIds = [tm.timezone];
		}
		if (!years || years.length === 0) {
			years = tm.defaultYears;
		}
		if (!tm.gotLocalTz && tm.timezone) {
			tzIds.push(tm.timezone);
			tm.gotLocalTz = true;
		}
		const tzYearPairs = findTzYearPairsNotInCache(tzIds, years);
		if (tzYearPairs.length === 0) {
			return;
		}
		let results;
		try {
			// The framework passed the array itself as the call's payload.
			results = (await call(SYSTEM + '/timezone/getTimeZoneRules', tzYearPairs)).results;
			for (let i = 0; i < results.length; i++) {
				const tzinfo = results[i];
				if (!tm.timezones[tzinfo.year]) {
					tm.timezones[tzinfo.year] = {};
				}
				tm.timezones[tzinfo.year][tzinfo.tz] = tzinfo;
			}
		} catch (e) {
			log.error('calendar: getTimeZoneRules failed: ' + ((e && e.message) || e));
		}
	}

	/*
		The zone's offset from UTC in seconds at that time, by the rules of
		year. Daylight time is from dstStart up to dstEnd, which is never true
		where daylight time spans the new year (README.md); 0 for a year or
		zone it has no rules for; 0 for any zone with UTC in its name.
	*/
	function getOffset(year, tzId, timestampNoMillis) {
		if (!tzId) {
			tzId = tm.timezone;
		} else if (/UTC/i.test(tzId)) {
			return 0;
		}
		const tzInfoYr = tm.timezones[year];
		if (!tzInfoYr) {
			return 0;
		}
		const tzInfo = tzInfoYr[tzId];
		if (!tzInfo) {
			return 0;
		}
		if (!tzInfo.hasDstChange) {
			return tzInfo.utcOffset;
		} else if (timestampNoMillis >= tzInfo.dstStart && timestampNoMillis < tzInfo.dstEnd) {
			return tzInfo.dstOffset;
		}
		return tzInfo.utcOffset;
	}

	function convertTime(timestamp, srcTz, destTz) {
		const defaultTz = tm.timezone;
		const source = srcTz || defaultTz;
		const dest = destTz || defaultTz;
		if (source == dest) { // jshint ignore:line
			return timestamp;
		}
		const year = new Date(timestamp).getFullYear();
		const timestampNoMillis = timestamp / 1000;
		const destOffset = getOffset(year, dest, timestampNoMillis);
		const sourceOffset = getOffset(year, source, timestampNoMillis);
		return (timestampNoMillis + destOffset - sourceOffset) * 1000;
	}

	return {
		setup, loadTimezones, getOffset, convertTime,
		getSystemTimezone: () => tm.timezone,
		state: tm
	};
}

// ---- event-manager.js --------------------------------------------------------------------------

function createEventManager(tzm) {
	const noOccurrences = [];

	function getUniqueTzIdsInEventSet(eventSet) {
		const temp = [];
		const tzIds = [];
		for (let i = 0; i < eventSet.length; i++) {
			const tzId = eventSet[i].tzId;
			if (tzId && !temp[tzId]) {
				tzIds.push(tzId);
				temp[tzId] = true;
			}
		}
		return tzIds;
	}

	function repeatEndedBeforeDate(rrule, countInfo, date) {
		return !!((rrule && rrule.until && rrule.until < date) ||
			(countInfo && ((countInfo.until && countInfo.until < date) ||
				(countInfo.estimateEnd && countInfo.estimateEnd < date))));
	}

	function estimateRepeatEnd(event) {
		const freq = event.rrule.freq;
		const interval = parseInt(event.rrule.interval, 10) || 1;
		const count = parseInt(event.rrule.count, 10);
		const bonusPadding = 3;
		let base;
		const timeMachine = new Date(event.dtstart);
		switch (freq) {
		case 'DAILY':
			base = 1;
			break;
		case 'WEEKLY':
			base = 7;
			break;
		case 'MONTHLY':
			base = 31;
			if (timeMachine.getDate() === 31) {
				base = base * 2;
			}
			break;
		case 'YEARLY':
			base = 366;
			if (timeMachine.getMonth() === 1 && timeMachine.getDate() === 29) {
				base = base * 4;
			}
			break;
		}
		D.addDays(timeMachine, base * interval * (count + bonusPadding));
		return timeMachine.getTime();
	}

	function countPrep(event) {
		let countInfo = event.countInfo;
		if (!countInfo) {
			event.countInfo = {};
			countInfo = event.countInfo;
		}
		if (!countInfo.estimateEnd) {
			countInfo.estimateEnd = estimateRepeatEnd(event);
		}
	}

	function basicRangeTests(event, range) {
		if (event.dtstart > (range.end + 172800000)) {
			return false;
		}
		if (event.rrule && event.rrule.count) {
			if (!event.countInfo) {
				countPrep(event);
			}
			if (event.countInfo.estimateEnd < range.start) {
				return false;
			}
		} else if (event.rrule && event.rrule.until) {
			if (event.rrule.until < (range.start - 172800000)) {
				return false;
			}
		}
		return true;
	}

	function allDayAdjustment(start, end, timeMachine) {
		if (!timeMachine) {
			timeMachine = new Date();
		}
		const startTime = timeMachine.setTime(start);
		const endTime = timeMachine.setTime(end);
		const endDate = timeMachine;
		const isZeroTime = (startTime == endTime); // jshint ignore:line
		if (!isZeroTime && endDate.getHours() === 0 && endDate.getMinutes() === 0 && endDate.getSeconds() === 0) {
			end = end - 1000;
		}
		return end;
	}

	// Minutes from local time to the zone's time at timestamp.
	function findOffset(timestamp, tzId) {
		const year = new Date(timestamp).getFullYear();
		const localTzId = tzm.getSystemTimezone();
		const timeNoMillis = timestamp / 1000;
		const localOffsetFromUTCInSeconds = tzm.getOffset(year, localTzId, timeNoMillis);
		const rangeOffsetFromUTCInSeconds = tzm.getOffset(year, tzId, timeNoMillis);
		return (rangeOffsetFromUTCInSeconds - localOffsetFromUTCInSeconds) / 60;
	}

	// The local midnights of the days in range, shifted to the range's zone first ("concept" dates).
	function getDatesInRange(range) {
		const dates = [];
		let startTimestamp = range.start;
		let endTimestamp = range.end;
		const localTzId = tzm.getSystemTimezone();
		if (range.tzId != localTzId) { // jshint ignore:line
			const startOffset = findOffset(startTimestamp, range.tzId);
			const start = new Date(startTimestamp);
			start.setMilliseconds(0);
			startTimestamp = D.addMinutes(start, startOffset);
			const endOffset = findOffset(endTimestamp, range.tzId);
			const end = new Date(endTimestamp);
			end.setMilliseconds(0);
			endTimestamp = D.addMinutes(end, endOffset);
		}
		const midnight = D.setTime(new Date(startTimestamp), {hour: 0, minute: 0, second: 0, millisecond: 0});
		let time;
		do {
			dates.push(time || (time = midnight.getTime()));
			D.addDays(midnight, 1);
			time = midnight.getTime();
		} while (time < endTimestamp);
		return dates;
	}

	function findRepeatsInRangeHelper(event, range, datesInRange, datesInEvent, eventStartHours, eventStartMinutes,
		limit, timeMachine, exceptionsCount = true) {
		let nextMidnight;
		const occurrenceTracker = {};
		const datesInRangeSize = datesInRange.length;
		const eventOccurrences = [];
		let numFound = 0;
		if (isNaN(limit)) {
			limit = 0;
		}
		if (!timeMachine) {
			timeMachine = new Date();
		}
		for (let i = 0; i < datesInRangeSize; i++) {
			const date = datesInRange[i];
			if (repeatEndedBeforeDate(event.rrule, event.countInfo, date)) {
				continue;
			}
			if (i + 1 !== datesInRangeSize) {
				nextMidnight = datesInRange[i + 1];
			} else {
				timeMachine.setTime(date);
				D.addDays(timeMachine, 1);
				nextMidnight = timeMachine.getTime();
			}
			if (event.dtstart > nextMidnight) {
				continue;
			}
			const eventStart = datesInEvent[0];
			if (date < eventStart) {
				continue;
			}
			const repeatsOnDate = evaluateRRule(date, eventStart, event.dtstart, event.rrule, event.exdates, event.tzId,
				event.countInfo);
			if (!repeatsOnDate) {
				continue;
			}
			if (repeatsOnDate === -1) {
				// An exception is one of a COUNT's occurrences; it is not the next occurrence (bug 13).
				if (exceptionsCount) {
					numFound++;
					if (numFound === limit) {
						return eventOccurrences;
					}
				}
				continue;
			}
			timeMachine.setTime(datesInRange[i]);
			const dateOfOccurrence = timeMachine;
			dateOfOccurrence.setHours(eventStartHours);
			dateOfOccurrence.setMinutes(eventStartMinutes);
			dateOfOccurrence.setSeconds(0);
			dateOfOccurrence.setMilliseconds(0);
			const offset = findOffset(datesInRange[i], event.tzId);
			D.addMinutes(dateOfOccurrence, -offset);
			const occurrenceStartTimestamp = dateOfOccurrence.getTime();
			const occurrenceEndTimestamp = occurrenceStartTimestamp + (event.dtend - event.dtstart);
			if (range && (!(occurrenceEndTimestamp >= range.start && occurrenceStartTimestamp < range.end))) {
				continue;
			}
			const nextOccurrence = Object.assign({}, event);
			nextOccurrence.currentLocalStart = occurrenceStartTimestamp;
			nextOccurrence.currentLocalEnd = occurrenceEndTimestamp;
			if (nextOccurrence.allDay) {
				const start = timeMachine.setTime(nextOccurrence.currentLocalStart);
				const start12AM = D.clearTime(timeMachine).getTime();
				const end = timeMachine.setTime(nextOccurrence.currentLocalEnd);
				const end12AM = D.clearTime(timeMachine).getTime();
				if ((start !== end) && (end === end12AM) && (start === start12AM)) {
					nextOccurrence.currentLocalEnd -= 1000;
				}
			}
			if (repeatEndedBeforeDate(nextOccurrence.rrule, nextOccurrence.countInfo, nextOccurrence.currentLocalStart)) {
				continue;
			}
			if (occurrenceTracker[nextOccurrence.currentLocalStart] &&
					(occurrenceTracker[nextOccurrence.currentLocalStart] === nextOccurrence.currentLocalEnd)) {
				continue;
			}
			occurrenceTracker[nextOccurrence.currentLocalStart] = nextOccurrence.currentLocalEnd;
			eventOccurrences.push(nextOccurrence);
			numFound++;
			if (numFound === limit) {
				return eventOccurrences;
			}
		}
		return eventOccurrences;
	}

	/*
		The event's start hour and minute in its own zone. The framework took
		"setTime(t) && timeMachine" for the date, so a start of 0 or none gave
		it a number, and reading the hours of that threw: kept (README.md).
	*/
	function eventStartConcept(event, timeMachine) {
		const eventStartDate = tzm.convertTime(event.dtstart, tzm.getSystemTimezone(), event.tzId);
		if (!timeMachine.setTime(eventStartDate)) {
			throw new TypeError('eventStartDate.getHours is not a function');
		}
		return {hours: timeMachine.getHours(), minutes: timeMachine.getMinutes()};
	}

	function findRepeatsInRange(event, range, limit) {
		if (!basicRangeTests(event, range)) {
			return noOccurrences;
		}
		const timeMachine = new Date();
		const tempStart = event.dtstart;
		let tempEnd = event.dtend;
		if (event.allDay) {
			tempEnd = allDayAdjustment(tempStart, tempEnd, timeMachine);
		}
		const datesInEvent = getDatesInRange({start: tempStart, end: tempEnd, tzId: event.tzId});
		const additionalRangeDaysNeeded = (datesInEvent.length - 1);
		let searchRange = range;
		if (additionalRangeDaysNeeded) {
			searchRange = Object.assign({}, range);
			timeMachine.setTime(range.start);
			D.addDays(timeMachine, -additionalRangeDaysNeeded);
			searchRange.start = timeMachine.getTime();
			searchRange.end = range.end;
			searchRange.datesInRange = undefined;
		}
		const {hours, minutes} = eventStartConcept(event, timeMachine);
		let datesInRange;
		if (!searchRange.datesInRange) {
			searchRange.datesInRange = {};
		}
		if (!searchRange.datesInRange[event.tzId]) {
			datesInRange = getDatesInRange({start: searchRange.start, end: searchRange.end, tzId: event.tzId});
		} else {
			datesInRange = searchRange.datesInRange[event.tzId];
		}
		searchRange.datesInRange[event.tzId] = datesInRange;
		if (event.dtstart > searchRange.end || repeatEndedBeforeDate(event.rrule, event.countInfo, searchRange.start)) {
			return noOccurrences;
		}
		// Bug 13: the framework counted an exception as the occurrence it was looking for, so the search went on
		// from the end of the window, past the occurrence after the exception.
		return findRepeatsInRangeHelper(event, range, datesInRange, datesInEvent, hours, minutes, limit, timeMachine,
			false);
	}

	function reconstructOccurrences(event, occurrences, range) {
		const duration = event.dtend - event.dtstart;
		const inRangeOccurrences = [];
		for (let i = 0; i < occurrences.length; i++) {
			const instanceStart = occurrences[i];
			if (instanceStart >= range.start && instanceStart <= range.end) {
				const tempEvent = Object.assign({}, event);
				tempEvent.currentLocalStart = instanceStart;
				tempEvent.currentLocalEnd = instanceStart + duration;
				inRangeOccurrences.push(tempEvent);
			}
		}
		return inRangeOccurrences;
	}

	function findRepeatsInRangeCountVersion(event, range) {
		if (!basicRangeTests(event, range)) {
			return noOccurrences;
		}
		let tempStart = event.dtstart;
		let tempEnd = event.dtend;
		const timeMachine = new Date();
		if (event.allDay) {
			tempEnd = allDayAdjustment(tempStart, tempEnd, timeMachine);
		}
		const datesInEvent = getDatesInRange({start: tempStart, end: tempEnd, tzId: event.tzId});
		const {hours, minutes} = eventStartConcept(event, timeMachine);
		let limit = parseInt(event.rrule.count, 10) || 1;
		const ci = event.countInfo;
		const found = ci && ci.occurrences;
		const numFoundSoFar = found && found.length;
		let inRangeOccurrences = [];
		if (numFoundSoFar) {
			const lastFound = found[numFoundSoFar - 1];
			const firstFound = found[0];
			if (lastFound <= range.end || firstFound >= range.start || (firstFound <= range.start && lastFound >= range.end)) {
				inRangeOccurrences = reconstructOccurrences(event, ci.occurrences, range);
			}
			if (numFoundSoFar === limit || lastFound > range.end) {
				return inRangeOccurrences;
			}
			timeMachine.setTime(lastFound);
			D.addDays(timeMachine, 1);
			D.clearTime(timeMachine);
			tempStart = timeMachine.getTime();
			limit = limit - numFoundSoFar;
		}
		if (!event.countInfo) {
			countPrep(event);
		}
		const searchEnd = Math.min(event.countInfo.estimateEnd, range.end);
		const datesInRange = getDatesInRange({start: tempStart, end: searchEnd, tzId: event.tzId});
		const eventOccurrences = findRepeatsInRangeHelper(event, null, datesInRange, datesInEvent, hours, minutes, limit,
			timeMachine);
		const countInfo = event.countInfo;
		const occurrences = countInfo.occurrences || [];
		for (let i = 0; i < eventOccurrences.length; i++) {
			const instance = eventOccurrences[i];
			occurrences.push(instance.currentLocalStart);
			if (instance.currentLocalEnd >= range.start && instance.currentLocalStart < range.end) {
				delete instance.countInfo;
				inRangeOccurrences.push(instance);
			}
		}
		countInfo.occurrences = occurrences;
		return inRangeOccurrences;
	}

	// Load the rules of the events' zones (and the system's) from this year to 2050.
	async function findNextOccurrenceTimezonePrep(eventSet) {
		if (!eventSet || eventSet.length === 0) {
			return;
		}
		const years = [];
		for (let i = new Date().getFullYear(); i < 2051; i++) {
			years.push(i);
		}
		await tzm.setup();
		await tzm.loadTimezones(getUniqueTzIdsInEventSet(eventSet), years);
	}

	/*
		The local start time of the first occurrence of a repeating event
		that starts after date, or false: it does not repeat, has stopped, or
		none was found before its UNTIL (2050 when it has none).
	*/
	function findNextOccurrence(event, date) {
		if (!event.rrule || !event.rrule.freq) {
			return false;
		}
		let until;
		if (event.rrule.until !== null && event.rrule.until !== undefined) {
			until = event.rrule.until;
		} else {
			until = 2524608000000;
		}
		if (date > until) {
			return false;
		}
		let jumpDuration = 0;
		let interval = 1;
		if (event.rrule.interval) {
			interval = parseInt(event.rrule.interval, 10) || 1;
		}
		switch (event.rrule.freq) {
		case 'DAILY':
			jumpDuration = interval * 86400000;
			break;
		case 'WEEKLY':
			jumpDuration = interval * 604800000;
			break;
		case 'MONTHLY':
		case 'YEARLY':
			jumpDuration = interval * 2678400000;
			break;
		default:
			return false;
		}
		let repeatCycleContinues = true;
		let start = date;
		let end = date;
		let baseOccurrence;
		let nextOccurrence;
		const tzId = tzm.getSystemTimezone();
		const timeMachine = new Date();
		const datesInEventSize = getDatesInRange({start: event.dtstart, end: event.dtend, tzId: event.tzId}).length;
		while (repeatCycleContinues) {
			start = end;
			end = end + jumpDuration;
			const range = {start, end, tzId};
			let events;
			if (event.rrule.count) {
				events = findRepeatsInRangeCountVersion(event, range);
				if (event.rrule.count && event.countInfo && event.rrule.count == event.countInfo.length) { // jshint ignore:line
					repeatCycleContinues = false;
				}
			} else {
				events = findRepeatsInRange(event, range, datesInEventSize);
			}
			const nEvents = (events && events.length) || 0;
			for (let i = 0; i < nEvents; i++) {
				if (events[i].currentLocalStart > date) {
					nextOccurrence = events[i].currentLocalStart;
					break;
				}
			}
			if (nextOccurrence) {
				return nextOccurrence;
			}
			if (nEvents > 0 && events[nEvents - 1].currentLocalStart <= date) {
				if (!baseOccurrence || baseOccurrence.getTime() < events[nEvents - 1].currentLocalStart) {
					timeMachine.setTime(events[nEvents - 1].currentLocalStart);
					baseOccurrence = timeMachine;
				}
				end = D.addDays(baseOccurrence, 1).getTime();
			}
			if (end > until) {
				repeatCycleContinues = false;
			}
		}
		return false;
	}

	return {findNextOccurrenceTimezonePrep, findNextOccurrence, getDatesInRange, findOffset};
}

module.exports = {
	createTimezoneManager, createEventManager, evaluateRRule, evaluateExceptions, getWeekNumber,
	howManyDaysBetween, howManyMonthsBetween
};
