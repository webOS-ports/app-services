// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's autolinker.js and the contacts framework's
// Contact.js and ContactLinkable.js, Copyright (c) 2009-2013 LG Electronics,
// Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	How much a contact looks like each person in db8 (Autolinker's ranking
	functions): the weights a contact being linked gives the persons it could
	join, keyed by person _id, in the order the persons were first found.

		similar name            +100 for each name query that finds the person
		similar mobile number   +100
		similar email           +100 for each email query that finds it
		similar IM              +100 for each IM query that finds it
		manual link          +99999
		manual unlink        -99999

	A person at 100 or more is linked with the contact.

*/

const {DEFAULTS, entries, contactName, normalizeLower} = require('./model');
const {LOCAL_ID_DELIM} = require('./linkhash');

const MATCH_THRESHOLD = 100;
const SIMILAR = {
	name: {weight: 100, label: 'Similar Name'},
	mobile: {weight: 100, label: 'Similar Mobile Phone Number'},
	email: {weight: 100, label: 'Similar Email'},
	im: {weight: 100, label: 'Similar IM'},
	manualLink: {weight: 99999, label: 'CLB Manual Link'},
	manualUnlink: {weight: -99999, label: 'CLB Manual Unlink'}
};
const MOBILE = 'type_mobile';
const CONTACT_KIND = 'com.palm.contact:1';

function meetsThreshold(unit) {
	return unit.weight >= MATCH_THRESHOLD;
}

