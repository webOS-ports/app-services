// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	An in-memory db8 (the contacts linker's), as much of it as the contacts
	services rely on, written to what
	db8 was seen to do on the LuneOS VM (2026-10-28):

	- kinds that extend others: a query from com.palm.contact:1 sees
	  com.palm.contact.palmprofile:1; the service's own kinds are read from
	  db/kinds, the linker's (persons, contacts, backups) from tests/kinds
	- = (an array value: any of them), != < <= > >= and % (string prefix);
	  collate "primary" compares case- and accent-blind
	- array properties match per value, and two conditions on the same array
	  match across its elements: names.familyName = A and names.givenName = D
	  finds a person whose names are [{A, B}, {C, D}], as db8 does
	- index defaults (names.givenName defaults to "" in its index)
	- a number compares above any string, so _rev > "abc" finds everything
	- results in index order: by the value the range or prefix condition
	  matched (the lowest one, for an array), else by _id; _rev for a query on
	  _rev; each record once
	- pages of at most 500, and a limit above 500 is refused
	- get keeps the order asked for, leaves out ids it does not have, and
	  returns deleted records too
	- del marks _del and keeps the record; incDel finds it, plain queries do
	  not; del with a query answers the count
	- merge replaces arrays and merges objects, and stores an object whose
	  _id it does not have as new
	- every object in an array gets an _id of its own, as db8 gives one
	- batch answers { responses: [...] }; reserveIds hands out fresh ids
*/

const fs = require('fs');
const path = require('path');

// The service's own kind, and copies of the contacts linker's (persons, contacts, backups).
const KINDS_DIRS = [path.join(__dirname, '..', 'db', 'kinds'), path.join(__dirname, 'kinds')];
const MAX_PAGE = 500;

// Contact kinds of other components: only that they extend com.palm.contact:1 matters here.
const CONTACT_SUBKINDS = ['google', 'facebook', 'linkedin', 'eas', 'yahoo', 'sim', 'attaddresssync',
	'skype', 'libpurple', 'imyahoo', 'carddav'];

function loadKinds() {
	const kinds = {};
	for (const dir of KINDS_DIRS) {
		for (const file of fs.readdirSync(dir)) {
			const k = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			kinds[k.id] = {extends: (k.extends || [])[0], indexes: k.indexes || []};
		}
	}
	for (const s of CONTACT_SUBKINDS) {
		kinds['com.palm.contact.' + s + ':1'] = {extends: 'com.palm.contact:1', indexes: []};
	}
	return kinds;
}

const KINDS = loadKinds();

const collator = new Intl.Collator('en', {sensitivity: 'base'});

