// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's linker.js, autolinker.js and
// contactLinkBackup.js, Copyright (c) 2009-2013 LG Electronics, Inc., licensed
// under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The linker's bus methods, answering as the mojoservice linker answered
	(mojo.js), errors and all:

	manualLink               {personToLinkTo, personToLink} -> true
	manualUnlink             {personToRemoveLinkFrom, contactToRemoveFromPerson}
	saveNewPersonAndContacts {person, contacts} (savenew.js)
	forceAutolink            link every contact -> true
	dbUpdatedRelinkChanges   {revChangedStart}: the watch's callback -> true
	yieldAutolink            {jobId}
	deleteOrphanedPerson     {personId}: answers at once, then deletes the
	                         person if it has no contacts
	resetCLBDB, performedManualLink {person1Contacts, person2Contacts}

	setupWatch               creates linkerWatch again, from the revision in
	                         com.palm.linker.rev:1 (0 when there is none)
	performedUnlink          {person, contactId}: the clb records for a
	                         contact taken out of person by hand
	getManualLinks, getUnlinkLinks {contactOrContactId} -> {results}

	The old service never answered those four: setupWatch called a function
	that had been renamed (README: Q7.4), performedUnlink wanted the
	framework's person object (Q7.8), and getManualLinks / getUnlinkLinks
	with an id never answered until the command timed out, and with a
	contact object wanted the framework's contact (Q7.9).

	The plugin hook (/etc/palm/contact_linker_plugins) is gone: no plugin
	was ever installed on LuneOS.
*/

const mojo = require('./mojo');
const {rearm, watchRevision, activitySpec} = require('./watch');

const SERVICE = 'com.palm.service.contacts.linker';
const REV_KIND = 'com.palm.linker.rev:1';
const AM = 'luna://com.palm.activitymanager';
const LONG_TIMEOUT_S = 3600;
const NAMES = ['manualLink', 'manualUnlink', 'saveNewPersonAndContacts', 'forceAutolink', 'dbUpdatedRelinkChanges',
	'yieldAutolink', 'setupWatch', 'deleteOrphanedPerson', 'resetCLBDB', 'performedManualLink', 'performedUnlink',
	'getManualLinks', 'getUnlinkLinks'];