/*
	createRankers({db, persons, model, G, clb, linkHash}): rank(person, contact)
	-> weights. person is the contact's own person (or null), contact its
	db8 record.
*/
function createRankers({db, persons, model, G, clb, linkHash}) {
	const KIND = persons.KIND;

	function add(weights, similarity, person, additive) {
		const id = person.rec._id;
		const unit = weights[id] || {person, weight: undefined, similarOn: []};
		unit.weight = unit.weight ? unit.weight + similarity.weight : similarity.weight;
		unit.similarOn.push({label: similarity.label, additive});
		weights[id] = unit;
	}

	function peopleOf(responses) {
		let out = [];
		for (const r of responses) {
			out = out.concat(r.results);
		}
		return out;
	}

	/*
		The persons a batch of finds found, one for each hit, in order. The
		finds ask for the _id alone, and each person is then read and wrapped
		once: a person a ranker finds again is the same object, as only the
		first hit's person is kept (add) and the others are read alone. They
		used to bring the whole person back for every query that found it: a
		person with many contacts and names came back many times over, and on
		the VM a reply of 24 MB was more than luna-service takes (it drops
		the client, and the linker lost db8).
	*/
	async function personsFound(queries) {
		const responses = await db.batch(queries.map(q => ({method: q.method,
			params: {query: Object.assign({}, q.params.query, {select: ['_id']})}})));
		const ids = peopleOf(responses).map(r => r._id);
		const found = new Map((await db.get([...new Set(ids)])).filter(r => r && !r._del).map(r => [r._id, persons.wrap(r)]));
		return ids.filter(id => found.has(id)).map(id => found.get(id));
	}

	async function similarName(person, contact, weights) {
		const cname = contactName(contact);
		const names = (person ? person.rec.names : []).concat([cname]);
		const queries = [];
		let onlyCompany = false;
		for (const n of names) {
			if (n.familyName && n.givenName) {
				queries.push({method: 'find', params: {query: {from: KIND, where: [
					{prop: 'names.familyName', op: '=', val: n.familyName, collate: 'primary'},
					{prop: 'names.givenName', op: '=', val: n.givenName, collate: 'primary'}
				]}}});
			}
		}
		if (queries.length < 1) {
			for (const org of entries(contact, 'organizations', DEFAULTS.organization)) {
				if (org.name && !org.title) {
					queries.push({method: 'find', params: {query: {from: KIND, where: [
						{prop: 'organization.name', op: '=', val: org.name, collate: 'primary'},
						{prop: 'organization.title', op: '=', val: '', collate: 'primary'}
					]}}});
					onlyCompany = true;
				}
			}
		}
		if (!queries.length) {
			return;
		}
		for (const p of await personsFound(queries)) {
			const pname = p.rec.name || {};
			if (onlyCompany) {
				if (model.fullName(pname) || (p.rec.organization && p.rec.organization.title)) {
					continue;
				}
			} else {
				if (pname.honorificSuffix !== cname.honorificSuffix && (pname.honorificSuffix || cname.honorificSuffix)) {
					continue;
				}
				if (pname.middleName !== cname.middleName && (pname.middleName || cname.middleName)) {
					continue;
				}
			}
			add(weights, SIMILAR.name, p, false);
		}
	}

	/*
		Autolinker.getPrefixNumberMapping: numbers by their search form. Only
		the distinct values under each form count (a match compares values),
		in the order they first came, and the forms in the order they first
		came.
	*/
	function byPrefix(list, into = new Map()) {
		for (const n of list) {
			if (!n) {
				continue;
			}
			const key = model.normalizePhoneNumber(n.value, true);
			if (!key) {
				continue;
			}
			if (!into.has(key)) {
				into.set(key, new Map());
			}
			const values = into.get(key);
			if (!values.has(String(n.value))) {
				values.set(String(n.value), n.value);
			}
		}
		return into;
	}

	/*
		The persons a mobile number is looked up in: those with a number whose
		normalised value starts with this one's digits, as the phone app looks
		up a caller: "-<the number's digits, reversed>", the search form
		without its closing "-". 408-555-1234 is stored as "-4321555804--1-+"
		and looked up as "-4321555804". The old service looked it up by
		Globalization's subscriber number, "-4321555-", which is not a prefix
		of what phonenumberlib stores, so 10-digit US numbers and NL mobile
		numbers never found anyone (README: Q7.15); and its queries shared one
		condition, so each asked for the last mobile number (Q7.14). A value
		with no digits is not looked up.
	*/
	function lookupKey(value) {
		if (typeof value !== 'string') {
			return null;
		}
		const key = model.normalizePhoneNumber(value, true).slice(0, -1);
		return /^-\d+$/.test(key) ? key : null;
	}

	async function similarPhoneNumber(person, contact, weights) {
		const parsed = {};
		const numbers = (person ? person.rec.phoneNumbers : []).concat(entries(contact, 'phoneNumbers', DEFAULTS.phone));
		const queries = [];
		for (const n of numbers) {
			if (n.type !== MOBILE || parsed[n.value]) {
				continue;
			}
			const p = G.Phone.parsePhoneNumber(n.value);
			const key = p ? lookupKey(n.value) : null;
			if (key) {
				queries.push({method: 'find', params: {query: {from: KIND,
					where: [{prop: 'phoneNumbers.normalizedValue', op: '%', val: key}]}}});
			}
			parsed[n.value] = key ? p : undefined;
		}
		if (!queries.length) {
			return;
		}
		const results = await personsFound(queries);
		const parse = v => {
			if (!parsed[v]) {
				parsed[v] = G.Phone.parsePhoneNumber(v);
			}
			return parsed[v];
		};
		/*
			A person found is like the contact when, under some search form both
			have, each of their mobile numbers compares as the same as each of
			the numbers linked so far: the contact's and its person's, then those
			of each person found like it. The forms are tried in the order the
			linked numbers gave them, as the old code did; the linked numbers are
			keyed once, not again for each person found, and each pair of values
			is compared once.
		*/
		let linked = null;
		const compared = new Map();
		const same = (a, b) => {
			const k = String(a) + '\u0000' + String(b);
			if (!compared.has(k)) {
				compared.set(k, G.Phone.comparePhoneNumbers(parse(a), parse(b)) > 0);
			}
			return compared.get(k);
		};
		for (const p of results) {
			const theirs = p.rec.phoneNumbers.map(n => (n.type === MOBILE ? n : undefined));
			if (theirs.length < 1) {
				continue;
			}
			if (!linked) {
				linked = byPrefix(numbers.map(n => (n.type === MOBILE ? n : undefined)));
			}
			const potential = byPrefix(theirs);
			for (const [key, current] of linked) {
				const their = potential.get(key);
				if (!their) {
					continue;
				}
				const values = [...their.values()];
				const mismatch = [...current.values()].some(c => values.some(q => !same(c, q)));
				if (!mismatch) {
					add(weights, SIMILAR.mobile, p, true);
					byPrefix(theirs, linked);
					break;
				}
			}
		}
	}

	/*
		An email or IM with no value is not looked up. A person keeps IM
		entries with an empty value, so the old service, which looked it up,
		linked a contact with an empty IM to every person that had one
		(README: Q7.17). A person has no empty email, so for emails that
		query found nothing.
	*/
	function singleProperty(prop, field, defaults, similarity) {
		return async (person, contact, weights) => {
			const list = (person ? person.rec[field] : []).concat(entries(contact, field, defaults));
			const queries = list.map(e => normalizeLower(e.value)).filter(val => val !== '').map(val => ({method: 'find',
				params: {query: {from: KIND, where: [{prop, op: '=', val}]}}}));
			if (!queries.length) {
				return;
			}
			for (const p of await personsFound(queries)) {
				add(weights, similarity, p, true);
			}
		};
	}

	const similarEmail = singleProperty('emails.normalizedValue', 'emails', DEFAULTS.email, SIMILAR.email);
	const similarIM = singleProperty('ims.normalizedValue', 'ims', DEFAULTS.im, SIMILAR.im);

	// Contact.getContactByRemoteId: the first contact with this remoteId, or null.
	async function contactByRemoteId(remoteId) {
		if (typeof remoteId !== 'string') {
			throw new Error('Contact.getContactByRemoteId requires a remoteId that is a valid string');
		}
		const r = await db.findPage({from: CONTACT_KIND, where: [{prop: 'remoteId', op: '=', val: remoteId}]});
		return r.results[0] || null;
	}

	// ContactLinkable.getOnePersonFromLinkHashId: the person of the contact a hash's id part names.
	async function personOfHashId(id) {
		const at = id.indexOf(LOCAL_ID_DELIM);
		if (at !== -1) {
			return persons.findByContactIds([id.substring(at + LOCAL_ID_DELIM.length)]);
		}
		const c = await contactByRemoteId(id);
		return c ? persons.findByContactIds([c._id]) : null;
	}

	// ContactLinkable.batchGetTwoPeopleWithContactIds: a person stands in (new, empty) for one not found.
	async function twoPeopleByContactIds(id1, id2) {
		const responses = await db.batch([id1, id2].map(val => ({method: 'find',
			params: {query: {from: KIND, where: [{prop: 'contactIds', op: '=', val}]}}})));
		if (responses.length > 1) {
			return [persons.wrap(responses[0].results[0]), persons.wrap(responses[1].results[0])];
		}
		return [];
	}

	// ContactLinkable.getTwoPeopleFromLinkHashIds, for a link that names neither side by this contact's hash.
	async function twoPeopleOfHashIds(id1, id2) {
		let both = false, local1 = false, local2 = false;
		let at = id1.indexOf(LOCAL_ID_DELIM);
		if (at !== -1) {
			id1 = id1.substring(at + LOCAL_ID_DELIM.length);
			both = true;
			local1 = true;
		}
		at = id2.indexOf(LOCAL_ID_DELIM);
		if (at !== -1) {
			id2 = id2.substring(at + LOCAL_ID_DELIM.length);
			local2 = true;
		} else {
			both = false;
		}
		if (both) {
			return twoPeopleByContactIds(id1, id2);
		}
		if (local1 !== local2) {
			// Both looked up by the id part, the local one already without its marker, as before.
			const a = await personOfHashId(id1);
			const b = await personOfHashId(id2);
			return [a, b];
		}
		const responses = await db.batch([id1, id2].map(val => ({method: 'find',
			params: {query: {from: CONTACT_KIND, where: [{prop: 'remoteId', op: '=', val}]}}})));
		let c1, c2;
		if (responses.length > 1) {
			c1 = responses[0].results[0] || {};
			c2 = responses[1].results[0] || {};
		}
		return c1 && c2 ? twoPeopleByContactIds(c1._id, c2._id) : null;
	}

	// ContactLinkable.getPersonFromCLBObject: the person (or two) a manual link points at.
	async function peopleOfLink(contact, link) {
		const hash = (await linkHash.linkHash(contact)).linkHash;
		if (link.contactEntityA === hash) {
			return [await personOfHashId(link.contactEntityB.split('|')[1])];
		}
		if (link.contactEntityB === hash) {
			return [await personOfHashId(link.contactEntityA.split('|')[1])];
		}
		return twoPeopleOfHashIds(link.contactEntityA.split('|')[1], link.contactEntityB.split('|')[1]);
	}

	function asPerson(p) {
		return p && !p.rec ? persons.wrap(p) : p;
	}

	async function manualLinks(person, contact, weights) {
		const r = await clb.getManualLinks(contact);
		if (!r || !r.results) {
			return;
		}
		for (const link of r.results) {
			const found = await peopleOfLink(contact, link);
			const two = [];
			if (found.length > 1) {
				two[0] = found[0] || undefined;
				two[1] = found[1] || undefined;
			} else if (found.length > 0) {
				two[0] = found[0] || undefined;
			}
			for (const p of two) {
				if (p) {
					add(weights, SIMILAR.manualLink, asPerson(p), true);
				}
			}
		}
	}

	/*
		Foundations.Control.mapReduce with no reduce: every item at once, and
		when all are done the first failure to happen, if any.
	*/
	async function mapReduce(items, map) {
		const failures = [];
		await Promise.all(items.map(item => Promise.resolve().then(() => map(item)).catch(e => {
			failures.push(e);
		})));
		if (failures.length) {
			throw failures[0];
		}
	}

	// Contact.getIdFromLinkHash: the contact _id a hash stands for (null when none has its remoteId).
	async function idOfHash(hash) {
		const idPart = hash.split('|')[1];
		const at = idPart.indexOf(LOCAL_ID_DELIM);
		if (at !== -1) {
			return idPart.substring(at + LOCAL_ID_DELIM.length);
		}
		const c = await contactByRemoteId(idPart);
		return c ? c._id : null;
	}

	async function manualUnlinks(person, contact, weights) {
		const ids = [];
		for (const key of Object.keys(weights)) {
			ids.push(...weights[key].person.rec.contactIds);
		}
		const contacts = await db.get(ids);
		/*
			The unlinks of every contact are read at once: each contact's link
			hash, then one batch for all of them, where each contact had a batch
			of its own. A contact whose hash fails fails the run as before, and
			a hash that is not a string is looked up alone, as before. The answer
			is the first failure: those of the hashes come first.
		*/
		const failures = [];
		const FAILED = {};
		const hashes = await Promise.all(contacts.map(c => Promise.resolve().then(() => linkHash.linkHash(c))
			.then(h => h.linkHash).catch(e => {
				failures.push(e);
				return FAILED;
			})));
		const byHash = await clb.unlinksByHash(Array.from(new Set(hashes.filter(h => typeof h === 'string'))));
		const lookUp = async (c, h) => {
			if (typeof h !== 'string') {
				return clb.getUnlinkLinks(c);
			}
			const got = byHash.get(h);
			if (got.error) {
				throw got.error;
			}
			return got;
		};
		const pairs = contacts.map((c, i) => [c, hashes[i]]).filter(([, h]) => h !== FAILED);
		await mapReduce(pairs, async ([c, h]) => {
			const r = await lookUp(c, h);
			if (!r || !r.results) {
				throw new Error('Autolinker.manualUnlinks: did not get a result when getting manualUnlinks');
			}
			/*
				Each walk has its own ids. The old code kept them in one variable
				for this contact, which the walk in hits() set to another
				person's: the walk that called it went on in those, past their
				end, and failed the contact with a TypeError.
			*/
			const hits = (id, skip) => {
				for (const key of Object.keys(weights)) {
					const w = weights[key];
					if (w === skip) {
						continue;
					}
					for (const cid of w.person.rec.contactIds) {
						if (cid === id) {
							add(weights, SIMILAR.manualUnlink, w.person, true);
						}
					}
				}
			};
			await mapReduce(r.results, async unlink => {
				const idA = await idOfHash(unlink.contactEntityA);
				const idB = await idOfHash(unlink.contactEntityB);
				const inA = idA === contact._id;
				const inB = idB === contact._id;
				if (inA || inB) {
					hits(inA ? idB : idA);
					return;
				}
				for (const key of Object.keys(weights)) {
					const w = weights[key];
					for (const cid of w.person.rec.contactIds.slice()) {
						if (cid === idA) {
							hits(idB, w);
						}
						if (cid === idB) {
							hits(idA, w);
						}
					}
				}
			});
		}).catch(e => {
			failures.push(e);
		});
		if (failures.length) {
			throw failures[0];
		}
	}

	/*
		Autolinker.doRankingFunctions. The four similarity rankers run at once,
		so that their db8 reads overlap, as the LuneOS service had them
		(5eb34f6). That service let them add to one set of weights, so ties
		went by which db8 reply came back first (README). Here each adds to
		its own, and those are added up in a fixed order, name, phone, email,
		IM, then the manual links, which need only the contact and so run
		with them: the weights are the ones running them one after the other
		gives, and so is the error, the first in that order. The manual
		unlinks go through the persons found, so they come after.
	*/
	async function rank(person, contact) {
		const outcomes = await Promise.allSettled([similarName, similarPhoneNumber, similarEmail, similarIM, manualLinks]
			.map(async ranker => {
				const own = {};
				await ranker(person, contact, own);
				return own;
			}));
		const weights = {};
		for (const outcome of outcomes) {
			if (outcome.status === 'rejected') {
				throw outcome.reason;
			}
			for (const [id, u] of Object.entries(outcome.value)) {
				const unit = weights[id] || {person: u.person, weight: undefined, similarOn: []};
				unit.weight = unit.weight ? unit.weight + u.weight : u.weight;
				unit.similarOn.push(...u.similarOn);
				weights[id] = unit;
			}
		}
		await manualUnlinks(person, contact, weights);
		return weights;
	}

	return {rank, similarName, similarPhoneNumber, similarEmail, similarIM, manualLinks, manualUnlinks};
}

module.exports = {createRankers, meetsThreshold, SIMILAR, MATCH_THRESHOLD};
