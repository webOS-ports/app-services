// Copyright (c) 2026 Herman van Hazendonk
// Derived from Foundations' comms/palmcall.js and control/mapreduce.js,
// Copyright (c) 2009-2012 Hewlett-Packard Development Company, L.P., licensed
// under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	Calls to other services as the old service made them with Foundations'
	PalmCall, and its mapReduce, so that what a command answers when one
	fails reads as it did.

	call(uri, method, args): the address is uri and method joined as
	PalmCall joined them ("palm://a/" + "m", "palm://a" + "/" + "m", or uri
	alone for an empty method). The reply, or an Error:
	- for a reply that has returnValue:false, an errorCode or an errorText
	  (PalmCall took all three as a failure): errorCode the reply's (or -1
	  where it has none, or a falsy one), text "<address> <args>: <errorText,
	  or 'Unknown PalmCall failure'>";
	- no reply within timeoutMs: bus.js's BUS_TIMEOUT. PalmCall waited for
	  ever, and so does a call here unless it is given a timeout.

	One thing deliberately differs: in that text a password, keydata or
	credentials value of the arguments is written as "<hidden>". The old
	text carried them, and both a reply and the log can show it (README.md).

	fire(uri, method, args): a call nobody waits for, as the old service made
	many; what comes of it is dropped.
*/

const FOREVER_MS = 0x7fffffff;
const SECRET = new Set(['password', 'keydata', 'credentials']);

function address(uri, method) {
	if (!method) {
		return uri;
	}
	return uri.charAt(uri.length - 1) === '/' ? uri + method : uri + '/' + method;
}

function shown(args) {
	return JSON.stringify(args, (k, v) => (SECRET.has(k) && v !== undefined ? '<hidden>' : v));
}

function failure(url, args, r) {
	const e = new Error(url + ' ' + shown(args) + ': ' + ((r && r.errorText) || 'Unknown PalmCall failure'));
	e.errorCode = (r && r.errorCode) || -1;
	return e;
}

function createPalmCall(bus) {
	async function call(uri, method, args, {timeoutMs = FOREVER_MS} = {}) {
		const url = address(uri, method);
		let r;
		try {
			r = await bus.call(url.replace(/^palm:/, 'luna:'), args || {}, {timeoutMs});
		} catch (e) {
			if (e && e.reply) {
				throw failure(url, args || {}, e.reply);
			}
			throw e;
		}
		if (r.errorCode || r.errorText) {
			throw failure(url, args || {}, r);
		}
		return r;
	}

	function fire(uri, method, args) {
		call(uri, method, args).catch(() => {});
	}

	// A subscription: {first, cancel}; onEvent(reply) for each reply after the first.
	function subscribe(uri, method, args, onEvent) {
		const url = address(uri, method);
		return bus.subscribe(url.replace(/^palm:/, 'luna:'), args || {}, {timeoutMs: FOREVER_MS, onEvent});
	}

	return {call, fire, subscribe};
}

/*
	Foundations.Control.mapReduce: map(item) for each item in turn (a throw
	stops there and fails the whole), all at once; each outcome
	{item, result} or {item, exception}, in the order they came in. With a
	reduce, its value (or what it throws) is the outcome. Without one, the
	first failure to come in, or else the outcomes.
*/
async function mapReduce(items, map, reduce) {
	const outcomes = [];
	const pending = [];
	for (const item of items) {
		const p = Promise.resolve(map(item));
		pending.push(p.then(result => {
			outcomes.push({item, result});
		}, exception => {
			outcomes.push({item, exception});
		}));
	}
	await Promise.all(pending);
	if (reduce) {
		return reduce(outcomes);
	}
	const failed = outcomes.find(o => 'exception' in o);
	if (failed) {
		throw failed.exception;
	}
	return outcomes;
}

module.exports = {createPalmCall, mapReduce, address, shown, FOREVER_MS};
