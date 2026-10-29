// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// A bus for the tests: db8 and tempdb in memory, the activity manager, the
// accounts service, and cloud services the test describes.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Which kinds a kind's objects are also found under
const PARENTS = {
	'com.palm.media.image.file:1': ['com.palm.media.file:1', 'com.palm.media.types:1'],
	'com.palm.media.video.file:1': ['com.palm.media.file:1', 'com.palm.media.types:1'],
	'com.palm.media.file:1': ['com.palm.media.types:1']
};

// The indexes of the kinds (as LuneOS defines them); a query needs one
const INDEXES = {
	'com.palm.media.image.album:1': [['path'], ['albumId'], ['path', 'createdTime'], ['mediaType'], ['modifiedTime'],
		['sortKey'], ['searchKey'], ['name'], ['type'], ['type', 'modifiedTime'], ['accountId'], ['toBeDeleted'],
		['accountId', 'modifiedTime'], ['name', 'type'], ['showAlbum'], ['showAlbum', 'modifiedTime'],
		['showAlbum', 'type', 'modifiedTime'], ['showAlbum', 'accountId', 'modifiedTime'], ['_rev']],
	'com.palm.media.types:1': [['albumPath', 'createdTime', 'appCacheComplete'], ['path'], ['albumPath'], ['albumId'],
		['appCacheComplete', 'albumId'], ['appCacheComplete', 'type', 'albumId'], ['mediaType'],
		['appCacheComplete', 'albumId', 'createdTime'], ['albumPath', 'createdTime']],
	'com.palm.media.file:1': [['path']],
	'com.palm.media.image.file:1': [['path'], ['albumId'], ['albumId', 'createdTime'], ['albumPath', 'createdTime'], ['type'],
		['appCacheComplete', 'albumId'], ['mediaType'], ['_rev'], ['modifiedTime']],
	'com.palm.media.video.file:1': [['path'], ['albumPath'], ['mediaType'], ['albumPath', 'createdTime'], ['albumId'],
		['appCacheComplete', 'albumId'], ['_rev'], ['modifiedTime']],
	'com.palm.account:1': [['beingDeleted', 'templateId', 'username'], ['capabilityProviders.capability', 'beingDeleted']],
	'com.palm.account.syncstate:1': [['accountId', 'capabilityProvider'], ['accountId', 'capabilityProvider', 'collectionId'],
		['accountId', 'collectionId']]
};

// The where props, in any order, then the orderBy prop, must start an index
function checkIndex(query) {
	const indexes = INDEXES[query.from];
	if (!indexes) {
		throw new Error(`fake db8: no kind ${query.from}`);
	}
	const props = new Set((query.where || []).map(w => w.prop));
	if (!props.size && !query.orderBy) {
		return;
	}
	const ok = indexes.some(idx => {
		const head = idx.slice(0, props.size);
		if (head.length !== props.size || !head.every(p => props.has(p))) {
			return false;
		}
		return !query.orderBy || props.has(query.orderBy) || idx[props.size] === query.orderBy;
	});
	if (!ok) {
		throw new Error(`fake db8: no index on ${query.from} for ${[...props]} ${query.orderBy || ''}`);
	}
}

function lookup(obj, prop) {
	let values = [obj];
	for (const part of prop.split('.')) {
		const next = [];
		for (const v of values) {
			const x = v === null || v === undefined ? undefined : v[part];
			if (Array.isArray(x)) {
				next.push(...x);
			} else if (x !== undefined) {
				next.push(x);
			}
		}
		values = next;
	}
	return values;
}

function matches(obj, where) {
	return (where || []).every(w => {
		const values = lookup(obj, w.prop);
		const wanted = Array.isArray(w.val) ? w.val : [w.val];
		if (w.op !== '=') {
			throw new Error(`fake db8: op ${w.op}`);
		}
		return values.some(v => wanted.includes(v)) ||
			(values.length === 0 && wanted.includes(undefined));
	});
}

class FakeDb8 {
	constructor() {
		this.objects = new Map();
		this.nextId = 1;
		this.watchers = [];
		this.failMerge = null;     // (objects) => true to fail a merge
		this.failDel = null;       // (ids) => true to fail a delete
	}

