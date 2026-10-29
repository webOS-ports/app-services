// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's reminder-assistant.js, Copyright (c) 2010-2013
// LG Electronics, Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The work the commands share, as ReminderAssistant did it:

	- reminderTimes: the next reminder of each event, into the reminders kind
	- nextWake / nextAutoClose: the earliest reminder to show and to close,
	  and the activity that wakes the service for it
	- dbWatch: the activity that calls onDBChanged when an event changes
	- the status record: the last event revision seen, and the activities' ids

	Each step answers and fails where the old one did. Two things in that
	are not what the comments in the old code say, and are kept until the
	commits after this one (README.md): a db8 or activitymanager call that
	fails is an exception that ends the command, never the returnValue:false
	the old code tested for; and the status of a step is written with a
	db8 merge nobody waits for (later() here), as the old code did.
*/

const {findDisplayAlarm, calculateAlarmTime, utcDateString} = require('./alarm');

const REMINDERS = 'com.palm.service.calendar.reminders:1';
const STATUS = 'com.palm.service.calendar.remindersstatus:1';
const EVENTS = 'com.palm.calendarevent:1';
const AM = 'palm://com.palm.activitymanager/';
const SELF = 'palm://com.palm.service.calendar.reminders/';
const STATUS_QUERY = {from: STATUS};

// The current time, whole seconds, as the old code took it for the reminder queries.
function nowSeconds() {
	const date = new Date();
	date.setMilliseconds(0);
	return date.getTime();
}

