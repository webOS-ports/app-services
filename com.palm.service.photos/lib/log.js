// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// On a device the service's stdout/stderr go to the journal; PmLog is used
// when the binding is there so the lines carry the service's context.
let sink = null;
try {
	const pmlog = require('pmloglib');
	sink = new pmlog.Console('com.palm.service.photos');
} catch (e) {
	sink = null;
}

let quiet = false;

function line(level, args) {
	if (quiet) {
		return;
	}
	const text = args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' ');
	if (sink) {
		(sink[level] || sink.log).call(sink, text);
	} else {
		(console[level] || console.log).call(console, 'photos: ' + text);
	}
}

function safeJson(value) {
	if (value instanceof Error) {
		return value.stack || String(value);
	}
	try {
		return JSON.stringify(value);
	} catch (e) {
		return String(value);
	}
}

module.exports = {
	info: (...a) => line('info', a),
	warn: (...a) => line('warn', a),
	error: (...a) => line('error', a),
	// The unit tests switch the output off.
	setQuiet: q => { quiet = !!q; }
};
