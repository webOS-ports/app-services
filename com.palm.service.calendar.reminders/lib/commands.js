// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0
//
// From the old service's on-*-handler.js, Copyright (c) 2010-2013 LG Electronics, Inc.,
// Apache License 2.0.

'use strict';

/*
	The service's bus methods, answering as the mojoservice service did
	(mojo.js), errors and all. All of them are called by activitymanager
	(onInit at boot, onWake, onAutoClose and onDBChanged by the activities
	this service makes) or by the calendar app (onSnooze, onDismiss), and
	answer {returnValue: true, ...} with what the old service answered:

	onInit       {unittest?}: with a watch on record, does onDBChanged's work
	             (calls it, answers {startedOver: false} at once); else scans
	             every event -> {wakeStatus, autoCloseStatus, dbChangedStatus}
	onDBChanged  {unittest?}: the events changed since the last revision seen
	             -> {wakeStatus, autoCloseStatus, dbChangedStatus}
	onWake       {showTime}: the app shows the reminders due -> {}
	onAutoClose  {autoCloseTime}: the app closes them; their events' next
	             reminders are worked out -> {status}
	onSnooze     {reminderId, snoozeDuration?}: shown again after the
	             duration (5 minutes) -> {status}
	onDismiss    {reminderId, eventId, startTime}: the event's next
	             reminder after this occurrence -> {status}

	A missing argument is a thrown string, as it was: errorCode -9999.
*/

const mojo = require('./mojo');

const SERVICE = 'com.palm.service.calendar.reminders';
const APP = 'com.palm.app.calendar';
const NAMES = ['onInit', 'onWake', 'onDBChanged', 'onSnooze', 'onDismiss', 'onAutoClose'];
// mojoservice completed the activity of these when they were done; the others did that themselves.
const COMPLETES = {onInit: true, onSnooze: true, onDismiss: true};