	isKind(obj, kind) {
		return obj._kind === kind || (PARENTS[obj._kind] || []).includes(kind);
	}

	query(query) {
		checkIndex(query);
		const incDel = (query.where || []).some(w => w.prop === '_del');
		return [...this.objects.values()].filter(o =>
			this.isKind(o, query.from) && (incDel || !o._del) && matches(o, query.where));
	}

	notify(kind) {
		const fire = this.watchers.filter(w => this.isKind({_kind: kind}, w.query.from) ||
			w.query.from === kind);
		this.watchers = this.watchers.filter(w => !fire.includes(w));
		for (const w of fire) {
			setImmediate(() => w.cb({returnValue: true, fired: true}));
		}
	}

	handle(method, p, cb) {
		try {
			return this.dispatch(method, p, cb);
		} catch (e) {
			return {returnValue: false, errorCode: -3963, errorText: e.message};
		}
	}

	dispatch(method, p, cb) {
		switch (method) {
		case 'find': {
			const all = this.query(p.query);
			if (p.count) {
				return {returnValue: true, count: all.length, results: []};
			}
			const offset = p.query.page ? Number(p.query.page) : 0;
			const limit = p.query.limit || 500;
			const results = all.slice(offset, offset + limit).map(o => JSON.parse(JSON.stringify(o)));
			const r = {returnValue: true, results};
			if (offset + limit < all.length) {
				r.next = String(offset + limit);
			}
			if (p.watch && cb) {
				this.watchers.push({query: p.query, cb});
			}
			return r;
		}
		case 'get':
			return {returnValue: true, results: p.ids.map(id => this.objects.get(id)).filter(Boolean)
				.map(o => JSON.parse(JSON.stringify(o)))};
		case 'put': {
			const results = [];
			for (const o of p.objects) {
				const id = o._id || `id${this.nextId++}`;
				this.objects.set(id, Object.assign(JSON.parse(JSON.stringify(o)), {_id: id, _rev: this.nextId}));
				results.push({id, rev: this.nextId});
				this.notify(o._kind);
			}
			return {returnValue: true, results};
		}
		case 'merge': {
			if (p.query) {
				const hits = this.query(p.query);
				for (const o of hits) {
					Object.assign(o, JSON.parse(JSON.stringify(p.props)));
				}
				if (hits.length) {
					this.notify(p.query.from);
				}
				return {returnValue: true, count: hits.length};
			}
			if (this.failMerge && this.failMerge(p.objects)) {
				return {returnValue: false, errorCode: -1, errorText: 'merge failed (test)'};
			}
			const results = [];
			for (const m of p.objects) {
				const o = this.objects.get(m._id);
				if (!o) {
					return {returnValue: false, errorCode: -3950, errorText: 'not found'};
				}
				Object.assign(o, JSON.parse(JSON.stringify(m)));
				results.push({id: m._id});
				this.notify(o._kind);
			}
			return {returnValue: true, results};
		}
		case 'del': {
			if (this.failDel && p.ids && this.failDel(p.ids)) {
				return {returnValue: false, errorCode: -1, errorText: 'del failed (test)'};
			}
			const hits = p.query ? this.query(p.query) : p.ids.map(id => this.objects.get(id)).filter(Boolean);
			// A deleted object keeps its properties, as db8's does until purged
			for (const o of hits) {
				o._del = true;
				this.notify(o._kind);
			}
			return {returnValue: true, count: hits.length, results: hits.map(o => ({id: o._id}))};
		}
		default:
			return {returnValue: false, errorText: `fake db8: ${method}`};
		}
	}

	live(kind) {
		return [...this.objects.values()].filter(o => this.isKind(o, kind) && !o._del);
	}
}

class FakeBus {
	constructor() {
		this.db = new FakeDb8();
		this.tempdb = new FakeDb8();
		this.calls = [];
		this.providers = {};          // service name -> {method: (params) => payload}
		this.credentials = true;
	}