function clone(v) {
	return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function isA(kind, wanted) {
	for (let k = kind; k; k = KINDS[k] && KINDS[k].extends) {
		if (k === wanted) {
			return true;
		}
	}
	return false;
}

// Every value a dotted path reaches, through arrays at any level.
function values(obj, prop) {
	let level = [obj];
	for (const part of prop.split('.')) {
		const next = [];
		for (const v of level) {
			if (Array.isArray(v)) {
				for (const e of v) {
					if (e && typeof e === 'object' && part in e) {
						next.push(e[part]);
					}
				}
			} else if (v && typeof v === 'object' && part in v) {
				next.push(v[part]);
			}
		}
		level = next;
	}
	const flat = [];
	for (const v of level) {
		if (Array.isArray(v)) {
			flat.push(...v);
		} else if (v !== undefined) {
			flat.push(v);
		}
	}
	return flat;
}

// The default an index of the kind declares for prop, if any.
function indexDefault(kind, prop) {
	for (let k = kind; k; k = KINDS[k] && KINDS[k].extends) {
		for (const idx of (KINDS[k] && KINDS[k].indexes) || []) {
			for (const p of idx.props) {
				if (p.name === prop && 'default' in p) {
					return {has: true, value: p.default};
				}
			}
		}
	}
	return {has: false};
}

function propValues(record, prop) {
	const vs = values(record, prop);
	if (vs.length) {
		return vs;
	}
	const d = indexDefault(record._kind, prop);
	return d.has ? [d.value] : [];
}

// db8's order of values of different types: here only that numbers sort above strings matters.
function rank(v) {
	if (v === null || v === undefined) {
		return 0;
	}
	if (typeof v === 'boolean') {
		return 1;
	}
	if (typeof v === 'string') {
		return 2;
	}
	if (typeof v === 'number') {
		return 3;
	}
	return 4;
}

function compare(a, b, collate) {
	const ra = rank(a), rb = rank(b);
	if (ra !== rb) {
		return ra - rb;
	}
	if (typeof a === 'string' && collate === 'primary') {
		return collator.compare(a, b);
	}
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

function test(op, v, val, collate) {
	switch (op) {
	case '=':
		return Array.isArray(val) ? val.some(x => compare(v, x, collate) === 0) : compare(v, val, collate) === 0;
	case '!=':
		return compare(v, val, collate) !== 0;
	case '<':
		return compare(v, val, collate) < 0;
	case '<=':
		return compare(v, val, collate) <= 0;
	case '>':
		return compare(v, val, collate) > 0;
	case '>=':
		return compare(v, val, collate) >= 0;
	case '%':
		if (typeof v !== 'string' || typeof val !== 'string') {
			return false;
		}
		return collate === 'primary' ? collator.compare(v.slice(0, val.length), val) === 0 : v.startsWith(val);
	default:
		throw new Error('fakedb: no operator ' + op);
	}
}

function deepMerge(target, src) {
	for (const k of Object.keys(src)) {
		const s = src[k];
		if (s && typeof s === 'object' && !Array.isArray(s) && target[k] && typeof target[k] === 'object' &&
				!Array.isArray(target[k])) {
			deepMerge(target[k], s);
		} else {
			target[k] = clone(s);
		}
	}
	return target;
}

function dbError(code, text) {
	const e = new Error(text);
	e.errorCode = code;
	e.errorText = text;
	return e;
}

function createFakeDb({prefix = 'f'} = {}) {
	const records = new Map();
	const calls = {find: 0, get: 0, put: 0, merge: 0, del: 0, batch: 0, reserveIds: 0};
	const failing = {};
	let rev = 1000;
	let idSeq = 0;
	let subSeq = 0;

	// Ids sort in the order they were made, as db8's do.
	function newId() {
		idSeq++;
		return prefix + String(idSeq).padStart(8, '0');
	}

	function failNext(method, n = 1, error = null) {
		failing[method] = {n, error: error || dbError(-3999, 'fakedb: ' + method + ' failed')};
	}

	function enter(method) {
		calls[method]++;
		const f = failing[method];
		if (f && f.n > 0) {
			f.n--;
			throw f.error;
		}
	}

	function check(kind) {
		if (!KINDS[kind]) {
			throw dbError(-3970, 'kind not registered: \'' + kind + '\'');
		}
	}

	// db8 gives every object inside an array an _id of its own.
	function idArrays(v) {
		if (Array.isArray(v)) {
			for (const e of v) {
				if (e && typeof e === 'object' && !Array.isArray(e)) {
					if (e._id === undefined) {
						subSeq++;
						e._id = subSeq.toString(16);
					}
					idArrays(e);
				}
			}
		} else if (v && typeof v === 'object') {
			for (const k of Object.keys(v)) {
				idArrays(v[k]);
			}
		}
	}

	function stamp(record) {
		rev++;
		record._rev = rev;
	}

	function store(obj) {
		if (!obj || !obj._kind) {
			throw dbError(-3962, 'db: missing _kind');
		}
		check(obj._kind);
		const record = clone(obj);
		if (!record._id) {
			record._id = newId();
		}
		delete record._del;
		idArrays(record);
		stamp(record);
		records.set(record._id, record);
		return {id: record._id, rev: record._rev};
	}

	async function put(objects) {
		enter('put');
		return objects.map(store);
	}

	async function merge(objects) {
		enter('merge');
		return objects.map(o => {
			// An id db8 does not have is stored as new, as a put would.
			if (!records.has(o._id)) {
				return store(o);
			}
			const r = records.get(o._id);
			const patch = clone(o);
			delete patch._rev;
			delete patch._kind;
			deepMerge(r, patch);
			idArrays(r);
			stamp(r);
			return {id: r._id, rev: r._rev};
		});
	}

	async function get(ids) {
		enter('get');
		return ids.map(id => records.get(id)).filter(Boolean).map(clone);
	}

	function delRecord(id) {
		const r = records.get(id);
		r._del = true;
		stamp(r);
		return {id, rev: r._rev};
	}

	function matching(query) {
		const where = query.where || [];
		return Array.from(records.values()).filter(r => {
			if (!isA(r._kind, query.from) || (r._del && !query.incDel)) {
				return false;
			}
			return where.every(c => propValues(r, c.prop).some(v => test(c.op, v, c.val, c.collate)));
		});
	}

	// The key a record sorts on: the lowest value its range or prefix condition matched, else
	// none (then by _id); a query on _rev sorts by _rev.
	function sortKey(record, query) {
		const where = query.where || [];
		const range = where.find(c => c.op !== '=');
		const prop = query.orderBy || (range && range.prop);
		if (!prop) {
			return undefined;
		}
		const vs = propValues(record, prop).filter(v => !range || range.prop !== prop ||
			test(range.op, v, range.val, range.collate));
		vs.sort((a, b) => compare(a, b, range && range.collate));
		return vs[0];
	}

	function findPage(query) {
		check(query.from);
		if (query.limit !== undefined && (query.limit < 0 || query.limit > MAX_PAGE)) {
			throw dbError(-986, 'invalid parameters: value out of range for property \'limit\' for property \'query\'');
		}
		const range = (query.where || []).find(c => c.op !== '=');
		const list = matching(query).map(r => ({r, key: sortKey(r, query)}));
		list.sort((a, b) => {
			const c = compare(a.key, b.key, range && range.collate);
			if (c) {
				return query.desc ? -c : c;
			}
			return a.r._id < b.r._id ? -1 : a.r._id > b.r._id ? 1 : 0;
		});
		const start = query.page ? Number(query.page) : 0;
		const limit = query.limit || MAX_PAGE;
		// select: only those properties, as db8 gives them.
		const pick = r => (query.select ? Object.fromEntries(query.select.filter(k => k in r).map(k => [k, r[k]])) : r);
		const slice = list.slice(start, start + limit).map(e => clone(pick(e.r)));
		const next = start + limit < list.length ? String(start + limit) : undefined;
		return {results: slice, next};
	}

	async function find(query) {
		enter('find');
		return findPage(query);
	}

	async function delQuery(query) {
		enter('del');
		const list = matching(query);
		list.forEach(r => delRecord(r._id));
		return {count: list.length};
	}

	async function del(ids) {
		enter('del');
		return ids.filter(id => records.has(id)).map(delRecord);
	}

	async function reserveIds(count) {
		enter('reserveIds');
		const ids = [];
		for (let i = 0; i < count; i++) {
			ids.push(newId());
		}
		return ids;
	}

	async function one(method, args) {
		switch (method) {
		case 'find': {
			const r = await find(args.query);
			return Object.assign({returnValue: true, results: r.results}, r.next ? {next: r.next} : {});
		}
		case 'get':
			return {returnValue: true, results: await get(args.ids)};
		case 'put':
			return {returnValue: true, results: await put(args.objects)};
		case 'merge':
			return {returnValue: true, results: await merge(args.objects)};
		case 'del':
			if (args.query) {
				return Object.assign({returnValue: true}, await delQuery(args.query));
			}
			return {returnValue: true, results: await del(args.ids)};
		case 'reserveIds':
			return {returnValue: true, ids: await reserveIds(args.count)};
		case 'batch': {
			enter('batch');
			const responses = [];
			for (const op of args.operations) {
				responses.push(await handle(op.method, op.params));
			}
			return {returnValue: true, responses};
		}
		default:
			return {returnValue: false, errorCode: -1, errorText: 'Unknown method "' + method + '" for category "/"'};
		}
	}

	// The same database behind luna://com.palm.db/<method>, for a stand-in palmbus.
	async function handle(method, args) {
		try {
			return await one(method, args || {});
		} catch (e) {
			return {returnValue: false, errorCode: e.errorCode || -1, errorText: e.errorText || e.message};
		}
	}

	// Direct access for tests: every record of a kind (subkinds included).
	function all(kind, {deleted = false} = {}) {
		return Array.from(records.values()).filter(r => isA(r._kind, kind) && (deleted || !r._del)).map(clone);
	}

	function resetCalls() {
		for (const k of Object.keys(calls)) {
			calls[k] = 0;
		}
	}

	return {put, merge, get, del, delQuery, find, reserveIds, handle, all, calls, resetCalls, failNext, records};
}

module.exports = {createFakeDb, KINDS, MAX_PAGE};
