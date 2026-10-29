// Copyright (c) 2026 Herman van Hazendonk
// Derived from the contacts framework's AppPrefs.js, Copyright (c) 2009-2013
// LG Electronics, Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The contacts app's prefs record (com.palm.app.contacts.prefs:1), as the
	contacts framework's AppPrefs read and wrote it: the first record of the
	kind; when there is none, one with the defaults is put and the kind read
	again (without waiting for the put, as AppPrefs did not). A set merges
	the one property and is not waited for either.

	A find that fails leaves the prefs unread for good, as AppPrefs never
	called back then: whatever waits on them waits until its command times
	out.
*/

const KIND = 'com.palm.app.contacts.prefs:1';
const DEFAULTS = {listSortOrder: 'LAST_FIRST', defaultAccountId: '', contactsPhoneRegion: 'us'};
const PREF = {listSortOrder: 'listSortOrder', defaultAccountId: 'defaultAccountId',
	contactsPhoneRegion: 'contactsPhoneRegion'};

function createPrefs({db, log = console}) {
	// -> {get(name), set(name, value)} once the record is read.
	async function load() {
		for (;;) {
			let r;
			try {
				r = await db.findPage({from: KIND, limit: 2});
			} catch (e) {
				log.error('AppPrefs: reading ' + KIND + ' failed: ' + ((e && e.message) || e));
				return new Promise(() => {});
			}
			if (r.results.length === 0) {
				db.put([Object.assign({}, DEFAULTS, {_kind: KIND})]).catch(e => {
					log.error('AppPrefs: creating ' + KIND + ' failed: ' + ((e && e.message) || e));
				});
				continue;
			}
			const prefs = r.results[0];
			return {
				get(name) {
					let v = prefs;
					const parts = name.split('.');
					while (v && parts.length > 0) {
						v = v[parts.shift()];
					}
					return v;
				},
				set(name, value) {
					prefs[name] = value;
					db.merge([{_id: prefs._id, [name]: value}]).catch(e => {
						log.error('AppPrefs: setting ' + name + ' failed: ' + ((e && e.message) || e));
					});
				}
			};
		}
	}

	return {load};
}

module.exports = {createPrefs, KIND, DEFAULTS, PREF};
