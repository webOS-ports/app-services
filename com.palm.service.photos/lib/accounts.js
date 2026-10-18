// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {EventEmitter} = require('events');

// The photo sources and whether each is busy, for subscribeToAccountsInfo.
// An account is "processing" while any of its causes is: a sync, a copy into
// it, a delete. "changed" is emitted with what the subscribers are sent: the
// whole list as {accounts: {...}} when an account comes or goes, else the one
// account whose status changed, which also carries the error of the work that
// just ended (once).
class AccountsManager extends EventEmitter {
	constructor() {
		super();
		this.accounts = new Map();
		this.accounts.set('local', newAccount({isEnabled: true}));
	}

	has(accountId) {
		return this.accounts.has(accountId);
	}

	get(accountId) {
		return this.accounts.get(accountId);
	}

	// The cloud accounts, as {accountId, username, templateId, isEnabled}
	remote() {
		const list = [];
		for (const [accountId, a] of this.accounts) {
			if (accountId !== 'local') {
				list.push({accountId, username: a.username, templateId: a.templateId, isEnabled: a.isEnabled});
			}
		}
		return list;
	}

	// Adds or updates accounts ({accountId, username, templateId, isEnabled})
	upsert(list) {
		let added = false;
		for (const item of [].concat(list)) {
			const a = this.accounts.get(item.accountId);
			if (!a) {
				this.accounts.set(item.accountId, newAccount(item));
				added = true;
				continue;
			}
			a.username = item.username || a.username;
			a.templateId = item.templateId || a.templateId;
			if (item.isEnabled !== undefined && a.isEnabled !== item.isEnabled) {
				a.isEnabled = item.isEnabled;
				this.emit('changed', this.view(item.accountId));
			}
		}
		if (added) {
			this.emit('changed', {accounts: this.snapshot()});
		}
	}

	remove(accountId) {
		if (accountId !== 'local' && this.accounts.delete(accountId)) {
			this.emit('changed', {accounts: this.snapshot()});
		}
	}

	setEnabled(accountId, isEnabled) {
		this.upsert({accountId, isEnabled});
	}

	// Work for an account starts; the returned function ends it, with the error if it failed.
	begin(accountId, cause) {
		const a = this.accounts.get(accountId);
		if (!a) {
			return () => {};
		}
		const token = Symbol(cause);
		a.work.set(token, cause);
		this.update(accountId);
		let ended = false;
		return error => {
			if (ended) {
				return;
			}
			ended = true;
			a.work.delete(token);
			if (error) {
				a.error = errorText(error);
			}
			this.update(accountId);
		};
	}

	// Runs fn as work of the account
	async track(accountId, cause, fn) {
		const end = this.begin(accountId, cause);
		try {
			const result = await fn();
			end();
			return result;
		} catch (e) {
			end(e);
			throw e;
		}
	}

	isBusy(accountId) {
		const a = this.accounts.get(accountId);
		return !!a && a.work.size > 0;
	}

	update(accountId) {
		const a = this.accounts.get(accountId);
		const status = a.work.size > 0 ? 'processing' : 'idle';
		if (status !== a.syncStatus) {
			a.syncStatus = status;
			this.emit('changed', this.view(accountId));
		}
	}

	// What a subscriber gets for one account; an error is handed out once.
	view(accountId) {
		const a = this.accounts.get(accountId);
		const v = {accountId, syncStatus: a.syncStatus, isEnabled: a.isEnabled};
		if (a.username !== undefined) {
			v.username = a.username;
		}
		if (a.templateId !== undefined) {
			v.templateId = a.templateId;
		}
		if (a.error && a.syncStatus === 'idle') {
			v.error = a.error;
			a.error = undefined;
		}
		return v;
	}

	snapshot() {
		const all = {};
		for (const accountId of this.accounts.keys()) {
			all[accountId] = this.view(accountId);
		}
		return all;
	}
}

function newAccount(item) {
	return {
		username: item.username,
		templateId: item.templateId,
		isEnabled: item.isEnabled !== false,
		syncStatus: 'idle',
		work: new Map(),
		error: undefined
	};
}

function errorText(error) {
	if (typeof error === 'string') {
		return error;
	}
	return (error && (error.message || error.errorText)) || String(error);
}

module.exports = {AccountsManager};