	route(uri, params, cb) {
		const m = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri);
		const [, service, method] = m;
		this.calls.push({service, method, params});
		if (service === 'com.palm.db') {
			return this.db.handle(method, params, cb);
		}
		if (service === 'com.palm.tempdb') {
			return this.tempdb.handle(method, params, cb);
		}
		if (service === 'com.palm.activitymanager') {
			return {returnValue: true, activityId: 7};
		}
		if (service === 'com.palm.service.accounts' && method === 'hasCredentials') {
			return {returnValue: true, value: this.credentials};
		}
		const provider = this.providers[service];
		if (provider && provider[method]) {
			return provider[method](params);
		}
		return {returnValue: false, errorCode: -1, errorText: `Unknown method ${uri}`};
	}

	async call(uri, params) {
		await new Promise(r => setImmediate(r));
		return this.route(uri, JSON.parse(JSON.stringify(params || {})));
	}

	subscribe(uri, params, onPayload) {
		let open = true;
		const cb = payload => {
			if (open) {
				onPayload(payload);
			}
		};
		setImmediate(() => cb(this.route(uri, JSON.parse(JSON.stringify(params || {})), cb)));
		return {cancel: () => { open = false; }};
	}

	callsTo(service, method) {
		return this.calls.filter(c => c.service === service && (!method || c.method === method));
	}
}

// --- image bytes the probe and the tests use -------------------------------

function png(width, height) {
	const b = Buffer.alloc(33);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(0x0d0a1a0a, 4);
	b.writeUInt32BE(13, 8);
	b.write('IHDR', 12, 'latin1');
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b;
}

// A JPEG header: SOI, an Exif APP1 with the orientation (when given), a
// 4 KB APP2 to push the frame header past the first read, SOF0, SOS, EOI.
function jpeg(width, height, {orientation, bigEndian = false} = {}) {
	const parts = [Buffer.from([0xff, 0xd8])];
	if (orientation) {
		const tiff = Buffer.alloc(8 + 2 + 12 + 4);
		const w16 = (v, o) => (bigEndian ? tiff.writeUInt16BE(v, o) : tiff.writeUInt16LE(v, o));
		const w32 = (v, o) => (bigEndian ? tiff.writeUInt32BE(v, o) : tiff.writeUInt32LE(v, o));
		tiff.write(bigEndian ? 'MM' : 'II', 0, 'latin1');
		w16(42, 2);
		w32(8, 4);
		w16(1, 8);
		w16(0x0112, 10);
		w16(3, 12);
		w32(1, 14);
		w16(orientation, 18);
		const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
		const head = Buffer.from([0xff, 0xe1, 0, 0]);
		head.writeUInt16BE(body.length + 2, 2);
		parts.push(head, body);
	}
	const filler = Buffer.alloc(4096);
	const app2 = Buffer.from([0xff, 0xe2, 0, 0]);
	app2.writeUInt16BE(filler.length + 2, 2);
	parts.push(app2, filler);
	const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	parts.push(sof, Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0]), Buffer.from([0x12, 0x34, 0xff, 0xd9]));
	return Buffer.concat(parts);
}

function tmpRoot() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-test-'));
	const media = path.join(dir, 'media');
	fs.mkdirSync(media);
	return {dir, media, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

// A thumbnailer that writes a marker file instead of running gst-launch-1.0
class FakeThumbnailer {
	constructor() {
		this.made = [];
	}

	async make(src, dst, w, h, info) {
		this.made.push({src, dst, w, h});
		fs.mkdirSync(path.dirname(dst), {recursive: true});
		fs.writeFileSync(dst, 'thumb');
		return {'original-width': info.width, 'original-height': info.height, 'output-width': w, 'output-height': h};
	}
}

// A download that serves bytes from a map of URL -> Buffer
function fakeDownload(files) {
	const fetched = [];
	const fn = async (url, dest, opts = {}) => {
		fetched.push({url, dest, localRoot: opts.localRoot, removeSource: opts.removeSource});
		if (!files.has(url)) {
			throw new Error(`HTTP 404 for ${url}`);
		}
		fs.writeFileSync(dest, files.get(url));
		return files.get(url).length;
	};
	fn.fetched = fetched;
	return fn;
}

module.exports = {FakeBus, FakeDb8, FakeThumbnailer, fakeDownload, png, jpeg, tmpRoot};
