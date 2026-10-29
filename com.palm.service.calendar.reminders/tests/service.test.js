// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The service end to end on a stand-in world (world.js): db8,
	activitymanager as the LuneOS VM's answers it, the calendar app's
	launches, and a clock the tests set, in Europe/Amsterdam (summer time
	ends 2026-10-25 03:00 local). The answers are the ones the mojoservice
	service gave; the A/B of the two on generated calendars is how they were
	found (README.md). Tests named "old bug" pin down what the old service
	did wrong, until the commit that fixes it.
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const {boot, event} = require('./boot');

const MIN = 60000, HOUR = 3600000;
const T0 = Date.UTC(2026, 9, 23, 12, 0); // Friday 2026-10-23 14:00 CEST
const INIT = 'palm://com.palm.service.calendar.reminders/onInit';

async function start(events, now = T0) {
	const env = await boot({now, tz: 'Europe/Amsterdam'});
	if (events.length) {
		await env.world.db.put(events);
	}
	const id = env.world.addActivity({name: 'calendar.startreminders', callback: {method: INIT, params: {}}});
	env.init = await env.world.fireById(id);
	env.byName = name => env.world.state().activities.find(a => a.name === 'calendar.reminders.' + name);
	env.reminder = eventId => env.world.state().reminders.find(r => r.eventId === eventId && !r._del);
	return env;
}

