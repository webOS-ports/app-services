// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	An account's credentials, in com.palm.keymanager, as the old service kept
	them (models/credentials-model_keymanager.js): one key per account, named
	by the account's _id, whose keydata is the JSON of {<name>: <credentials>}
	("common", "imap", ...). Nothing here logs a key's data.

	The calls go one at a time, in the order they were asked for, as the old
	service queued them: a put reads the key, removes it and stores it again,
	and two at once would each store what it read.

	- put(accountId, name, value): the store's reply. No key yet (fetchKey
	  failed): a new one. A key whose data is not JSON fails the put.
	- get(accountId, name): {credentials}, or throws {message, errorCode:
	  "CREDENTIALS_NOT_FOUND"} (a plain object, as the old one did) when there
	  is no key or no such name in it.
	- del(accountId): the remove's reply.
	- has(accountId): {value: whether keyInfo knows the key}.
*/

const KEYMGR = 'palm://com.palm.keymanager/';

function createKeyStore(pc) {
	let last = Promise.resolve();

	function queued(fn) {
		return (...args) => {
			const run = last.then(() => fn(...args));
			last = run.catch(() => {});
			return run;
		};
	}

	async function put(accountId, key, value) {
		let keydata;
		let fetched;
		try {
			fetched = await pc.call(KEYMGR, 'fetchKey', {keyname: accountId});
		} catch (e) {
			fetched = null;
		}
		if (fetched) {
			keydata = JSON.parse(fetched.keydata);
			// Remove the key with this accountId, so it can be replaced
			await pc.call(KEYMGR, 'remove', {keyname: accountId});
		} else {
			keydata = {};
		}
		keydata[key] = value;
		return pc.call(KEYMGR, 'store', {
			keyname: accountId,
			keydata: JSON.stringify(keydata),
			type: 'ASCIIBLOB',
			nohide: true
		});
	}

	async function get(accountId, key) {
		try {
			const r = await pc.call(KEYMGR, 'fetchKey', {keyname: accountId});
			const credentials = JSON.parse(r.keydata)[key];
			if (credentials) {
				return {credentials};
			}
		} catch (e) {
			// not found, as below
		}
		throw { // eslint-disable-line no-throw-literal
			message: 'Credentials for key \'' + key + '\' not found in account \'' + accountId + '\'',
			errorCode: 'CREDENTIALS_NOT_FOUND'
		};
	}

	function del(accountId) {
		return pc.call(KEYMGR, 'remove', {keyname: accountId});
	}

	async function has(accountId) {
		try {
			await pc.call(KEYMGR, 'keyInfo', {keyname: accountId});
			return {value: true};
		} catch (e) {
			return {value: false};
		}
	}

	return {put: queued(put), get: queued(get), del: queued(del), has: queued(has)};
}

module.exports = {createKeyStore};
