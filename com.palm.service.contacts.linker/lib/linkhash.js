// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	A contact's link hash: the identity manual links, manual unlinks and the
	favourite and speed-dial backups are keyed on, made to survive a restore
	that gives contacts new _ids.

		<syncSource>|<remoteId>[|<account username>]
		<syncSource>|~~:(!)~~<_id>     for a contact with no remoteId

	The sync source is "SIM", "ATTBook" or "Local" (palmprofile) by kind, and
	for any other kind the id of the account's capability provider whose
	contact kind is the contact's, which takes a call to the accounts service
	(that call failing fails the hash, and whatever needed it).
*/

const {kindName, single} = require('./model');

const ACCOUNTS = 'luna://com.palm.service.accounts';
const LOCAL_ID_DELIM = '~~:(!)~~';

// The sync source of a SIM, AT&T or local contact; undefined for one of an account.
function localSource(contact) {
	switch (kindName(contact._kind)) {
	case 'com.palm.contact.sim':
		return {syncSource: 'SIM'};
	case 'com.palm.contact.attaddresssync':
		return {syncSource: 'ATTBook', remoteId: contact.remoteId};
	case 'com.palm.contact.palmprofile':
		return {syncSource: 'Local', remoteId: contact.remoteId};
	default:
		return undefined;
	}
}

function compose(contact, s) {
	let hash = s.remoteId ? s.syncSource + '|' + s.remoteId : s.syncSource + '|' + LOCAL_ID_DELIM + contact._id;
	hash += s.acctUsername ? '|' + s.acctUsername : '';
	return {linkHash: hash, shouldBackup: !!s.remoteId};
}

function createLinkHash({call}) {
	async function accountSource(contact) {
		const r = await call(ACCOUNTS + '/getAccountInfo', {accountId: single(contact.accountId)});
		if (!r.returnValue) {
			throw new Error('ContactLinkable.getRemoteContactHash failed because com.palm.service.accounts returned a falsy returnValue');
		}
		if (!r.result) {
			throw new Error('ContactLinkable.getRemoteContactHash failed because com.palm.service.accounts did not return a result.result');
		}
		const kind = String(contact._kind || '');
		const provider = (r.result.capabilityProviders || []).find(p => p && p.dbkinds && p.dbkinds.contact &&
			p.dbkinds.contact === kind);
		return {syncSource: provider ? provider.id : undefined, remoteId: contact.remoteId, acctUsername: r.result.username};
	}

	// -> {linkHash, shouldBackup}
	async function linkHash(contact) {
		return compose(contact, localSource(contact) || await accountSource(contact));
	}

	/*
		The hash of a SIM, AT&T or local contact at once, without waiting;
		undefined for any other. The framework had those at once too, and the
		code that caches hashes per contact relied on that to take a contact
		listed twice only once.
	*/
	function linkHashNow(contact) {
		const s = localSource(contact);
		return s ? compose(contact, s) : undefined;
	}

	return {linkHash, linkHashNow};
}

// The id part of a hash: "<syncSource>|<id>[|...]" -> <id>.
function idPart(hash) {
	return hash.split('|')[1];
}

module.exports = {createLinkHash, idPart, LOCAL_ID_DELIM};
