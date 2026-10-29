// Copyright (c) 2026 Herman van Hazendonk
// Derived from Foundations' data/db.js, Copyright (c) 2009-2012 Hewlett-
// Packard Development Company, L.P., licensed under the Apache License,
// Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	db8 as the old service used it through Foundations' DB: each call's
	reply as it is ({returnValue, results, next?}), one page of a find (the
	old service never read on past the first), and an empty get, put, merge
	or delete answered at once without a call. A failure is a PalmCall one
	(lib/palmcall.js) on palm://com.palm.db/<method>, as Foundations
	named it.
*/

const DB = 'palm://com.palm.db/';
const EMPTY = () => ({returnValue: true, results: []});

function createDb(pc) {
	const many = (method, key) => list => (list.length === 0 ? Promise.resolve(EMPTY()) :
		pc.call(DB, method, {[key]: list}));
	return {
		find: query => pc.call(DB, 'find', {query}),
		get: many('get', 'ids'),
		put: many('put', 'objects'),
		merge: many('merge', 'objects'),
		del: many('del', 'ids')
	};
}

module.exports = {createDb};
