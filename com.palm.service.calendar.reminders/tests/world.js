// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	What the service talks to, on a stand-in bus (palmbus.js): db8
	(fakedb.js), activitymanager, systemservice (getSystemTime, and
	getTimeZoneRules from the engine's zone data, tzrules.js) and the
	application manager, which records the calendar app's launches.

	activitymanager does what the LuneOS VM's did (2026-10-29): an activity
	made with a schedule or a trigger waits ("unsatisfied") until it is due;
	complete on a waiting activity fails with -1000 "Invalid transition:
	unsatisfied -> complete", on an unknown one with 2 "activityId not
	found"; create with replace takes the place of the activity of that
	name. fireDue() and fireWatches() play activitymanager calling back: the
	activity runs, and its callback gets $activity, from
	com.palm.activitymanager.

	An activity made with no callback is mojoservice's own for one command
	(the old service made one for every call that brought none): it runs at
	once, gets an id of its own range, and is left out of amLog, where every
	other create, complete and cancel is kept in order. fail() makes the
	next calls that match answer an error.
*/

const {createPalmbus} = require('./palmbus');
const {createFakeDb} = require('./fakedb');
const {getTimeZoneRules} = require('./tzrules');
const {performance} = require('perf_hooks');

const SERVICE = 'com.palm.service.calendar.reminders';
const AM_SENDER = 'com.palm.activitymanager';

function scheduleTime(schedule) {
	const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)Z$/.exec((schedule && schedule.start) || '');
	return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

function createWorld({timezone = 'Etc/UTC', serviceName = SERVICE, quietMs = 30} = {}) {
	const db = createFakeDb({prefix: 'R'});
	const amLog = [];
	const launches = [];
	const calls = [];
	const activities = new Map();
	const faults = [];
	let nextId = 100;
	let nextInternal = 900000;
	let serial = 7000;
	let pending = 0;
	let last = performance.now();
	let pb = null;

	function error(code, text) {
		return {returnValue: false, errorCode: code, errorText: text};
	}

	// fail(service, method, {n, reply, when(args)}): the next n calls that match answer reply.
	function fail(service, method, {n = 1, reply = error(-3999, 'stand-in: ' + method + ' failed'), when = null} = {}) {
		faults.push({service, method, n, reply, when});
	}

	function clearFaults() {
		faults.length = 0;
	}

	function faultFor(service, method, args) {
		for (const f of faults) {
			if (f.n > 0 && f.service === service && f.method === method && (!f.when || f.when(args))) {
				f.n--;
				return f.reply;
			}
		}
		return null;
	}

	function am(method, args) {
		const a = args || {};
		switch (method) {
		case 'create': {
			const spec = a.activity || {};
			const internal = !spec.callback;
			if (a.replace) {
				for (const [id, act] of activities) {
					if (act.name === spec.name) {
						activities.delete(id);
					}
				}
			}
			const id = internal ? nextInternal++ : nextId++;
			activities.set(id, {id, name: spec.name, internal, state: internal ? 'running' : 'waiting',
				schedule: spec.schedule, trigger: spec.trigger, callback: spec.callback, type: spec.type});
			if (!internal) {
				amLog.push({method, args: a});
			}
			const first = {activityId: id, returnValue: true, subscribed: !!a.subscribe};
			return a.subscribe ? [first, {activityId: id, event: 'start', returnValue: true}] : first;
		}
		case 'complete': {
			const act = activities.get(a.activityId);
			if (!act || !act.internal) {
				amLog.push({method, args: a});
			}
			if (!act) {
				return error(2, 'activityId not found');
			}
			if (act.state !== 'running') {
				return error(-1000, 'Invalid transition: unsatisfied -> complete');
			}
			if (a.restart) {
				act.state = 'waiting';
				for (const k of ['schedule', 'callback', 'trigger']) {
					if (a[k]) {
						act[k] = a[k];
					}
				}
			} else {
				activities.delete(a.activityId);
			}
			return {returnValue: true};
		}
		case 'cancel': {
			const act = activities.get(a.activityId);
			if (!act || !act.internal) {
				amLog.push({method, args: a});
			}
			if (!act) {
				return error(2, 'activityId not found');
			}
			activities.delete(a.activityId);
			return {returnValue: true};
		}
		case 'adopt':
			if (!activities.has(a.activityId)) {
				return error(2, 'activityId not found');
			}
			return {returnValue: true, adopted: true};
		case 'monitor':
			return activities.has(a.activityId) ? {returnValue: true, state: activities.get(a.activityId).state} :
				error(2, 'activityId not found');
		default:
			return error(-1, 'Unknown method "' + method + '"');
		}
	}

	async function onCall(uri, args, sender) {
		last = performance.now();
		try {
			const [, service, method] = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri);
			calls.push({service, method, args, sender});
			const f = faultFor(service, method, args);
			if (f) {
				return f;
			}
			if (service === 'com.palm.db') {
				await new Promise(r => setImmediate(r));
				return await db.handle(method, args);
			}
			if (service === 'com.palm.systemservice' && method === 'time/getSystemTime') {
				return {returnValue: true, timezone, utc: Math.floor(Date.now() / 1000)};
			}
			if (service === 'com.palm.systemservice' && method === 'timezone/getTimeZoneRules') {
				return getTimeZoneRules(args);
			}
			if (service === 'com.webos.service.applicationManager' && method === 'launch') {
				launches.push(args);
				return {returnValue: true, appId: args.id};
			}
			if (service === 'com.palm.activitymanager') {
				return am(method, args);
			}
			if (service === serviceName) {
				return JSON.parse(await pb.request(serviceName, method, args, {service: serviceName}));
			}
			return error(-1, 'stand-in: no ' + uri);
		} finally {
			pending--;
			last = performance.now();
		}
	}

	pb = createPalmbus(onCall);
	// A call counts from when it is made: palmbus.js hands it to onCall a turn later, and timers run before that.
	const issue = pb.Handle.prototype.call;
	pb.Handle.prototype.call = pb.Handle.prototype.callOneReply = pb.Handle.prototype.watch =
		pb.Handle.prototype.subscribe = function () {
			pending++;
			last = performance.now();
			return issue.apply(this, arguments);
		};

	// Quiet: nothing in flight on the bus, and nothing for ms.
	async function settle(ms = quietMs) {
		for (;;) {
			await new Promise(r => setTimeout(r, 5));
			if (pending === 0 && performance.now() - last >= ms) {
				return;
			}
		}
	}

	// A call to the service from caller ({service} or {appId}); -> its first reply, or "NO REPLY" after waitMs.
	async function request(method, params, {caller = {appId: 'com.palm.app.calendar'}, waitMs = 3000} = {}) {
		let timer;
		const reply = await Promise.race([pb.request(serviceName, method, params, caller),
			new Promise(r => {
				timer = setTimeout(() => r('"NO REPLY"'), waitMs);
			})]);
		clearTimeout(timer);
		await settle();
		return JSON.parse(reply);
	}

	async function fire(act, extra) {
		act.state = 'running';
		serial++;
		const m = /^palm:\/\/[^/]+\/(.+)$/.exec(act.callback.method);
		const params = Object.assign({}, act.callback.params, {$activity: Object.assign({activityId: act.id,
			name: act.name, callback: {serial}}, extra || {})});
		const reply = await request(m[1], params, {caller: {service: AM_SENDER}});
		if (reply && reply.returnValue === false && activities.get(act.id) === act) {
			activities.delete(act.id);
		}
		return {activityId: act.id, name: act.name, method: m[1], params: act.callback.params, reply};
	}

	// The waiting activities due by now, earliest first, called back one at a time.
	async function fireDue({max = 10} = {}) {
		const fired = [];
		for (let i = 0; i < max; i++) {
			const due = Array.from(activities.values())
				.filter(a => a.state === 'waiting' && !a.trigger && scheduleTime(a.schedule) <= Date.now())
				.sort((x, y) => scheduleTime(x.schedule) - scheduleTime(y.schedule) || x.id - y.id);
			if (!due.length) {
				break;
			}
			fired.push(await fire(due[0]));
		}
		return fired;
	}

	// The waiting db8 watches whose query finds something, called back.
	async function fireWatches({max = 10} = {}) {
		const fired = [];
		for (let i = 0; i < max; i++) {
			let hit = null;
			for (const a of Array.from(activities.values()).sort((x, y) => x.id - y.id)) {
				if (a.state === 'waiting' && a.trigger && a.trigger.method === 'palm://com.palm.db/watch') {
					const r = await db.find(a.trigger.params.query).catch(() => ({results: []}));
					if (r.results.length) {
						hit = a;
						break;
					}
				}
			}
			if (!hit) {
				break;
			}
			fired.push(await fire(hit, {trigger: {returnValue: true, fired: true}}));
		}
		return fired;
	}

	// An activity someone else made (the calendar app's calendar.startreminders, for one), waiting.
	function addActivity({name, callback, schedule, trigger}) {
		const id = nextId++;
		activities.set(id, {id, name, internal: false, state: 'waiting', schedule, trigger, callback});
		return id;
	}

	function fireById(id, extra) {
		return fire(activities.get(id), extra);
	}

	function state() {
		return {
			activities: Array.from(activities.values()).filter(a => !a.internal)
				.map(a => ({id: a.id, name: a.name, state: a.state, schedule: a.schedule, trigger: a.trigger,
					callback: a.callback})),
			reminders: db.all('com.palm.service.calendar.reminders:1', {deleted: true}),
			status: db.all('com.palm.service.calendar.remindersstatus:1', {deleted: true})
		};
	}

	return {palmbus: pb, db, amLog, launches, calls, activities, fail, clearFaults, request, settle, fireDue, fireWatches,
		addActivity, fireById, state,
		SERVICE: serviceName};
}

module.exports = {createWorld, scheduleTime, SERVICE};
