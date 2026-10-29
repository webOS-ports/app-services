// Copyright (c) 2026 Herman van Hazendonk
// Derived from Foundations' data/db.js, Copyright (c) 2009-2012 Hewlett-
// Packard Development Company, L.P., licensed under the Apache License,
// Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	db8 over the bus, as org.webosports.messaging's service/lib/db.js has it,
	with what the linker needs on top: one page of a find (the linker reads
	only the first page where it always did), batch, reserveIds, and a delete
	by query.

	As Foundations' DB did: an empty get, put, merge or delete answers at
	once without a call; a delete by ids leaves purge to db8's default; a
	delete by query says purge:false.
*/

const MAX_WRITE = 500;

function createDb({call, service = 'luna://com.palm.db'}) {
	// One page: {results, next}.
	async function findPage(query) {
		const r = await call(service + '/find', {query});
		return {results: r.results || [], next: r.next};
	}

	// Every page.
	async function find(query) {
		const all = [];
		let q = Object.assign({}, query);
		for (;;) {
			const {results, next} = await findPage(q);
			all.push(...results);
			if (!next || (query.limit && all.length >= query.limit)) {
				break;
			}
			q = Object.assign({}, query, {page: next});
		}
		return all;
	}

	async function chunked(method, key, list) {
		const out = [];
		for (let i = 0; i < list.length; i += MAX_WRITE) {
			const r = await call(service + '/' + method, {[key]: list.slice(i, i + MAX_WRITE)});
			out.push(...(r.results || []));
		}
		return out;
	}

	// The operations' replies, in order: [{returnValue, results, next?}].
	async function batch(operations) {
		const r = await call(service + '/batch', {operations});
		return r.responses || [];
	}

	async function reserveIds(count) {
		if (count === 0) {
			return [];
		}
		const r = await call(service + '/reserveIds', {count});
		return r.ids || [];
	}

	// -> the number deleted
	async function delQuery(query) {
		const r = await call(service + '/del', {query, purge: false});
		return r.count;
	}

	return {
		find, findPage, batch, reserveIds, delQuery,
		get: ids => chunked('get', 'ids', ids),
		put: objects => chunked('put', 'objects', objects),
		merge: objects => chunked('merge', 'objects', objects),
		del: ids => chunked('del', 'ids', ids)
	};
}

module.exports = {createDb, MAX_WRITE};
