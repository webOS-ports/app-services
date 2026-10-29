// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

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

	Broken in the old service and broken the same way here, until the
	commits that mend them: setupWatch (calls a function that is not
	there), performedUnlink (wants the framework's person object), and
	getManualLinks / getUnlinkLinks (an id never answers until the command
	times out; a contact object wants the framework's contact).

	The plugin hook (/etc/palm/contact_linker_plugins) is gone: no plugin
	was ever installed on LuneOS.
*/

const mojo = require('./mojo');
const {rearm, watchRevision} = require('./watch');

const SERVICE = 'com.palm.service.contacts.linker';
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

	// ContactLinkBackup.getManualLinks / getUnlinkLinks, from the bus.
	function clbLookup() {
		return params => {
			if (!params.contactOrContactId) {
				throw new Error('The \'contactOrContactId\' parameter was not specified');
			}
			if (typeof params.contactOrContactId === 'object') {
				throw new TypeError('contact.getLinkHash is not a function');
			}
			// The old code fetched the contact and then never went on: no answer until the timeout.
			return db.get([params.contactOrContactId]).then(() => new Promise(() => {}));
		};
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
		setupWatch: () => {
			throw new TypeError('autolinker.setupWatch is not a function');
		},
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
		performedUnlink: params => {
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
			throw new TypeError('personUnlinkedFrom.copyOfContactIds is not a function');
		},
		getManualLinks: clbLookup(),
		getUnlinkLinks: clbLookup()
	};

	const timeouts = {forceAutolink: LONG_TIMEOUT_S, dbUpdatedRelinkChanges: LONG_TIMEOUT_S};
	const methods = {};
	for (const name of Object.keys(commands)) {
		methods[name] = mojo.method(SERVICE, name, commands[name], {timeoutS: timeouts[name], log, subscribe: call.subscribe});
	}
	return methods;
}

module.exports = {createCommands, SERVICE, NAMES, LONG_TIMEOUT_S};
