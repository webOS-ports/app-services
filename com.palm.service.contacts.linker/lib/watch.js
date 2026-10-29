// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	linkerWatch: the activity that calls dbUpdatedRelinkChanges when a
	contact changes, its trigger a db8 watch for contacts above the _rev the
	linker reached. activities/ creates it at boot from -1; after each
	callback it is completed with restart:true and the new _rev, as
	Autolinker.restartActivityUsingRevisionNumber did. When activitymanager
	will not complete it (it is gone), it is created again, replacing any
	old one of the name, as Autolinker.createActivityUsingRevisionNumber
	did.
*/

// activitymanager under its legacy name: see org.webosports.messaging's service/lib/activity.js.
const AM = 'luna://com.palm.activitymanager';
const CONTACT_KIND = 'com.palm.contact:1';

function watchRevision(rev) {
	return typeof rev === 'number' && isFinite(rev) ? rev : -1;
}

function trigger(rev) {
	return {
		method: 'palm://com.palm.db/watch',
		params: {
			query: {from: CONTACT_KIND, where: [{prop: '_rev', op: '>', val: rev}], incDel: true, limit: 1},
			subscribe: true
		},
		key: 'fired'
	};
}

function callback(rev) {
	return {method: 'palm://com.palm.service.contacts.linker/dbUpdatedRelinkChanges', params: {revChangedStart: rev}};
}

function activitySpec(rev) {
	return {
		activity: {
			type: {persist: true, userInitiated: true, background: true},
			name: 'linkerWatch',
			description: 'This is the watch for kicking off the linker on changes',
			trigger: trigger(rev),
			callback: callback(rev)
		},
		start: true,
		replace: true
	};
}

async function rearm({call, log = console}, rev, $activity) {
	rev = watchRevision(rev);
	const id = $activity && $activity.activityId;
	if (id === undefined) {
		// Called by hand, not by the activity: nothing to rearm.
		return 'none';
	}
	try {
		await call(AM + '/complete', {activityId: id, restart: true, trigger: trigger(rev), callback: callback(rev)});
		return 'completed';
	} catch (e) {
		log.log('linker: completing linkerWatch (' + id + ') failed (' + ((e && e.message) || e) + '), creating it again');
	}
	await call(AM + '/create', activitySpec(rev));
	return 'created';
}

module.exports = {rearm, trigger, callback, activitySpec, watchRevision};
