// Copyright (c) 2026 Herman van Hazendonk
// Derived from Foundations' data/db.js, Copyright (c) 2009-2012 Hewlett-
// Packard Development Company, L.P., licensed under the Apache License,
// Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	db8 as Foundations' DB gave it to the service: each call answers db8's
	reply as it is ({returnValue, results, next?, count?, responses?}), and
	fails as PalmCall failed (mojo.js). find reads one page, as DB.find did:
	no query here asks for more than db8 hands out at once, but see README.md
	on the 500 events a scan sees. An empty get, put, merge or delete answers
	{returnValue: true, results: []} at once, without a call.
*/

const SERVICE = 'luna://com.palm.db/';

function createDb({call}) {
	const execute = (cmd, args) => call(SERVICE + cmd, args);
	const empty = () => Promise.resolve({returnValue: true, results: []});
	return {
		execute,
		find: query => execute('find', {query}),
		get: ids => (ids.length === 0 ? empty() : execute('get', {ids})),
		put: objects => (objects.length === 0 ? empty() : execute('put', {objects})),
		// merge([objects]) or merge(query, props)
		merge(objectsOrQuery, props) {
			if (Array.isArray(objectsOrQuery)) {
				return objectsOrQuery.length === 0 ? empty() : execute('merge', {objects: objectsOrQuery});
			}
			return execute('merge', {query: objectsOrQuery, props});
		},
		// del([ids]): db8 purges as it does by default. A delete by query goes in a batch here.
		del: ids => (ids.length === 0 ? empty() : execute('del', {ids})),
		batch: operations => execute('batch', {operations})
	};
}

module.exports = {createDb};
