// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's autolinker.js, autoLinkUnit.js and
// jobIdGenerator.js and the contacts framework's Person.js, Copyright (c)
// 2009-2013 LG Electronics, Inc., licensed under the Apache License, Version
// 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The autolinker: each changed contact either joins the persons it looks
	like (rankers.js), stays with the person it has, or gets a person of its
	own; a deleted contact leaves its person, and a person left with no
	contact goes.

	forceAutolink takes every contact, a page (500) at a time. The watch
	takes one page of those with a _rev above its own, in _rev order, and is
	called back for the rest. A run remembers the highest _rev it reached,
	which the watch is armed with again after the run (watch.js). One run at
	a time; a run whose job is asked to yield stops before its next contact.

	As the old service did: a contact whose handling fails is skipped, except
	the last one of the run, whose failure fails the run (and leaves the
	watch's _rev where it was).
*/

const {syncSourcePriority} = require('./model');
const {meetsThreshold} = require('./rankers');

const CONTACT_KIND = 'com.palm.contact:1';
const JOB_CHARS = 'abcdefghijklmnopqrstuvwxyz';

// JobIdGenerator: "aaa", "aab", ... "zzz", then "aaa" again.
function createJobIds() {
	let first = 0, second = 0, third = 0;
	return function next() {
		if (first >= JOB_CHARS.length) {
			first = 0;
			second += 1;
		}
		if (second >= JOB_CHARS.length) {
			second = 0;
			third += 1;
		}
		if (third >= JOB_CHARS.length) {
			first = 0;
			second = 0;
			third = 0;
		}
		const id = JOB_CHARS[third] + JOB_CHARS[second] + JOB_CHARS[first];
		first += 1;
		return id;
	};
}

/*
	Person.orderContactIds: the merged person's contact ids, by sync source
	priority, keeping each person's own order. The first contact of the person
	that keeps its record stays first, unless a new contact is being merged.
*/
function orderContactIds(person, others, newContact) {
	const arrays = [];
	let primary;
	const own = person.contacts.slice();
	if (newContact) {
		arrays.push([newContact]);
	} else {
		primary = own.shift();
	}
	arrays.push(own);
	for (const o of others) {
		arrays.push(o.contacts.slice());
	}
	const at = arrays.map(() => 0);
	const sorted = [];
	for (;;) {
		let best = -1, bestPriority;
		for (let i = 0; i < arrays.length; i++) {
			if (at[i] < arrays[i].length) {
				const p = syncSourcePriority(arrays[i][at[i]]);
				if (best === -1 || p < bestPriority) {
					best = i;
					bestPriority = p;
				}
			}
		}
		if (best === -1) {
			break;
		}
		sorted.push(arrays[best][at[best]]);
		at[best]++;
	}
	const ids = sorted.map(c => c._id);
	if (primary) {
		ids.unshift(primary._id);
	}
	return ids;
}

function createAutolinker({db, persons, rankers, log = console}) {
	const jobIds = createJobIds();
	const toYield = {};
	let running = false;
	const waiters = [];

	// One run at a time, in the order they came.
	async function exclusive(work) {
		if (running) {
			await new Promise(resolve => waiters.push(resolve));
		} else {
			running = true;
		}
		try {
			return await work();
		} finally {
			const next = waiters.shift();
			if (next) {
				next();
			} else {
				running = false;
			}
		}
	}

	// Autolinker.getContactsPerson: the person holding the contact, with its contacts.
	async function personOf(contact) {
		const r = await db.findPage({from: persons.KIND, where: [{prop: 'contactIds', op: '=', val: contact._id}], limit: 1});
		if (!r.results.length) {
			return {person: undefined, contacts: []};
		}
		const person = persons.wrap(r.results[0]);
		const contacts = await persons.reloadContacts(person);
		return {person, contacts: contacts.length ? contacts : []};
	}

	async function removeContactFromPerson(person, contact, listSortOrder) {
		const ids = person.rec.contactIds;
		const at = ids.indexOf(contact._id);
		if (at !== -1) {
			ids.splice(at, 1);
		}
		person.changed = new Set(['contactIds']);
		await persons.fixup(person, {listSortOrder});
		await persons.save(person);
	}

	async function newPersonFor(contact, listSortOrder) {
		const person = persons.wrap();
		person.rec.contactIds.push(contact._id);
		person.contacts = [contact];
		await persons.fixup(person, {contacts: [contact], listSortOrder});
		await persons.save(person);
	}

	async function refresh(person, contacts, listSortOrder) {
		await persons.fixup(person, {contacts, listSortOrder});
		await persons.save(person);
	}

	// Autolinker.autolinkThesePeople: the person with most contacts takes in the others.
	async function link(person, others, contact, listSortOrder) {
		let most = 0, mostAt = 0, personInOthers = false;
		others.forEach((p, i) => {
			if (most <= p.rec.contactIds.length) {
				mostAt = i;
				most = p.rec.contactIds.length;
			}
			if (person && person.rec._id === p.rec._id) {
				personInOthers = true;
			}
		});
		const reload = others.slice();
		let keeper = others[mostAt];
		if (person && !personInOthers) {
			reload.push(person);
			if (person.rec.contactIds.length >= others[mostAt].rec.contactIds.length) {
				keeper = person;
			} else {
				others.splice(mostAt, 1);
				others.push(person);
			}
		} else {
			others.splice(mostAt, 1);
		}
		await Promise.all(reload.map(p => persons.reloadContacts(p)));
		keeper.rec.contactIds = person ? orderContactIds(keeper, others) : orderContactIds(keeper, others, contact);
		keeper.changed = new Set([...(keeper.changed || []), 'contactIds']);
		if (others.length) {
			await db.del(others.map(p => p.rec._id));
		}
		// The keeper's contacts are those just loaded, when they hold all of its new ids.
		const loaded = new Map();
		for (const p of reload) {
			for (const c of p.contacts) {
				loaded.set(c._id, c);
			}
		}
		const ids = keeper.rec.contactIds;
		if (ids.every(id => loaded.has(id))) {
			keeper.contacts = ids.map(id => loaded.get(id));
			await persons.fixup(keeper, {others, listSortOrder, contacts: keeper.contacts});
		} else {
			await persons.fixup(keeper, {others, listSortOrder});
		}
		await persons.save(keeper);
	}

	// Autolinker.doAutoLinkProcess.
	async function autolink(person, contacts, contact, listSortOrder) {
		const weights = await rankers.rank(person, contact);
		const others = [];
		for (const key of Object.keys(weights)) {
			const w = weights[key];
			if (meetsThreshold(w) && (!person || w.person.rec._id !== person.rec._id)) {
				others.push(w.person);
			}
		}
		if (others.length) {
			return link(person, others, contact, listSortOrder);
		}
		if (person) {
			return refresh(person, contacts, listSortOrder);
		}
		return newPersonFor(contact, listSortOrder);
	}

	/*
		Of the deleted contacts of a page, those some person still holds (one
		find), or null to look each one up. A deleted contact no person holds
		has nothing to be done; only a merge moves a contact to another person,
		and it moves it from one that held it.
	*/
	async function deletedHeld(contacts) {
		const ids = contacts.filter(c => c._del).map(c => c._id);
		if (ids.length < 2) {
			return null;
		}
		try {
			const held = new Set();
			for (const p of await db.find({from: persons.KIND, where: [{prop: 'contactIds', op: '=', val: ids}], select: ['contactIds']})) {
				for (const id of p.contactIds || []) {
					held.add(id);
				}
			}
			return held;
		} catch (e) {
			return null;
		}
	}

	// Autolinker.getTheNextContactAndProcess.
	async function processContact(contact, state, listSortOrder, held) {
		if (state.highestRev < contact._rev) {
			state.highestRev = contact._rev;
		}
		if (contact._del && held && !held.has(contact._id)) {
			state.processed += 1;
			return;
		}
		const {person, contacts} = await personOf(contact);
		state.processed += 1;
		if (contact._del) {
			if (!person) {
				return;
			}
			if (person.rec.contactIds.length > 1) {
				return removeContactFromPerson(person, contact, listSortOrder);
			}
			return persons.del(person);
		}
		return autolink(person, contacts, contact, listSortOrder);
	}

	// Autolinker.completedOrYieldingAutolinker.
	function finish(state, controller, lastContact) {
		if (lastContact && state.highestRev < lastContact._rev) {
			state.highestRev = lastContact._rev;
		}
		const rev = state.highestRev;
		if ((rev || rev === 0) && rev > controller.lastProcessedContactRevId) {
			controller.lastProcessedContactRevId = rev;
		}
	}

	/*
		Autolinker.performAutolink: startRev undefined links every contact,
		else those above it. controller.lastProcessedContactRevId ends up at
		the highest _rev handled.
	*/
	async function run(startRev, controller, jobId) {
		const listSortOrder = await persons.listSortOrder();
		const query = {from: CONTACT_KIND, incDel: true};
		query.where = startRev ? [{prop: '_rev', op: '>', val: startRev}] : undefined;
		const state = {highestRev: startRev, processed: 0, yielding: false};
		let failure = null, page = await db.findPage(query), previous;
		for (;;) {
			const contacts = page.results;
			const held = await deletedHeld(contacts);
			for (let i = 0; i < contacts.length && !state.yielding; i++) {
				// What failed before is dropped once the next contact comes up.
				failure = null;
				if (toYield[jobId]) {
					finish(state, controller, i - 1 >= 0 ? contacts[i - 1] : previous);
					state.yielding = true;
					break;
				}
				try {
					await processContact(contacts[i], state, listSortOrder, held);
				} catch (e) {
					log.error('linker: contact ' + contacts[i]._id + ' failed: ' + ((e && e.stack) || e));
					failure = e;
				}
			}
			// The watch is called back for what is left; forceAutolink goes on to the next page.
			if (state.yielding || startRev || !page.next || !contacts.length) {
				break;
			}
			previous = contacts[contacts.length - 1];
			page = await db.findPage(Object.assign({}, query, {page: page.next}));
		}
		if (failure) {
			throw failure;
		}
		if (!state.yielding) {
			finish(state, controller);
		}
		return true;
	}

	return {
		newJobId: () => jobIds(),
		yieldJob: jobId => {
			toYield[jobId] = true;
		},
		forceAutolink: (controller, jobId) => exclusive(() => run(undefined, controller, jobId)),
		relinkChanges: (controller, jobId, revChangedStart) => exclusive(() => run(revChangedStart || -1, controller, jobId))
	};
}

module.exports = {createAutolinker, orderContactIds, createJobIds};