function createReminders({db, call, events, log = console}) {
	// A call whose answer nobody waits for, as the old code's tempFutures.
	const later = (p) => {
		p.catch(e => log.error('rmdrsvc: ' + ((e && e.message) || e)));
	};
	const markFailed = () => later(db.merge(STATUS_QUERY, {status: 'FAIL'}));

	// ---- reminder times -------------------------------------------------------------------------

	/*
		r: {results: events, lastRevNumber, eventDismissed, skipPastStartTime}.
		-> {reminderList, lastRevNumber}: the highest _rev among the events and
		r.lastRevNumber.
	*/
	async function findReminderTimes(r) {
		const evs = r && r.results;
		let revNumber = r.lastRevNumber || 0;
		const skipPastStartTime = r.skipPastStartTime;
		const eventDismissed = r.eventDismissed;
		const reminderList = [];
		let now = new Date().getTime();
		const eventsLength = evs && evs.length;
		if (eventDismissed && skipPastStartTime) {
			now = skipPastStartTime + 1000;
		}
		// The event's next reminder, or null.
		function reminderOf(event) {
			let startTime, isRepeatEvent;
			if (!event.alarm || event.alarm.length === 0) {
				return null;
			}
			const displayAlarmIndex = findDisplayAlarm(event.alarm);
			if (displayAlarmIndex === null) {
				return null;
			}
			// Bug 9: an event with no end lasts no time (its reminder had no end, and onWake failed on it).
			const dtend = (event.dtend === undefined || event.dtend === null) ? event.dtstart : event.dtend;
			if (dtend < now && !event.rrule) {
				return null;
			}
			if (eventDismissed && !event.rrule) {
				return null;
			}
			if (event.rrule && event.rrule.freq && event.rrule.until && event.rrule.until < now) {
				return null;
			}
			if ((event.rrule && event.rrule.freq) && (!event.rrule.until || (event.rrule.until && event.rrule.until > now))) {
				startTime = events.findNextOccurrence(event, now);
				isRepeatEvent = true;
				if (startTime === false) {
					return null;
				}
			} else {
				startTime = event.dtstart;
				isRepeatEvent = false;
			}
			const alarmTime = calculateAlarmTime(startTime, event.alarm[displayAlarmIndex]);
			const showTime = (alarmTime < now && startTime >= now) ? startTime : alarmTime;
			// Kept open at least 15 minutes.
			const duration = dtend - event.dtstart;
			const autoCloseTime = (duration < 900000) ? (startTime + 900000) : (startTime + duration);
			const shouldBeShowingNow = (!eventDismissed && now >= showTime && now <= autoCloseTime);
			if (!(showTime >= now || shouldBeShowingNow)) {
				return null;
			}
			return {
				_kind: REMINDERS,
				eventId: event._id,
				subject: event.subject,
				location: event.location,
				isAllDay: event.allDay,
				attendees: event.attendees,
				calendarId: event.calendarId,
				startTime,
				endTime: startTime + duration,
				alarmTime,
				showTime,
				autoCloseTime,
				isRepeating: isRepeatEvent
			};
		}

		await events.findNextOccurrenceTimezonePrep(evs);
		for (let i = 0; i < eventsLength; i++) {
			const event = evs[i];
			if (event._rev > revNumber) {
				revNumber = event._rev;
			}
			// Bug 4: an event the rules throw on (an exception date DateJS cannot read, a repeating event with no
			// start, an alarm that is not a string) loses its own reminder, not the reminders of the whole set.
			try {
				const reminder = reminderOf(event);
				if (reminder) {
					reminderList.push(reminder);
				}
			} catch (e) {
				log.error('rmdrsvc: event ' + event._id + ' skipped: ' + ((e && e.message) || e));
			}
		}
		return {reminderList, lastRevNumber: revNumber};
	}

	/*
		Work out the events' next reminders and store them. -> {returnValue,
		lastRevNumber, status: "OK" | "FAIL"}, or {returnValue: true} for no
		events. A failed put drops the reminders of every event in the set and
		marks the status FAIL.
	*/
	async function reminderTimes(result) {
		if (result.returnValue === false) {
			return result;
		}
		const evs = result.results;
		if (!(evs && evs.length)) {
			log.log('rmdrsvc: findReminderTimesSubroutine: no events');
			return {returnValue: true};
		}
		let lastRevNumber;
		try {
			const found = await findReminderTimes({
				results: result.results,
				skipPastStartTime: result.skipPastStartTime,
				eventDismissed: result.eventDismissed,
				lastRevNumber: result.lastRevNumber
			});
			lastRevNumber = found.lastRevNumber;
			if (found.reminderList && found.reminderList.length) {
				await db.put(found.reminderList);
			}
			return {returnValue: true, lastRevNumber, status: 'OK'};
		} catch (e) {
			log.error('rmdrsvc: new reminders were lost: ' + ((e && e.stack) || e));
			markFailed();
			return {returnValue: true, lastRevNumber, status: 'FAIL'};
		}
	}

	// ---- the wake and auto-close activities ------------------------------------------------------

	/*
		The activity that calls `callback` at the first reminder's `field`
		time: created, moved there (complete with restart), or completed when
		there is none; its id kept in the status as `idField`. One that
		activitymanager will not complete is created again, or cancelled.
		-> {returnValue, status: "created" | "updated" | "completed" | "none"}
	*/
	async function scheduleActivity(reminders, {idField, field, name, description, callback, param}) {
		const remindersLength = reminders && reminders.length;
		const st = await db.find(STATUS_QUERY);
		let activityId;
		if (st.returnValue === true && st.results.length > 0) {
			activityId = st.results[0][idField];
		}
		let method, args, statusAction = 'none';
		let create = null;
		if (!remindersLength) {
			if (activityId) {
				statusAction = 'completed';
				method = 'complete';
				args = {activityId};
			}
		} else {
			const date = reminders[0][field];
			const dateString = utcDateString(date);
			log.log('rmdrsvc: ' + name + ' at ' + dateString + ' / ' + date + ' / ' + reminders[0]._id);
			create = {start: true, replace: true, activity: {name, description, type: {persist: true, foreground: true},
				schedule: {start: dateString}, callback: {method: SELF + callback, params: {[param]: date}}}};
			if (activityId) {
				statusAction = 'updated';
				method = 'complete';
				args = {activityId, restart: true, schedule: {start: dateString},
					callback: {method: SELF + callback, params: {[param]: date}}};
			} else {
				statusAction = 'created';
				method = 'create';
				args = create;
			}
		}
		let res = {returnValue: true};
		if (method === 'complete') {
			try {
				res = await call(AM + method, args);
			} catch (e) {
				/*
					Bug 1: activitymanager completes only a running activity. One
					that is still waiting (or that it no longer knows) is replaced:
					created again under its name, or, with no reminder to wait for,
					cancelled.
				*/
				log.log('rmdrsvc: ' + name + ' ' + activityId + ' not completed (' + ((e && e.message) || e) + ')');
				if (create) {
					res = await call(AM + 'create', create);
					statusAction = 'created';
				} else {
					await call(AM + 'cancel', {activityId}).catch(() => null);
				}
			}
		} else if (method) {
			res = await call(AM + method, args);
		}
		let merged;
		if (statusAction === 'none' || statusAction === 'completed') {
			merged = await db.merge(STATUS_QUERY, {[idField]: 0});
		} else if (statusAction === 'created') {
			merged = await db.merge(STATUS_QUERY, {[idField]: res.activityId});
		} else {
			merged = {returnValue: true};
		}
		return {returnValue: merged.returnValue, status: statusAction};
	}

	const WAKE = {idField: 'wakeActivityId', field: 'showTime', name: 'calendar.reminders.wake',
		description: 'Time to show a calendar reminder', callback: 'onWake', param: 'showTime'};
	const AUTOCLOSE = {idField: 'autoCloseActivityId', field: 'autoCloseTime', name: 'calendar.reminders.autoclose',
		description: 'Time to autoclose a calendar reminder', callback: 'onAutoClose', param: 'autoCloseTime'};

	/*
		Schedule the wake for the next reminder to show. From onWake
		(startSearchTime given), the reminders due by now are set aside as
		pastReminders, for onWake to show as well, and the wake goes to the
		first one after now.
		-> {returnValue, status, pastReminders?}
	*/
	async function nextWake(result) {
		const now = nowSeconds();
		let fromOnWake = false;
		let pastReminders;
		let hasPastReminders = false;
		let query;
		if (result.startSearchTime) {
			fromOnWake = true;
			query = {from: REMINDERS, where: [{prop: 'showTime', op: '>=', val: result.startSearchTime}], orderBy: 'showTime'};
		} else {
			query = {from: REMINDERS, where: [{prop: 'showTime', op: '>=', val: now}], orderBy: 'showTime', limit: 1};
		}
		let found;
		try {
			found = await db.find(query);
		} catch (e) {
			// Bug 2: the old handler read the error again and never answered. As it meant to: the wake stays as it is.
			log.error('rmdrsvc: findNextWakeTimeSubroutine: reminder query failed: ' + ((e && e.message) || e));
			return {returnValue: false, status: 'dbError'};
		}
		const results = found.results;
		const resultsLength = results && results.length;
		if (fromOnWake && resultsLength) {
			let i = 0;
			pastReminders = [];
			while (i < resultsLength && results[i].showTime <= now) {
				pastReminders.push(results[i]);
				hasPastReminders = true;
				i++;
			}
			found.results = i < resultsLength ? [results[i]] : [];
		}
		const out = await scheduleActivity(found.results, WAKE);
		if (hasPastReminders) {
			out.pastReminders = pastReminders;
		}
		return out;
	}

	// Schedule the auto-close of the next reminder to close. -> {returnValue, status}
	async function nextAutoClose() {
		const now = nowSeconds();
		let found;
		try {
			found = await db.find({from: REMINDERS, where: [{prop: 'autoCloseTime', op: '>=', val: now}],
				orderBy: 'autoCloseTime', limit: 1});
		} catch (e) {
			log.error('rmdrsvc: findNextAutoCloseTimeSubroutine: reminder query failed: ' + ((e && e.message) || e));
			return {returnValue: false, status: 'dbError'};
		}
		return scheduleActivity(found.results, AUTOCLOSE);
	}

	// ---- the db8 watch ----------------------------------------------------------------------------

	function dbWatchActivity(activityId, isUnitTest, lastRevNumber) {
		const eventQuery = {from: EVENTS, where: [{prop: '_rev', op: '>', val: lastRevNumber}], incDel: true};
		const trigger = {key: 'fired', method: 'palm://com.palm.db/watch', params: {query: eventQuery}};
		if (activityId && !isUnitTest) {
			return {method: 'complete', args: {activityId, restart: true, trigger}};
		}
		return {method: 'create', args: {start: true, replace: true, activity: {
			name: 'calendar.reminders.dbchanged',
			description: 'Calendar database changed, check for new reminders',
			callback: {method: SELF + 'onDBChanged', params: {unittest: isUnitTest}},
			trigger,
			type: {immediate: true, priority: 'low', persist: true}
		}}};
	}

	/*
		Arm the activity that calls onDBChanged once an event past
		lastRevNumber changes: the one in the status moved on (complete with
		restart), or a new one. -> {returnValue, status, result}
	*/
	async function dbWatch({dbChangedActivityId, isUnitTest, lastRevNumber}) {
		const {method, args} = dbWatchActivity(dbChangedActivityId, isUnitTest, lastRevNumber);
		let res;
		try {
			res = await call(AM + method, args);
		} catch (e) {
			if (method !== 'complete') {
				throw e;
			}
			// Bug 1: a watch that is waiting, or gone, cannot be completed: a new one takes its place.
			log.log('rmdrsvc: watch ' + dbChangedActivityId + ' not completed (' + ((e && e.message) || e) + ')');
			res = await call(AM + 'create', dbWatchActivity(0, isUnitTest, lastRevNumber).args);
		}
		let status, merged;
		if (res.returnValue === true && res.activityId) {
			status = 'created';
			merged = await db.merge(STATUS_QUERY, {dbChangedActivityId: res.activityId});
		} else if (res.returnValue === true && !res.activityId) {
			status = 'updated';
			merged = res;
		} else {
			status = 'failed';
			merged = await db.merge(STATUS_QUERY, {dbChangedActivityId: 0});
		}
		return {returnValue: true, status, result: merged};
	}

	// ---- the status --------------------------------------------------------------------------------

	/*
		What the status says to go on from: {lastRevNumber, dbChangedActivityId}.
		A status that is not OK starts over: the status and every reminder
		deleted. The old code meant to cancel the three activities too, but
		looked for their ids on the list of statuses rather than on the status,
		so it never did (README.md).
	*/
	async function prepareForTakeoff(result) {
		const returnValue = result.returnValue;
		const queryResult = result.results;
		const queryResultLength = queryResult && queryResult.length;
		if (returnValue && queryResultLength > 0 && queryResult[0].status == 'OK') { // jshint ignore:line
			return {returnValue: true, lastRevNumber: queryResult[0].lastRevNumber,
				dbChangedActivityId: queryResult[0].dbChangedActivityId};
		}
		if (returnValue && queryResultLength === 0) {
			log.log('rmdrsvc: prepareForTakeoff: first run');
			return {returnValue: true, lastRevNumber: 0, dbChangedActivityId: 0};
		}
		log.log('rmdrsvc: prepareForTakeoff: starting over');
		await startOver(result);
		return {returnValue: true, lastRevNumber: 0, dbChangedActivityId: 0};
	}

	async function startOver(result) {
		const results = result.results;
		const ids = ['wakeActivityId', 'autoCloseActivityId', 'dbChangedActivityId'].map(k => results && results[k]);
		await db.batch([
			{method: 'del', params: {query: {from: STATUS}}},
			{method: 'del', params: {query: {from: REMINDERS}}}
		]);
		for (const activityId of ids) {
			if (activityId) {
				await call(AM + 'cancel', {activityId});
			}
		}
		return {returnValue: true, startedOver: true};
	}

	// A new status: OK (or the status given) at lastRevNumber. Only onInit's full scan writes one.
	function setStatusAndRev(result) {
		const lastRevNumber = result.lastRevNumber || 0;
		const status = result.status || 'OK';
		return db.batch([
			{method: 'del', params: {query: {from: STATUS}}},
			{method: 'put', params: {objects: [{_kind: STATUS, lastRevNumber, status}]}}
		]);
	}

	// The revision onDBChanged got to, and its status.
	function saveLastRevNumber({lastRevNumber, status}) {
		if (lastRevNumber !== undefined) {
			return db.merge(STATUS_QUERY, {lastRevNumber, status});
		}
		return Promise.resolve({returnValue: true});
	}

	// The app shows, closes and updates the reminders; what it answers does not matter.
	function launchApp(params) {
		later(call('luna://com.webos.service.applicationManager/launch', {id: 'com.palm.app.calendar', params}));
	}

	return {
		reminderTimes, nextWake, nextAutoClose, dbWatch, prepareForTakeoff, setStatusAndRev, saveLastRevNumber,
		launchApp, markFailed, later, nowSeconds,
		REMINDERS, STATUS, EVENTS, STATUS_QUERY, SELF
	};
}

module.exports = {createReminders, nowSeconds};