function createCommands({db, call, rem, log = console}) {
	const {REMINDERS, EVENTS, STATUS_QUERY} = rem;

	// ---- onInit ---------------------------------------------------------------------------------

	async function onInit(args) {
		const unittest = !!(args && args.unittest);
		const takeoff = await rem.prepareForTakeoff(await db.find(STATUS_QUERY));
		if (takeoff && takeoff.dbChangedActivityId) {
			log.log('rmdrsvc: onInit: status intact, doing onDBChanged instead');
			rem.later(call('luna://' + SERVICE + '/onDBChanged', {unittest}));
			return {returnValue: true, startedOver: false};
		}
		return fullInit(unittest);
	}

	async function fullInit(unittest) {
		let lastRevNumber = 0;
		let scan;
		try {
			const result = await db.find({from: EVENTS, orderBy: '_rev'});
			const events = result && result.results;
			const eventsLength = events && events.length;
			lastRevNumber = eventsLength ? events[eventsLength - 1]._rev : 0;
			scan = {returnValue: result.returnValue, results: events, lastRevNumber};
		} catch (e) {
			log.error('rmdrsvc: onInit: event query failed: ' + ((e && e.message) || e));
			return rem.hang();
		}
		const times = await rem.reminderTimes(scan);
		let saved;
		try {
			await rem.setStatusAndRev(times);
			saved = {returnValue: true};
		} catch (e) {
			log.error('rmdrsvc: onInit: could not save the revision, marking the status FAIL');
			saved = await db.merge(STATUS_QUERY, {status: 'FAIL'});
		}
		const wake = await rem.nextWake(saved);
		let returnValue = wake.returnValue;
		const autoClose = await rem.nextAutoClose();
		returnValue = returnValue && autoClose.returnValue;
		const watch = await rem.dbWatch({dbChangedActivityId: 0, lastRevNumber, isUnitTest: unittest});
		returnValue = returnValue && watch.returnValue;
		const finalStatus = {returnValue, wakeStatus: wake.status, autoCloseStatus: autoClose.status,
			dbChangedStatus: watch.status};
		log.log('rmdrsvc: INIT COMPLETE: ' + JSON.stringify(finalStatus));
		return finalStatus;
	}

	// ---- onDBChanged ----------------------------------------------------------------------------

	function changedEventsQueries(lastRevNumber) {
		const rev = {prop: '_rev', op: '>', val: lastRevNumber};
		return [
			{method: 'find', params: {query: {from: EVENTS, where: [{prop: '_del', op: '=', val: true}, rev], orderBy: '_rev'}}},
			{method: 'find', params: {query: {from: EVENTS, where: [rev], orderBy: '_rev'}}}
		];
	}

	/*
		The batch's two answers: the deleted events and the changed ones since
		lastRevNumber. -> the ids of all of them, of those still there with an
		alarm (to schedule again), of the deleted ones, and the revision got
		to: the higher of the two lists' last ones, or lastRevNumber + 1 when
		both are empty.
	*/
	function processDBChanges(result) {
		let lastRevNumber = result.lastRevNumber;
		const none = () => ({returnValue: true, eventIds: [], newOrChangedEventIds: [], deletedEventIds: [],
			lastRevNumber: lastRevNumber + 1});
		if (result.returnValue === false) {
			return none();
		}
		const delEvents = result.responses && result.responses[0] && result.responses[0].results;
		const delEventsLength = delEvents && delEvents.length;
		const events = result.responses && result.responses[1] && result.responses[1].results;
		const eventsLength = events && events.length;
		if (!delEventsLength && !eventsLength) {
			log.log('rmdrsvc: onDBChanged: no changed events');
			return none();
		}
		let delEventRev = '';
		let eventRev = '';
		if (delEventsLength > 0) {
			delEventRev = delEvents[delEventsLength - 1]._rev;
		}
		if (eventsLength) {
			eventRev = events[eventsLength - 1]._rev;
		}
		lastRevNumber = (delEventRev > eventRev ? delEventRev : eventRev);
		const eventIds = [];
		const newOrChangedEventIds = [];
		const deletedEventIds = [];
		for (let i = 0; i < delEventsLength; i++) {
			eventIds.push(delEvents[i]._id);
			deletedEventIds.push(delEvents[i]._id);
		}
		for (let i = 0; i < eventsLength; i++) {
			const event = events[i];
			eventIds.push(event._id);
			if (event._del !== true && event.alarm && event.alarm.length > 0 && event.alarm[0].alarmTrigger) {
				newOrChangedEventIds.push(event._id);
			}
		}
		return {returnValue: true, eventIds, newOrChangedEventIds, deletedEventIds, lastRevNumber};
	}

	function removeRemindersByEventId(eventIds) {
		const operations = eventIds.map(id => ({method: 'del',
			params: {query: {from: REMINDERS, where: [{prop: 'eventId', op: '=', val: id}]}}}));
		return operations.length ? db.batch(operations) : Promise.resolve({returnValue: true});
	}

	function remindersByEventId(eventIds) {
		const operations = (eventIds || []).map(id => ({method: 'find',
			params: {query: {from: REMINDERS, where: [{prop: 'eventId', op: '=', val: id}]}}}));
		return operations.length ? db.batch(operations) : Promise.resolve({returnValue: true});
	}

	// Times as strings, which the app takes them as (the old service sent them so, for 32-bit ints on the bus).
	function asStrings(reminder) {
		reminder.startTime = reminder.startTime.toString();
		reminder.endTime = reminder.endTime.toString();
		reminder.showTime = reminder.showTime.toString();
		reminder.autoCloseTime = reminder.autoCloseTime.toString();
		return reminder;
	}

	/*
		Tell the app about the changed events' reminders: one that should be
		showing now is sent for it to replace what it shows; an event with no
		reminder now, or one that should not be showing, is to be closed.
	*/
	function updateLiveReminders(result) {
		const eventIds = result.newOrChangedEventIds;
		if (result.returnValue === false) {
			return;
		}
		const responses = result.responses;
		if (!responses || responses.length === 0) {
			return;
		}
		const remindersToUpdate = [];
		const eventIdsToClose = [];
		const now = rem.nowSeconds();
		for (let i = 0; i < responses.length; i++) {
			const response = responses[i];
			if (response && response.returnValue === true && response.results) {
				const responseResults = response.results;
				if (responseResults.length === 0) {
					eventIdsToClose.push(eventIds[i]);
					continue;
				}
				for (let j = 0; j < responseResults.length; j++) {
					const reminder = responseResults[j];
					if (now >= reminder.alarmTime && now <= reminder.autoCloseTime) {
						remindersToUpdate.push(asStrings(reminder));
					} else {
						eventIdsToClose.push(eventIds[i]);
					}
				}
			}
		}
		if (remindersToUpdate.length > 0 || eventIdsToClose.length > 0) {
			rem.launchApp({alarmUpdated: {update: remindersToUpdate, close: eventIdsToClose}});
		}
	}

	async function onDBChanged(args) {
		if (args.unittest) {
			return {returnValue: true};
		}
		let status = 'OK';
		// The old chain's first error handler is the one after the removal: a failure anywhere before it
		// (the status, a start over, the change queries, the app told of deletions) lands there.
		let lastRevNumber = 0, dbChangedActivityId = 0, eventIds, newOrChangedEventIds;
		try {
			const takeoff = await rem.prepareForTakeoff(await db.find(STATUS_QUERY));
			lastRevNumber = takeoff.lastRevNumber;
			dbChangedActivityId = takeoff.dbChangedActivityId;
			const changed = await db.batch(changedEventsQueries(lastRevNumber));
			const p = processDBChanges({returnValue: changed.returnValue, responses: changed.responses, lastRevNumber});
			eventIds = p.eventIds;
			newOrChangedEventIds = p.newOrChangedEventIds;
			const deletedEventIds = p.deletedEventIds;
			lastRevNumber = p.lastRevNumber;
			log.log('rmdrsvc: deleted events: ' + JSON.stringify(deletedEventIds) + ', new or changed: ' +
				JSON.stringify(newOrChangedEventIds));
			if (deletedEventIds && deletedEventIds.length > 0) {
				rem.launchApp({alarmDeleted: deletedEventIds});
			}
			// Everything that changed leaves the reminders kind; the events still there are worked out again.
			await removeRemindersByEventId(eventIds);
		} catch (e) {
			status = 'FAIL';
			log.error('rmdrsvc: onDBChanged: ' + ((e && e.message) || e) + '; reminders of ' + JSON.stringify(eventIds) +
				' may not have been deleted');
			rem.markFailed();
		}
		try {
			const got = newOrChangedEventIds && newOrChangedEventIds.length ? await db.get(newOrChangedEventIds) :
				{returnValue: true};
			const times = await rem.reminderTimes({returnValue: got.returnValue, results: got.results, lastRevNumber});
			await rem.saveLastRevNumber({lastRevNumber: times.lastRevNumber || lastRevNumber, status});
		} catch (e) {
			log.error('rmdrsvc: onDBChanged: could not save the revision: ' + ((e && e.message) || e));
			rem.markFailed();
		}
		const live = await remindersByEventId(newOrChangedEventIds);
		updateLiveReminders({returnValue: live.returnValue, responses: live.responses, newOrChangedEventIds});
		const wake = await rem.nextWake({returnValue: true});
		const autoClose = await rem.nextAutoClose();
		const watch = await rem.dbWatch({dbChangedActivityId, lastRevNumber, isUnitTest: false});
		return {returnValue: true, wakeStatus: wake.status, autoCloseStatus: autoClose.status, dbChangedStatus: watch.status};
	}

	// ---- onWake ---------------------------------------------------------------------------------

	async function onWake(args) {
		const showTime = args.showTime;
		if (showTime === undefined) {
			throw 'Missing args! Need showTime.  Received: ' + JSON.stringify(args); // jshint ignore:line
		}
		const found = await db.find({from: REMINDERS, where: [{prop: 'showTime', op: '=', val: args.showTime}]});
		let reminders = found.results;
		if (found.returnValue === false || (reminders && reminders.length === 0)) {
			reminders = [];
		}
		// One second on, so the search does not find what just woke the service.
		const wake = await rem.nextWake({startSearchTime: showTime + 1000});
		if (wake.pastReminders && wake.pastReminders.length) {
			reminders = reminders.concat(wake.pastReminders);
		}
		// The same reminder twice (event and start) is sent once: the old service's NOV-102491 guard.
		const seen = {};
		const remindersToShow = [];
		for (const reminder of reminders) {
			const key = '' + reminder.eventId + reminder.startTime;
			if (seen[key] !== undefined) {
				log.error('rmdrsvc: duplicate reminder ' + reminder._id);
				continue;
			}
			seen[key] = true;
			remindersToShow.push(asStrings(reminder));
		}
		log.log('rmdrsvc: sending ' + remindersToShow.length + ' reminders to the app');
		if (remindersToShow.length > 0) {
			rem.launchApp({alarm: remindersToShow});
		}
		return {returnValue: true};
	}

	// ---- onAutoClose ----------------------------------------------------------------------------

	async function onAutoClose(args) {
		const autoCloseTime = args.autoCloseTime;
		if (!autoCloseTime) {
			throw 'Missing args! Need autoCloseTime.  Received: ' + JSON.stringify(args); // jshint ignore:line
		}
		let eventIds;
		try {
			const found = await db.find({from: REMINDERS, where: [{prop: 'autoCloseTime', op: '=', val: autoCloseTime}]});
			const reminderIds = [];
			const ids = [];
			const reminders = found.results;
			if (reminders && reminders.length) {
				for (const reminder of reminders) {
					ids.push(reminder.eventId);
					reminderIds.push(reminder._id);
				}
				if (reminderIds.length > 0) {
					rem.launchApp({alarmClose: reminderIds});
				}
			}
			eventIds = ids;
			if (reminderIds.length > 0) {
				await db.del(reminderIds);
			}
		} catch (e) {
			log.error('rmdrsvc: onAutoClose: reminders were not deleted: ' + ((e && e.message) || e));
			rem.markFailed();
		}
		const got = eventIds && eventIds.length ? await db.get(eventIds) : {returnValue: true};
		await rem.nextWake(await rem.reminderTimes(got));
		return rem.nextAutoClose();
	}

	// ---- onSnooze -------------------------------------------------------------------------------

	async function onSnooze(args) {
		const reminderId = args.reminderId;
		if (!reminderId) {
			throw 'Missing args! Need reminderId.  Received: ' + JSON.stringify(args); // jshint ignore:line
		}
		const snoozeDuration = args.snoozeDuration || 300000;
		const snoozeUntil = rem.nowSeconds() + snoozeDuration;
		try {
			const found = await db.find({from: REMINDERS, where: [{prop: '_id', op: '=', val: reminderId}]});
			if (found.returnValue && found.results && found.results.length) {
				await db.merge([{_id: reminderId, showTime: snoozeUntil}]);
			} else {
				log.log('rmdrsvc: snoozed a reminder that is not there: ' + reminderId);
			}
		} catch (e) {
			log.error('rmdrsvc: onSnooze: could not snooze ' + reminderId);
			rem.markFailed();
		}
		await rem.nextWake({returnValue: true});
		return rem.nextAutoClose();
	}

	// ---- onDismiss ------------------------------------------------------------------------------

	/*
		The reminder goes; the event's next one is worked out from just after
		the start of the occurrence dismissed, so a reminder dismissed before
		its event started does not come back at the start.
	*/
	async function onDismiss(args) {
		const {reminderId, eventId, startTime} = args;
		if (reminderId === undefined || eventId === undefined || startTime === undefined) {
			throw 'Missing args! Need reminderId, eventId, and startTime.  Received: ' + // jshint ignore:line
				JSON.stringify(args);
		}
		try {
			await db.del([reminderId]);
		} catch (e) {
			log.error('rmdrsvc: onDismiss: reminder ' + JSON.stringify(reminderId) + ' was not deleted');
			rem.markFailed();
		}
		const got = await db.get([eventId]);
		const times = await rem.reminderTimes({returnValue: got.returnValue, results: got.results, eventDismissed: true,
			skipPastStartTime: startTime});
		await rem.nextWake(times);
		return rem.nextAutoClose();
	}

	const commands = {onInit, onWake, onDBChanged, onSnooze, onDismiss, onAutoClose};
	const methods = {};
	for (const name of NAMES) {
		methods[name] = mojo.method(SERVICE, name, commands[name], {log, subscribe: call.subscribe,
			complete: !!COMPLETES[name], call});
	}
	return methods;
}

module.exports = {createCommands, SERVICE, NAMES, APP};
