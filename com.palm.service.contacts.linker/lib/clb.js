// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's contactLinkBackup.js, Copyright (c) 2009-2013
// LG Electronics, Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	ContactLinkBackup: the user's manual links and unlinks, kept by link hash
	(see linkhash.js) so they outlive a restore.

	com.palm.manualLink:1    {contactEntityA, contactEntityB}: linked by hand
	com.palm.manualUnlink:1  {contactEntityA, contactEntityB}: kept apart by hand

	The autolinker reads them to make a person win or lose against a contact
	(rankers.js); manualLink and manualUnlink write them.
*/

const LINK_KIND = 'com.palm.manualLink:1';
const UNLINK_KIND = 'com.palm.manualUnlink:1';
// Link hashes whose manual unlinks one batch looks up (two finds each).
const UNLINK_HASHES = 100;

function record(kind, a, b) {
	return {_kind: kind, contactEntityA: a, contactEntityB: b};
}

function pairQuery(kind, a, b) {
	return {from: kind, where: [{prop: 'contactEntityA', op: '=', val: a}, {prop: 'contactEntityB', op: '=', val: b}]};
}

function createClb({db, linkHash}) {
	function inList(a, b, list) {
		return list.some(r => r.contactEntityA === a && r.contactEntityB === b);
	}

	/*
		After person 2's contacts were linked by hand into person 1: a manual
		link for every pair, the unlinks between the two groups gone, and
		whatever either group was unlinked from now unlinked from all of it.
	*/
	async function performedManualLink(p1Ids, p2Ids) {
		if (!p1Ids || !p2Ids) {
			throw new Error('The person1ContactIds or person2ContactIds is undefined.');
		}
		const longer = p1Ids.length > p2Ids.length ? p1Ids.slice() : p2Ids.slice();
		const shorter = p1Ids.length > p2Ids.length ? p2Ids.slice() : p1Ids.slice();
		const results = await db.get(longer.concat(shorter));
		if (!results.length) {
			throw new Error('Did not get the contacts to create the backups');
		}
		const p1 = [], p2 = [];
		for (const c of results) {
			(p1Ids.some(id => c._id === id) ? p1 : p2).push(c);
		}
		const hashes = {};
		const hashOf = async c => {
			if (!hashes[c._id]) {
				hashes[c._id] = (await linkHash.linkHash(c)).linkHash;
			}
			return hashes[c._id];
		};
		const links = [], pairs = [], allHashes = [];
		let filledP2 = false;
		for (const a of p1) {
			const ha = await hashOf(a);
			allHashes.push(ha);
			for (const b of p2) {
				const hb = await hashOf(b);
				links.push(record(LINK_KIND, ha, hb));
				pairs.push(record(UNLINK_KIND, ha, hb), record(UNLINK_KIND, hb, ha));
				if (!filledP2) {
					allHashes.push(hb);
				}
			}
			filledP2 = true;
		}
		await db.put(links);

		const found = await Promise.all(pairs.map(p => db.findPage(pairQuery(p._kind, p.contactEntityA, p.contactEntityB))));
		const stale = [].concat(...found.map(r => r.results)).map(r => r._id);
		if (stale.length) {
			await db.del(stale);
		}

		const byA = [].concat(...(await Promise.all(allHashes.map(h => db.findPage({from: UNLINK_KIND,
			where: [{prop: 'contactEntityA', op: '=', val: h}]})))).map(r => r.results));
		const byB = [].concat(...(await Promise.all(allHashes.map(h => db.findPage({from: UNLINK_KIND,
			where: [{prop: 'contactEntityB', op: '=', val: h}]})))).map(r => r.results));
		const add = [];
		for (const u of byA) {
			for (const h of allHashes) {
				if (!inList(h, u.contactEntityB, byA) && !inList(h, u.contactEntityB, add) && h && u.contactEntityB) {
					add.push(record(UNLINK_KIND, h, u.contactEntityB));
				}
			}
		}
		for (const u of byB) {
			for (const h of allHashes) {
				if (!inList(u.contactEntityA, h, byB) && !inList(u.contactEntityA, h, add) && u.contactEntityA && h) {
					add.push(record(UNLINK_KIND, u.contactEntityA, h));
				}
			}
		}
		await db.put(add);
		return true;
	}

	/*
		After contactId was taken out of a person by hand (person: the person as
		it is now): an unlink from each contact left to it, and their manual
		links in either direction gone.
	*/
	async function performedUnlink(person, contactId) {
		if (!person || !contactId) {
			throw new Error('The personOrPersonId or contactOrContactId is undefined.');
		}
		const results = await db.get(person.contactIds.concat([contactId]));
		let unlinked;
		for (let i = results.length - 1; i >= 0; i--) {
			if (results[i]._id === contactId) {
				unlinked = results.splice(i, 1)[0];
				break;
			}
		}
		if (!unlinked) {
			throw new Error('The contact that was unlinked could not be found for clb');
		}
		const hu = (await linkHash.linkHash(unlinked)).linkHash;
		const unlinks = [], remove = [];
		await Promise.all(results.map(async c => {
			const hc = (await linkHash.linkHash(c)).linkHash;
			unlinks.push(record(UNLINK_KIND, hc, hu));
			remove.push(record(LINK_KIND, hc, hu), record(LINK_KIND, hu, hc));
		}));
		await db.put(unlinks);
		const found = await Promise.all(remove.map(r => db.findPage(pairQuery(r._kind, r.contactEntityA, r.contactEntityB))));
		const ids = [].concat(...found.map(r => r.results)).map(r => r._id);
		if (ids.length) {
			await db.del(ids);
		}
		return {msg: 'Done in clb'};
	}

	// The records of a kind that name this contact: those with it as A, then those with it as B (one batch).
	async function linksOf(kind, contact) {
		const hash = (await linkHash.linkHash(contact)).linkHash;
		const [a, b] = await db.batch(['contactEntityA', 'contactEntityB'].map(prop => ({method: 'find',
			params: {query: {from: kind, where: [{prop, op: '=', val: hash}]}}})));
		return {results: ((a && a.results) || []).concat((b && b.results) || [])};
	}

	/*
		The manual unlinks naming each of these link hashes (strings), as
		linksOf gives them: hash -> {results}, or {error} when the batch with
		its finds failed. The finds go in batches of UNLINK_HASHES hashes at
		a time, all at once, to keep each message small.
	*/
	async function unlinksByHash(hashes) {
		const out = new Map();
		const chunks = [];
		for (let i = 0; i < hashes.length; i += UNLINK_HASHES) {
			chunks.push(hashes.slice(i, i + UNLINK_HASHES));
		}
		await Promise.all(chunks.map(async chunk => {
			try {
				const responses = await db.batch([].concat(...chunk.map(val => ['contactEntityA', 'contactEntityB'].map(prop =>
					({method: 'find', params: {query: {from: UNLINK_KIND, where: [{prop, op: '=', val}]}}})))));
				chunk.forEach((h, i) => {
					const a = responses[2 * i], b = responses[2 * i + 1];
					out.set(h, {results: ((a && a.results) || []).concat((b && b.results) || [])});
				});
			} catch (e) {
				for (const h of chunk) {
					out.set(h, {error: e});
				}
			}
		}));
		return out;
	}

	// Not Errors: the old code failed with these objects, and the reply says so.
	async function resetDB() {
		const links = await db.delQuery({from: LINK_KIND});
		if (typeof links !== 'number') {
			throw {error: 'DB not cleared of manualLinks'}; // eslint-disable-line no-throw-literal
		}
		const unlinks = await db.delQuery({from: UNLINK_KIND});
		if (typeof unlinks !== 'number') {
			throw {error: 'DB not cleared of manualUnlinks'}; // eslint-disable-line no-throw-literal
		}
		return {msg: 'DB cleared of ' + links + ' manualLinks and ' + unlinks + ' manualUnlinks'};
	}

	return {
		performedManualLink, performedUnlink, resetDB,
		getManualLinks: contact => linksOf(LINK_KIND, contact),
		getUnlinkLinks: contact => linksOf(UNLINK_KIND, contact),
		unlinksByHash
	};
}

module.exports = {createClb, LINK_KIND, UNLINK_KIND};
