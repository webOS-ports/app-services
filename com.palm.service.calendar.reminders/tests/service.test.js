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
		// The answer is old bug 1's (the autoclose activity is waiting; see below).
		await env.world.request('onSnooze', {reminderId: r._id});
		assert.equal(env.reminder('s').showTime, T0 + 50 * MIN);
		assert.equal(env.byName('wake').schedule.start, '2026-10-23 12:50:00Z');
		assert.equal(env.byName('wake').state, 'waiting');
		await env.world.request('onSnooze', {reminderId: r._id, snoozeDuration: 60000});
		assert.equal(env.reminder('s').showTime, T0 + 46 * MIN);
	});

	it('old bug 1: a second snooze cannot move the waiting wake activity, and fails', async () => {
		const env = await start([event({_id: 's', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		env.clock.set(T0 + 45 * MIN);
		await env.world.fireDue();
		const r = env.reminder('s');
		await env.world.request('onSnooze', {reminderId: r._id});
		const reply = await env.world.request('onSnooze', {reminderId: r._id, snoozeDuration: 60000});
		assert.equal(reply.returnValue, false);
		assert.equal(reply.errorCode, -1000);
		// The reminder is due at 12:46, the wake still at 12:50.
		assert.equal(env.reminder('s').showTime, T0 + 46 * MIN);
		assert.equal(env.byName('wake').schedule.start, '2026-10-23 12:50:00Z');
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

	it('a missing argument is the thrown string of the old service', async () => {
		const env = await start([]);
		const reply = await env.world.request('onSnooze', {});
		assert.equal(reply.returnValue, false);
		assert.equal(reply.errorCode, -9999);
		assert.match(reply.exception, /^Missing args! Need reminderId\./);
	});

	it('onDBChanged: a deleted event is closed in the app (old bug 1: the waiting wake is not ended, nor the watch armed)', async () => {
		const env = await start([event({_id: 'x', dtstart: T0 + 3 * HOUR, dtend: T0 + 4 * HOUR, trigger: '-PT15M'})]);
		await env.world.db.del(['x']);
		const fired = await env.world.fireWatches();
		assert.equal(fired.length, 1);
		assert.deepEqual(env.world.launches.map(l => l.params), [{alarmDeleted: ['x']}]);
		assert.equal(env.reminder('x'), undefined);
		assert.deepEqual(env.world.amLog[env.world.amLog.length - 1], {method: 'complete', args: {activityId: 101}});
		assert.equal(env.byName('wake').state, 'waiting');
		assert.equal(env.byName('dbchanged').state, 'running');
	});

	it('onDBChanged: an event added after the next wake gets its reminder', async () => {
		const env = await start([event({_id: 'a', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		await env.world.db.put([event({_id: 'b', dtstart: T0 + 5 * HOUR, dtend: T0 + 6 * HOUR, trigger: '-PT5M'})]);
		await env.world.fireWatches();
		assert.equal(env.reminder('b').showTime, T0 + 5 * HOUR - 5 * MIN);
	});

	it('old bug 2: a failed reminder query leaves the command without an answer', async () => {
		const env = await start([]);
		env.world.fail('com.palm.db', 'find', {n: 5, when: a => a.query.from === 'com.palm.service.calendar.reminders:1' &&
			a.query.orderBy === 'showTime'});
		assert.equal(await env.world.request('onSnooze', {reminderId: 'R1'}, {waitMs: 1000}), 'NO REPLY');
	});

	it('old bug 1: an event earlier than the waiting wake fails the command, and the watch is not armed again', async () => {
		const env = await start([event({_id: 'late', dtstart: T0 + 5 * HOUR, dtend: T0 + 6 * HOUR, trigger: '-PT15M'})]);
		await env.world.db.put([event({_id: 'soon', dtstart: T0 + HOUR, dtend: T0 + 2 * HOUR, trigger: '-PT15M'})]);
		await env.world.fireWatches();
		const last = env.world.amLog[env.world.amLog.length - 1];
		assert.equal(last.method, 'complete');
		assert.equal(last.args.activityId, env.byName('wake').id);
		// The wake still points at the later event, and the watch is left running.
		assert.equal(env.byName('wake').callback.params.showTime, T0 + 5 * HOUR - 15 * MIN);
		assert.equal(env.byName('dbchanged').state, 'running');
	});
});