describe('the reminders service', () => {
	it('registers the six methods of the old service', async () => {
		const {world} = await start([]);
		const methods = world.palmbus.services['com.palm.service.calendar.reminders'].methods.map(m => m.replace(/^\//, ''));
		for (const m of ['onAutoClose', 'onDBChanged', 'onDismiss', 'onInit', 'onSnooze', 'onWake']) {
			assert.ok(methods.includes(m), m);
		}
	});

	it('onInit with no events: the db watch, no wake or autoclose, status OK, its activity completed', async () => {
		const env = await start([]);
		assert.deepEqual(env.init.reply, {returnValue: true});
		const s = env.world.state();
		assert.deepEqual(s.activities.map(a => [a.name, a.state]), [['calendar.reminders.dbchanged', 'waiting']]);
		assert.deepEqual(env.byName('dbchanged').trigger.params.query,
			{from: 'com.palm.calendarevent:1', where: [{prop: '_rev', op: '>', val: 0}], incDel: true});
		assert.equal(s.status.length, 1);
		assert.equal(s.status[0].status, 'OK');
		assert.deepEqual(env.world.amLog.map(c => c.method), ['create', 'complete']);
	});

	it('a display alarm is shown at its time, and closed at the end of the event', async () => {
		const env = await start([event({_id: 'e2', subject: 'Standup', dtstart: Date.UTC(2026, 9, 24, 10, 0),
			dtend: Date.UTC(2026, 9, 24, 11, 0), trigger: '-PT15M'})]);
		const wake = env.byName('wake');
		assert.equal(wake.schedule.start, '2026-10-24 09:45:00Z');
		assert.deepEqual(wake.callback.params, {showTime: Date.UTC(2026, 9, 24, 9, 45)});
		assert.equal(env.byName('autoclose').schedule.start, '2026-10-24 11:00:00Z');

		env.clock.set(Date.UTC(2026, 9, 24, 9, 45));
		await env.world.fireDue();
		assert.equal(env.world.launches.length, 1);
		const shown = env.world.launches[0];
		assert.equal(shown.id, 'com.palm.app.calendar');
		assert.equal(shown.params.alarm.length, 1);
		// The times go to the app as strings, as the old service sent them.
		assert.equal(shown.params.alarm[0].subject, 'Standup');
		assert.equal(shown.params.alarm[0].startTime, String(Date.UTC(2026, 9, 24, 10, 0)));

		env.clock.set(Date.UTC(2026, 9, 24, 11, 0));
		await env.world.fireDue();
		const closed = env.world.launches[0].params.alarm[0]._id;
		assert.deepEqual(env.world.launches[1].params, {alarmClose: [closed]});
		assert.ok(!env.world.state().reminders.some(r => r._id === closed && !r._del));
	});

	it('a one-day alarm over the end of summer time is one local day, 25 hours (DateJS arithmetic)', async () => {
		// 2026-10-25 09:00 CET is 08:00Z; the day before at 09:00 is CEST, 07:00Z.
		const env = await start([event({_id: 'e1', dtstart: Date.UTC(2026, 9, 25, 8, 0), dtend: Date.UTC(2026, 9, 25, 9, 0),
			trigger: '-P1D'})]);
		assert.equal(env.reminder('e1').showTime, Date.UTC(2026, 9, 24, 7, 0));
		assert.equal(env.byName('wake').schedule.start, '2026-10-24 07:00:00Z');
	});

	it('a daily event over the end of summer time keeps its local time', async () => {
		const env = await start([event({_id: 'd', dtstart: Date.UTC(2026, 9, 22, 7, 0), dtend: Date.UTC(2026, 9, 22, 8, 0),
			rrule: {freq: 'DAILY'}, trigger: '-PT10M'})]);
		// 09:00 CEST on the 24th, then 09:00 CET on the 25th.
		assert.equal(env.reminder('d').startTime, Date.UTC(2026, 9, 24, 7, 0));
		env.clock.set(Date.UTC(2026, 9, 24, 8, 0) + MIN);
		await env.world.fireDue();
		assert.equal(env.reminder('d').startTime, Date.UTC(2026, 9, 25, 8, 0));
		assert.equal(env.reminder('d').showTime, Date.UTC(2026, 9, 25, 7, 50));
	});

	it('onSnooze shows the reminder again five minutes on (or snoozeDuration)', async () => {
		const env = await start([event({_id: 's', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		env.clock.set(T0 + 45 * MIN);
		await env.world.fireDue();
		const r = env.reminder('s');
		assert.equal((await env.world.request('onSnooze', {reminderId: r._id})).returnValue, true);
		assert.equal(env.reminder('s').showTime, T0 + 50 * MIN);
		assert.equal(env.byName('wake').schedule.start, '2026-10-23 12:50:00Z');
		assert.equal(env.byName('wake').state, 'waiting');
		await env.world.request('onSnooze', {reminderId: r._id, snoozeDuration: 60000});
		assert.equal(env.reminder('s').showTime, T0 + 46 * MIN);
	});

	it('bug 1: a second snooze moves the wake that is waiting: it is created again', async () => {
		const env = await start([event({_id: 's', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		env.clock.set(T0 + 45 * MIN);
		await env.world.fireDue();
		const r = env.reminder('s');
		await env.world.request('onSnooze', {reminderId: r._id});
		const before = env.byName('wake').id;
		assert.equal((await env.world.request('onSnooze', {reminderId: r._id, snoozeDuration: 60000})).returnValue, true);
		assert.equal(env.reminder('s').showTime, T0 + 46 * MIN);
		const wake = env.byName('wake');
		assert.equal(wake.schedule.start, '2026-10-23 12:46:00Z');
		assert.notEqual(wake.id, before);
		assert.equal(env.world.activities.has(before), false);
		assert.equal(env.world.state().status[0].wakeActivityId, wake.id);
	});

	it('bug 1: an activity someone cancelled is created again', async () => {
		const env = await start([event({_id: 'a', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		env.world.activities.delete(env.byName('wake').id);
		env.world.activities.delete(env.byName('dbchanged').id);
		await env.world.db.put([event({_id: 'b', dtstart: T0 + 30 * MIN, dtend: T0 + HOUR, trigger: '-PT5M'})]);
		assert.deepEqual(await env.world.request('onDBChanged', {}), {returnValue: true, wakeStatus: 'created',
			autoCloseStatus: 'created', dbChangedStatus: 'created'});
		assert.equal(env.byName('wake').schedule.start, '2026-10-23 12:25:00Z');
		assert.equal(env.byName('dbchanged').state, 'waiting');
		await env.world.db.put([event({_id: 'c', dtstart: T0 + 3 * HOUR, dtend: T0 + 4 * HOUR, trigger: '-PT5M'})]);
		assert.equal((await env.world.fireWatches()).length, 1);
		assert.ok(env.reminder('c'));
	});

	it('onDismiss removes the reminder; a repeating event gets its next one', async () => {
		const env = await start([event({_id: 'w', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, rrule: {freq: 'WEEKLY'},
			trigger: '-PT15M'})]);
		env.clock.set(T0 + 45 * MIN);
		await env.world.fireDue();
		const r = env.reminder('w');
		await env.world.request('onDismiss', {reminderId: r._id, eventId: 'w', startTime: r.startTime});
		const next = env.reminder('w');
		assert.notEqual(next._id, r._id);
		// A week on, 14:00 CET: an hour later in UTC than the CEST one.
		assert.equal(next.startTime, Date.UTC(2026, 9, 30, 14, 0));
	});

	it('bug 4: an event the rules throw on loses its own reminder only', async () => {
		const env = await start([
			event({_id: 'good', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'}),
			event({_id: 'badExdate', dtstart: T0 - 48 * HOUR, dtend: T0 - 47 * HOUR, rrule: {freq: 'DAILY'},
				exdates: ['2026XX01'], trigger: '-PT15M'}),
			Object.assign(event({_id: 'badAlarm', dtstart: T0 + 3 * HOUR, dtend: T0 + 4 * HOUR}),
				{alarm: [{action: 'display', alarmTrigger: {valueType: 'DURATION', value: 15}}]})
		]);
		assert.deepEqual(env.world.state().reminders.filter(r => !r._del).map(r => r.eventId), ['good']);
		assert.equal(env.world.state().status[0].status, 'OK');
		assert.equal(env.byName('wake').callback.params.showTime, T0 + 45 * MIN);
	});

	it('bug 11: with getSystemTime failing, or naming no zone, the process\'s own zone is taken', async () => {
		for (const reply of [undefined, {returnValue: true, utc: 1}]) {
			const env = await boot({now: T0, tz: 'Europe/Amsterdam'});
			env.world.fail('com.palm.systemservice', 'time/getSystemTime', reply ? {n: 9, reply} : {n: 9});
			await env.world.db.put([event({_id: 'a', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
			assert.equal((await env.world.request('onInit', {}, {waitMs: 1500})).returnValue, true);
			const r = env.world.state().reminders.filter(x => !x._del);
			assert.deepEqual(r.map(x => [x.eventId, x.showTime]), [['a', T0 + 45 * MIN]]);
		}
	});

	it('bug 9: an event with no end is shown, and closed 15 minutes after its start', async () => {
		const env = await start([event({_id: 'n', dtstart: T0 + HOUR, trigger: '-PT15M'})]);
		const r = env.reminder('n');
		assert.equal(r.endTime, T0 + HOUR);
		assert.equal(r.autoCloseTime, T0 + HOUR + 15 * MIN);
		env.clock.set(T0 + 45 * MIN);
		await env.world.fireDue();
		assert.equal(env.world.launches.length, 1);
		assert.equal(env.world.launches[0].params.alarm[0].endTime, String(T0 + HOUR));
	});

	it('a missing argument is the thrown string of the old service', async () => {
		const env = await start([]);
		const reply = await env.world.request('onSnooze', {});
		assert.equal(reply.returnValue, false);
		assert.equal(reply.errorCode, -9999);
		assert.match(reply.exception, /^Missing args! Need reminderId\./);
	});

	it('onDBChanged: a deleted event is closed in the app, its wake cancelled, and the watch armed again', async () => {
		const env = await start([event({_id: 'x', dtstart: T0 + 3 * HOUR, dtend: T0 + 4 * HOUR, trigger: '-PT15M'})]);
		await env.world.db.del(['x']);
		const fired = await env.world.fireWatches();
		assert.equal(fired.length, 1);
		assert.deepEqual(env.world.launches.map(l => l.params), [{alarmDeleted: ['x']}]);
		assert.equal(env.reminder('x'), undefined);
		assert.equal(env.byName('wake'), undefined);
		assert.equal(env.world.state().status[0].wakeActivityId, 0);
		assert.equal(env.byName('dbchanged').state, 'waiting');
	});

	it('onDBChanged: an event added after the next wake gets its reminder', async () => {
		const env = await start([event({_id: 'a', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		await env.world.db.put([event({_id: 'b', dtstart: T0 + 5 * HOUR, dtend: T0 + 6 * HOUR, trigger: '-PT5M'})]);
		await env.world.fireWatches();
		assert.equal(env.reminder('b').showTime, T0 + 5 * HOUR - 5 * MIN);
	});

	it('bug 2: a failed reminder query is answered, and leaves the wake as it was', async () => {
		const env = await start([event({_id: 's', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		const wake = env.byName('wake');
		env.world.fail('com.palm.db', 'find', {n: 5, when: a => a.query.from === 'com.palm.service.calendar.reminders:1' &&
			a.query.orderBy === 'showTime'});
		const reply = await env.world.request('onSnooze', {reminderId: env.reminder('s')._id}, {waitMs: 1000});
		assert.equal(reply.returnValue, true);
		assert.deepEqual(env.byName('wake'), wake);
		env.world.clearFaults();
		env.world.fail('com.palm.db', 'find', {n: 5, when: a => a.query.from === 'com.palm.service.calendar.reminders:1' &&
			a.query.orderBy === 'autoCloseTime'});
		assert.deepEqual(await env.world.request('onSnooze', {reminderId: env.reminder('s')._id}, {waitMs: 1000}),
			{returnValue: true, status: 'dbError'});
	});

	it('bug 2: a failed event query in onInit is answered, and the next run starts over', async () => {
		const env = await boot({now: T0, tz: 'Europe/Amsterdam'});
		await env.world.db.put([event({_id: 'a', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		env.world.fail('com.palm.db', 'find', {when: a => a.query.from === 'com.palm.calendarevent:1'});
		assert.equal((await env.world.request('onInit', {}, {waitMs: 1000})).returnValue, true);
		assert.equal(env.world.state().status[0].status, 'FAIL');
		env.world.clearFaults();
		await env.world.request('onDBChanged', {});
		// The start over deletes the status; the reminder is back.
		assert.equal(env.world.state().reminders.filter(r => !r._del).length, 1);
		assert.deepEqual(env.world.state().status.filter(r => !r._del), []);
	});

	it('bug 1: an event earlier than the waiting wake moves the wake, and the watch is armed again', async () => {
		const env = await start([event({_id: 'late', dtstart: T0 + 5 * HOUR, dtend: T0 + 6 * HOUR, trigger: '-PT15M'})]);
		await env.world.db.put([event({_id: 'soon', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		const fired = await env.world.fireWatches();
		assert.deepEqual(fired[0].reply, {returnValue: true});
		assert.equal(env.byName('wake').callback.params.showTime, T0 + 45 * MIN);
		assert.equal(env.byName('autoclose').callback.params.autoCloseTime, T0 + 2 * HOUR);
		assert.equal(env.byName('dbchanged').state, 'waiting');
		env.clock.set(T0 + 45 * MIN);
		await env.world.fireDue();
		assert.equal(env.world.launches[env.world.launches.length - 1].params.alarm[0].eventId, 'soon');
	});
});
