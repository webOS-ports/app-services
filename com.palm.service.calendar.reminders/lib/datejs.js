// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Derived from DateJS 1.0 Alpha-1 (the old service's datejs/date.js),
// Copyright (c) 2006-2007, Coolite Inc. (http://www.coolite.com/), licensed
// under the MIT License (http://www.datejs.com/license/):
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

'use strict';

/*
	The pieces of DateJS 1.0 Alpha-1 (the calendar framework's datejs/date.js)
	that the reminders and the calendar framework's recurrence code use, as
	functions on a plain Date instead of methods patched onto Date.prototype.

	They do what DateJS did, to the millisecond, as the reminder times depend
	on it: DateJS adds a number of milliseconds through setMilliseconds() on
	the local time, so "a day" is 86400000 ms of wall clock that is turned
	back into a time at the far side, and a DST change in between moves the
	result by the hour the change is worth. Even adding 0 goes through local
	time and back, which moves a time in the repeated hour of a DST end to
	its first instance. All of that is kept: the same engine calls do it.
*/

function addMilliseconds(d, value) {
	d.setMilliseconds(d.getMilliseconds() + value);
	return d;
}
const addSeconds = (d, v) => addMilliseconds(d, v * 1000);
const addMinutes = (d, v) => addMilliseconds(d, v * 60000);
const addHours = (d, v) => addMilliseconds(d, v * 3600000);
const addDays = (d, v) => addMilliseconds(d, v * 86400000);
const addWeeks = (d, v) => addMilliseconds(d, v * 604800000);

// Date.prototype.add({seconds, minutes, hours, days}): each one that is truthy, in DateJS's order.
function add(d, x) {
	if (x.seconds) {
		addSeconds(d, x.seconds);
	}
	if (x.minutes) {
		addMinutes(d, x.minutes);
	}
	if (x.hours) {
		addHours(d, x.hours);
	}
	if (x.days) {
		addDays(d, x.days);
	}
	return d;
}

function validate(value, min, max, name) {
	if (typeof value !== 'number') {
		throw new TypeError(value + ' is not a Number.');
	}
	if (value < min || value > max) {
		throw new RangeError(value + ' is not a valid value for ' + name + '.');
	}
	return true;
}

/*
	Date.prototype.set({hour, minute, second, millisecond}): the parts given,
	millisecond first, each as an add of the difference (so through local
	time, as above). Only the four time parts: nothing here sets a date.
*/
function setTime(d, x) {
	const has = v => v !== undefined && v !== null && !(Number.isNaN(v));
	if (has(x.millisecond) && validate(x.millisecond, 0, 999, 'milliseconds')) {
		addMilliseconds(d, x.millisecond - d.getMilliseconds());
	}
	if (has(x.second) && validate(x.second, 0, 59, 'seconds')) {
		addSeconds(d, x.second - d.getSeconds());
	}
	if (has(x.minute) && validate(x.minute, 0, 59, 'minutes')) {
		addMinutes(d, x.minute - d.getMinutes());
	}
	if (has(x.hour) && validate(x.hour, 0, 23, 'hours')) {
		addHours(d, x.hour - d.getHours());
	}
	return d;
}

function clearTime(d) {
	d.setHours(0);
	d.setMinutes(0);
	d.setSeconds(0);
	d.setMilliseconds(0);
	return d;
}

// Date.prototype.equals: compareTo, which throws on an invalid date on either side.
function equals(a, b) {
	if (isNaN(a)) {
		throw new Error(String(a));
	}
	if (!(b instanceof Date) || isNaN(b)) {
		throw new TypeError(String(b));
	}
	return a.getTime() === b.getTime();
}

const isLeapYear = y => ((y % 4 === 0) && (y % 100 !== 0)) || (y % 400 === 0);
const daysInMonth = (y, m) => [31, (isLeapYear(y) ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];

/*
	Date.parseExact(s, "yyyyMMdd") and (s, "yyyyMMddTHHmmss"), the only two
	formats used: a local Date, or null where DateJS gave null. Its grammar,
	for these two: yyyy four digits; MM 00-12 ("00" is month -1, December of
	the year before); dd 00-31, then an optional "st|nd|rd|th"; T; HH 00-23;
	mm and ss 00-59; nothing left over. A day past the month's end is null,
	but not when the month is "00", where DateJS's check had no month to
	look at. The year, month and day default to now's year, now's month and 1.
*/
function parseExact(s, format) {
	const withTime = format === 'yyyyMMddTHHmmss';
	let m = /^(\d\d\d\d)/.exec(s);
	if (!m) {
		return null;
	}
	let rest = s.slice(4);
	const year = Number(m[1]);
	m = /^(1[0-2]|0\d)/.exec(rest);
	if (!m) {
		return null;
	}
	const month = Number(m[1]) - 1;
	rest = rest.slice(m[0].length);
	m = /^([0-2]\d|3[0-1])/.exec(rest);
	if (!m) {
		return null;
	}
	const day = Number(m[1]);
	rest = rest.slice(m[0].length);
	const suffix = /^\s*(st|nd|rd|th)/i.exec(rest);
	if (suffix) {
		rest = rest.slice(suffix[0].length);
	}
	let hour = 0, minute = 0, second = 0;
	if (withTime) {
		if (rest[0] !== 'T') {
			return null;
		}
		rest = rest.slice(1);
		m = /^([0-1][0-9]|2[0-3])/.exec(rest);
		if (!m) {
			return null;
		}
		hour = Number(m[1]);
		rest = rest.slice(m[0].length);
		m = /^[0-5][0-9]/.exec(rest);
		if (!m) {
			return null;
		}
		minute = Number(m[0]);
		rest = rest.slice(2);
		m = /^[0-5][0-9]/.exec(rest);
		if (!m) {
			return null;
		}
		second = Number(m[0]);
		rest = rest.slice(2);
	}
	if (rest.length) {
		return null;
	}
	if (day > daysInMonth(year, month)) {
		return null;
	}
	return new Date(year, month, day, hour, minute, second);
}

module.exports = {
	addMilliseconds, addSeconds, addMinutes, addHours, addDays, addWeeks, add, setTime, clearTime, equals,
	parseExact, isLeapYear, daysInMonth
};