function createCommands({db, call, persons, autolinker, clb, saveNew, log = console}) {
	async function manualLink(params) {
		let msg = '';
		if (!params.personToLinkTo) {
			msg = 'The \'personToLinkTo\' parameter was not specified. ';
		}
		if (!params.personToLink) {
			msg += 'The \'personToLink\' parameter was not specified.';
		}
		if (msg.length) {
			throw new Error(msg);
		}
		const toId = params.personToLinkTo, otherId = params.personToLink;
		const results = await db.get([toId, otherId]);
		if (!results.length) {
			throw new Error('Neither of the people you want to link exist in the db');
		}
		let to, other;
		for (const raw of results) {
			const p = persons.wrap(raw);
			if (raw._del) {
				throw new Error('Can not link with a person that is marked for deletion');
			}
			if (raw._id === toId) {
				to = p;
			} else if (raw._id === otherId) {
				other = p;
			}
		}
		if (!to || !other) {
			throw new Error('Trying to fetch one of the people objects failed. One of them probably does not exist in the db.');
		}
		const ids1 = to.rec.contactIds.slice(), ids2 = other.rec.contactIds.slice();
		to.rec.contactIds = to.rec.contactIds.concat(other.rec.contactIds);
		to.changed = new Set(['contactIds']);
		await persons.fixup(to, {others: [other]});
		await persons.save(to);
		const deleted = await db.del([other.rec._id]);
		if (!deleted.length) {
			throw new Error('Deleting of personToLink failed');
		}
		await clb.performedManualLink(ids1, ids2);
		return true;
	}

	async function manualUnlink(params) {
		let msg = '';
		if (!params.personToRemoveLinkFrom) {
			msg = 'The \'personToRemoveLinkFrom\' parameter was not specified. ';
		}
		if (!params.contactToRemoveFromPerson) {
			msg += 'The \'contactToRemoveFromPerson\' parameter was not specified.';
		}
		if (msg.length) {
			throw new Error(msg);
		}
		const contactId = params.contactToRemoveFromPerson;
		const results = await db.get([params.personToRemoveLinkFrom]);
		if (!results.length) {
			throw new Error('The person to remove the link from does not exist in the db.');
		}
		const person = persons.wrap(results[0]);
		if (results[0]._del) {
			throw new Error('Can not remove the link from a person that is marked for deletion');
		}
		const at = person.rec.contactIds.indexOf(contactId);
		if (at === -1) {
			throw new Error('The contact you are trying to unlink does not belong to the person you specified');
		}
		person.rec.contactIds.splice(at, 1);
		person.changed = new Set(['contactIds']);
		await persons.fixup(person);
		await persons.save(person);
		const alone = persons.wrap();
		alone.rec.contactIds.push(contactId);
		await persons.fixup(alone);
		await persons.save(alone);
		return clb.performedUnlink({contactIds: person.rec.contactIds}, contactId);
	}

	// dbUpdatedRelinkChanges: the watch fired. Rearmed from the highest _rev reached, run or fail.
	async function relink(params) {
		const jobId = autolinker.newJobId();
		const controller = {lastProcessedContactRevId: watchRevision(params.revChangedStart)};
		try {
			return await autolinker.relinkChanges(controller, jobId, params.revChangedStart);
		} finally {
			try {
				await rearm({call, log}, controller.lastProcessedContactRevId, params.$activity);
			} catch (e) {
				log.error('linker: rearming linkerWatch failed: ' + ((e && e.message) || e));
			}
		}
	}

	// ContactLinkBackup.getManualLinks / getUnlinkLinks, from the bus: a contact, or its _id.
	function clbLookup(which) {
		return async params => {
			if (!params.contactOrContactId) {
				throw new Error('The \'contactOrContactId\' parameter was not specified');
			}
			let contact = params.contactOrContactId;
			if (typeof contact !== 'object') {
				contact = (await db.get([String(contact)]))[0];
			}
			// An object that is no contact (it has no _kind) is answered as an id that finds none.
			if (!contact || !contact._kind) {
				throw new Error('ContactLinkBackup.' + which + ': failed to get the contact to get links from');
			}
			return clb[which](contact);
		};
	}

	// Autolinker.suckyHackySetupWatch: linkerWatch made again, from the revision kept in db8.
	async function setupWatch() {
		const r = await db.findPage({from: REV_KIND, orderBy: 'revisionNumber', desc: true, limit: 1});
		const rev = watchRevision(r.results[0] && r.results[0].revisionNumber);
		await call(AM + '/create', activitySpec(rev < 0 ? 0 : rev));
		return true;
	}

	function deleteOrphanedPerson(params) {
		if (params && params.personId) {
			(async () => {
				if (typeof params.personId !== 'string') {
					return;
				}
				const r = await db.get([params.personId]);
				if (!r[0] || r[0]._kind !== persons.KIND) {
					return;
				}
				const person = persons.wrap(r[0]);
				const contacts = await persons.reloadContacts(person);
				if (contacts.length === 0) {
					await persons.del(person);
				}
			})().catch(e => log.error('LinkerAssistant.deletePerson encounterend an error: ' + ((e && e.message) || e)));
		}
		return false;
	}

	const commands = {
		manualLink,
		manualUnlink,
		saveNewPersonAndContacts: params => saveNew(params),
		forceAutolink: () => autolinker.forceAutolink({}, autolinker.newJobId()),
		dbUpdatedRelinkChanges: relink,
		yieldAutolink: params => {
			if (typeof params.jobId !== 'string') {
				throw new Error('You must specify a job id to yield!');
			}
			autolinker.yieldJob(params.jobId);
			return 'Job with id ' + params.jobId + ' is requested to yield';
		},
		setupWatch,
		deleteOrphanedPerson,
		resetCLBDB: () => clb.resetDB(),
		performedManualLink: params => {
			let msg = '';
			if (!params.person1Contacts) {
				msg = 'The \'person1Contacts\' parameter was not specified. ';
			}
			if (!params.person2Contacts) {
				msg = 'The \'person2Contacts\' parameter was not specified.';
			}
			if (msg.length) {
				throw new Error(msg);
			}
			return clb.performedManualLink(params.person1Contacts, params.person2Contacts);
		},
		performedUnlink: async params => {
			let msg = '';
			if (!params.person) {
				msg = 'The \'person\' parameter was not specified. ';
			}
			if (!params.contactId) {
				msg = 'The \'contactId\' parameter was not specified.';
			}
			if (msg.length) {
				throw new Error(msg);
			}
			// The person as an object with its contactIds, or its _id.
			let person = params.person;
			if (typeof person !== 'object') {
				person = (await db.get([String(person)]))[0];
			}
			if (!person || !Array.isArray(person.contactIds)) {
				throw new Error('The personOrPersonId or contactOrContactId is undefined.');
			}
			return clb.performedUnlink({contactIds: person.contactIds}, params.contactId);
		},
		getManualLinks: clbLookup('getManualLinks'),
		getUnlinkLinks: clbLookup('getUnlinkLinks')
	};

	/*
		A linkerWatch callback for the activity and _rev of one that is still
		running is the same callback delivered again (the VM's activitymanager
		did that): it runs nothing. Now that an adopt waits (lib/mojo.js), it
		would otherwise run again from the old _rev once the first lets go.
		The callback serial cannot tell them apart: activitymanager seeds it
		from the time in seconds, so callbacks within one second share it.
	*/
	const running = new Set();
	function claimRelink(params) {
		const key = params.$activity.activityId + ' ' + params.revChangedStart;
		if (running.has(key)) {
			return 'callback for activity ' + params.$activity.activityId + ' from _rev ' +
				params.revChangedStart + ' delivered again while it runs';
		}
		running.add(key);
		return () => running.delete(key);
	}

	const timeouts = {forceAutolink: LONG_TIMEOUT_S, dbUpdatedRelinkChanges: LONG_TIMEOUT_S};
	const claims = {dbUpdatedRelinkChanges: claimRelink};
	const methods = {};
	for (const name of Object.keys(commands)) {
		methods[name] = mojo.method(SERVICE, name, commands[name],
			{timeoutS: timeouts[name], log, subscribe: call.subscribe, claim: claims[name]});
	}
	return methods;
}

module.exports = {createCommands, SERVICE, NAMES, LONG_TIMEOUT_S};
