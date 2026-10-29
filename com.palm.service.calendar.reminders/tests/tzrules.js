// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	systemservice's timezone/getTimeZoneRules, worked out from the engine's
	time zone data, in the shape the LuneOS VM's systemservice answered
	(2026-10-29):

	{tz, year, hasDstChange, utcOffset, dstOffset, dstStart, dstEnd}, the
	offsets in seconds east of UTC (standard and daylight time), dstStart
	and dstEnd the UTC seconds daylight time begins and ends in that year,
	-1 for those three where the zone has no DST that year. In the southern
	hemisphere dstStart is in the spring and dstEnd in the autumn of the
	same calendar year, so dstStart > dstEnd: Australia/Sydney 2026 was
	{dstStart: 1791043200, dstEnd: 1775318400} on the VM.
*/

const formats = {};

// Seconds east of UTC in zone at the UTC time ms.
function offsetAt(tz, ms) {
	if (!formats[tz]) {
		formats[tz] = new Intl.DateTimeFormat('en-US', {timeZone: tz, timeZoneName: 'longOffset'});
	}
	const name = formats[tz].formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName').value;
	const m = /GMT([+-])(\d\d):(\d\d)(?::(\d\d))?/.exec(name);
	if (!m) {
		return 0;
	}
	const s = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] || 0);
	return m[1] === '-' ? -s : s;
}

// The first second at or after lo (UTC s) where the offset is not the one at lo, searching up to hi.
function transition(tz, lo, hi) {
	const before = offsetAt(tz, lo * 1000);
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (offsetAt(tz, mid * 1000) === before) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return hi;
}

function rulesFor(tz, year) {
	const start = Date.UTC(year, 0, 1) / 1000;
	const end = Date.UTC(year + 1, 0, 1) / 1000;
	const changes = [];
	let prev = offsetAt(tz, start * 1000);
	const offsets = new Set([prev]);
	for (let t = start + 86400; t <= end; t += 86400) {
		const o = offsetAt(tz, t * 1000);
		offsets.add(o);
		if (o !== prev) {
			changes.push({at: transition(tz, t - 86400, t), from: prev, to: o});
			prev = o;
		}
	}
	if (changes.length < 2) {
		const o = offsetAt(tz, start * 1000);
		return {tz, year, hasDstChange: false, utcOffset: changes.length ? changes[0].to : o, dstOffset: -1,
			dstStart: -1, dstEnd: -1};
	}
	const std = Math.min(...offsets);
	const dst = Math.max(...offsets);
	const on = changes.find(c => c.to === dst);
	const off = changes.find(c => c.to === std);
	return {tz, year, hasDstChange: true, utcOffset: std, dstOffset: dst, dstStart: on.at, dstEnd: off.at};
}

const cache = {};

// The reply to getTimeZoneRules [{tz, years}].
function getTimeZoneRules(pairs) {
	const results = [];
	for (const p of pairs || []) {
		for (const year of p.years || []) {
			const key = p.tz + ' ' + year;
			if (!cache[key]) {
				cache[key] = rulesFor(p.tz, year);
			}
			results.push(Object.assign({}, cache[key]));
		}
	}
	return {returnValue: true, results};
}

module.exports = {getTimeZoneRules, rulesFor, offsetAt};
