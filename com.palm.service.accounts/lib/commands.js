// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The bus methods of com.palm.service.accounts, each as the old service's
	command assistant ran it (handlers/*.js): the same calls in the same
	order, the same waits, the same replies and errors. README.md lists the
	old service's bugs that are kept here, by number; a comment marks each.

	Every method gets {args, ctx}: ctx is the bus's (appId, sender, ...).
	run(name, params, ctx) is what service.js puts on the bus.
*/

const fs = require('fs');
const _ = require('./under');
const {mapReduce} = require('./palmcall');
const M = require('./model');

const SERVICE = 'com.palm.service.accounts';
const SELF = 'palm://com.palm.service.accounts/';
const TEMPDB = 'palm://com.palm.tempdb/';
const KIND = M.KIND;
const SYNCSTATE = 'com.palm.account.syncstate:1';
const PROFILE = 'com.palm.palmprofile';
const FLAG = '/var/luna/preferences/first-use-profile-created';

// services.json's commandTimeout of each method, in seconds (60 for the others).
const TIMEOUTS = {
	createAccount: 20,
	modifyAccount: 3600,
	deleteAccount: 20,
	notifyAccountCreated: 3600,
	notifyAccountDeleted: 3600,
	stayRunning: 3600,
	createLocalAccount: 20
};

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// A wait that never ends: where the old command's chain stopped for good (its future never set).
const STALL = () => new Promise(() => {});

/*
	Calls made all at once, the next step taken once every one has answered
	with success. One that fails is logged and the step is never taken, as
	the old count never reached its end (README: B1).
*/
function allSucceed(calls, log) {
	return new Promise(resolve => {
		let ok = 0;
		const len = calls.length;
		for (const {call, what} of calls) {
			call().then(r => {
				if (r.returnValue || r === true) {
					log.log(what + ' was successful');
					if (++ok === len) {
						resolve({});
					}
				} else {
					log.log(what + ' failed:' + JSON.stringify(r));
				}
			}, () => {});
		}
	});
}

function TransportError(failed) {
	this.failed = failed;
}

function createCommands({db, pc, keystore, templates, reloadTemplates, log = console, flagPath = FLAG}) {
	const getTemplates = () => templates();

	// Utils.saveCredentials: each named set of credentials stored; the first failure fails it.
	function saveCredentials(accountId, credentials) {
		if (credentials) {
			return mapReduce(Object.keys(credentials), k => keystore.put(accountId, k, credentials[k]));
		}
		return Promise.resolve(undefined);
	}

	// ---- listAccountTemplates (handlers/list-templates.js)
	function listAccountTemplates(args) {
		let list = getTemplates();
		function capabilityMatch(c) {
			if (!Array.isArray(args.capability)) {
				return c.capability === args.capability;
			}
			for (let i = 0; i < args.capability.length; i++) {
				if (c.capability === args.capability[i]) {
					return true;
				}
			}
			return false;
		}
		if (args.capability) {
			list = list.filter(t => t.capabilityProviders.some(capabilityMatch));
		}
		return {results: list};
	}

	// ---- listAccounts, listAccountsPublic (handlers/list-accounts.js)
	async function listAccounts(args, ctx) {
		const senderId = ctx.appId;
		const eq = (prop, val) => ({prop, op: '=', val});
		let where;
		if (args.templateId) {
			where = [eq('templateId', args.templateId)];
			log.log('ListAccounts: templateId=' + args.templateId + ' by ' + senderId);
		} else if (args.capability) {
			where = [eq('capabilityProviders.capability', args.capability)];
			log.log('ListAccounts: capability=' + args.capability + ' by ' + senderId);
		} else {
			where = [];
			log.log('ListAccounts: no template or capability by ' + senderId);
		}
		where.push(eq('beingDeleted', false));
		const found = await db.find({from: KIND, where});
		const list = getTemplates();
		const results = found.results.map(M.account);
		const annotated = [];
		for (const a of results) {
			try {
				annotated.push(M.annotate(a, list, log));
			} catch (e) {
				log.log('ListAccounts: Skipping account because template ' + a.templateId + ' is missing');
			}
		}
		return {results: annotated};
	}

	function listAccountsPublic(args, ctx) {
		if (M.publicByIdAndCapability(ctx.appId, args.capability)) {
			return listAccounts(args, ctx);
		}
		throw M.permissionDenied();
	}

	// ---- getAccountInfo (handlers/get-account-info.js)
	async function getAccountInfo(args, ctx) {
		const got = await db.get([args.accountId]);
		const result = got.results;
		M.assertRequire(result && result.length);
		const annotated = M.annotate(M.account(result[0]), getTemplates(), log);
		M.hasPermission('readPermissions', annotated, ctx, log);
		return {result: annotated};
	}

	// ---- createAccount (handlers/create.js)

	// Every validator asked at once; the replies laid over each other in the order they came.
	function checkPassword(account, password, validators, config) {
		function validate(v) {
			const pos = v.lastIndexOf('/');
			if (pos === -1) {
				throw new Error('invalid validator: ' + v);
			}
			return pc.call(v.substring(0, pos + 1), v.substring(pos + 1), {
				username: account.username,
				password,
				templateId: account.templateId,
				config
			});
		}
		// B2: a validator that fails is logged and left out; the account is made all the same.
		function aggregate(results) {
			const acc = {};
			const creds = {};
			results.forEach(r => {
				if (r.result) {
					_.extend(acc, r.result);
					_.extend(creds, r.result.credentials);
				} else {
					log.warn('validator returned error: ' + r.exception);
				}
			});
			acc.credentials = creds;
			return acc;
		}
		return mapReduce(validators, validate, aggregate);
	}

	async function createAccount(args, ctx) {
		const selected = [];
		let credentials = args.credentials;
		let config = args.config;

		M.assertRequire(args.templateId, 'missing templateId');
		M.assertRequire(args.capabilityProviders && Array.isArray(args.capabilityProviders), 'missing capabilityProviders');
		M.assertRequire(args.username, 'missing username');
		M.assertRequire(!(args.password && args.credentials), 'can\'t have both password and credentials');

		const template = _.detect(getTemplates(), t => t.templateId === args.templateId);
		if (!template) {
			throw new Error('no account template for id=' + args.templateId);
		}
		if (template.validator) {
			M.assertRequire(typeof args.password === 'string' || typeof args.credentials === 'object');
		}
		M.hasPermission('writePermissions', template, ctx, log);

		// The requested providers the template has, each once.
		for (let i = 0; i < args.capabilityProviders.length; i++) {
			const cap = args.capabilityProviders[i];
			if (_.pluck(selected, 'id').indexOf(cap.id) !== -1) {
				continue;
			}
			let found = false;
			for (let j = 0; j < template.capabilityProviders.length; j++) {
				if (cap.id === template.capabilityProviders[j].id) {
					M.assertRequire(template.capabilityProviders[j].capability, 'capability missing!');
					selected.push(template.capabilityProviders[j]);
					found = true;
					break;
				}
			}
			if (!found) {
				log.log('Requested capability provider: ' + cap.id + ' not found, ignoring');
			}
		}

		const dup = await db.find({
			from: KIND,
			where: [
				{prop: 'beingDeleted', op: '=', val: false},
				{prop: 'templateId', op: '=', val: template.templateId},
				{prop: 'username', op: '=', val: args.username}
			]
		});
		if (dup.results && dup.results.length > 0) {
			// A plain object, as the old one set: its reply's exception is "[object Object]".
			throw {message: 'Unable to create a duplicate account', errorCode: 'DUPLICATE_ACCOUNT'}; // eslint-disable-line no-throw-literal
		}

		const account = {_kind: KIND};
		account.templateId = template.templateId;
		account.username = args.username;
		account.alias = args.alias;
		account.beingDeleted = false;
		account.capabilityProviders = selected.map(c => ({id: c.id, capability: c.capability}));
		if (typeof args._sync !== 'undefined') {
			account._sync = args._sync;
		}

		let checked;
		if (args.password) {
			const validators = [template.validator];
			selected.forEach(c => {
				if (c.validator) {
					validators.push(c.validator);
				}
			});
			checked = await checkPassword(account, args.password, validators, config);
		}
		if (checked) {
			credentials = checked.credentials;
			if (checked.config) {
				config = checked.config;
			}
		}

		const put = await db.put([account]);
		account._id = put.results[0].id;
		await saveCredentials(account._id, credentials);

		// Kick off the transports' onCreate / onEnabled in the background, and answer now.
		pc.fire(SELF + 'notifyAccountCreated', '', {accountId: account._id, config});
		return {result: account};
	}

	// ---- readCredentials, readCredentialsPublic, writeCredentials, hasCredentials (handlers/credentials.js)
	async function readCredentials(args, ctx) {
		log.log('ReadCredentialsCommandAssistant: id=' + args.accountId);
		const got = await db.get([args.accountId]);
		const result = got.results;
		M.assertRequire(result && result.length);
		const account = result[0];
		const template = _.detect(getTemplates(), t => t.templateId === account.templateId);
		M.hasPermission('readPermissions', template, ctx, log);
		return keystore.get(args.accountId, args.name);
	}

	function readCredentialsPublic(args, ctx) {
		if (M.publicById(ctx.appId)) {
			return readCredentials(args, ctx);
		}
		throw M.permissionDenied();
	}

	async function writeCredentials(args, ctx) {
		log.log('WriteCredentialsCommandAssistant: id=' + args.accountId);
		const got = await db.get([args.accountId]);
		const result = got.results;
		M.assertRequire(result && result.length);
		const annotated = M.annotate(M.account(result[0]), getTemplates(), log);
		M.hasPermission('writePermissions', annotated, ctx, log);
		await keystore.put(args.accountId, args.name, args.credentials);

		// onCredentialsChanged of the template and of the enabled providers, not waited for.
		const params = {accountId: args.accountId};
		if (annotated.onCredentialsChanged) {
			pc.fire(annotated.onCredentialsChanged, '', params);
		}
		annotated.capabilityProviders.forEach(cp => {
			if (cp.onCredentialsChanged && cp._id) {
				pc.fire(cp.onCredentialsChanged, '', params);
			}
		});
		return {};
	}

	function hasCredentials(args) {
		log.log('HasCredentialsCommandAssistant: id=' + args.accountId);
		return keystore.has(args.accountId);
	}

	// ---- deleteAccount (handlers/delete.js)
	async function deleteAccount(args, ctx) {
		log.log('DeleteCommandAssistant: deleting account ' + args.accountId);
		const got = await db.get([args.accountId]);
		const result = got.results;
		if (!result || !result.length) {
			log.log('Unable to find account ' + args.accountId);
			throw new Error('Unable to find account');
		}
		const account = M.account(result[0]);
		if (account._del) {
			log.log('Account has been deleted ' + args.accountId);
			throw new Error('Account has been deleted');
		}
		if (account.beingDeleted) {
			log.log('Account is being deleted ' + args.accountId);
			throw new Error('Account is being deleted');
		}
		const annotated = M.annotate(account, getTemplates(), log);
		M.hasPermission('writePermissions', annotated, ctx, log);

		// Hidden from the lists at once; a little time for the apps to update them.
		await db.merge([{_id: args.accountId, beingDeleted: true}]);
		await sleep(1500);

		// A "Removing Account" dashboard: syncState DELETE for the account.
		await pc.call(TEMPDB + 'put', '', {
			objects: [{
				_kind: SYNCSTATE,
				accountId: args.accountId,
				syncState: 'DELETE',
				capabilityProvider: SERVICE
			}]
		});

		// The deletion itself in the background; keepData goes on to the onDelete handlers.
		pc.fire(SELF + 'notifyAccountDeleted', '', {accountId: args.accountId, keepData: args.keepData});
		log.log('DeleteCommandAssistant: deleted account ' + args.accountId);
		return {};
	}

	// ---- modifyAccount (handlers/modify.js)
	function diffLists(oldList, newList) {
		const missing = (other, list) => list.filter(item => other.indexOf(item) === -1);
		return {add: missing(oldList, newList), remove: missing(newList, oldList)};
	}

	function notifyTransports(transports) {
		return mapReduce(transports, t => pc.call(t.address, '', t.params), results => {
			const failed = results.filter(r => r.exception);
			if (failed.length > 0) {
				throw new TransportError(failed);
			}
			return {};
		});
	}

	function providersArray(template, ids) {
		if (template && ids && Array.isArray(ids)) {
			return ids.map(newCp => {
				const cp = _.detect(template.capabilityProviders, c => c.id === newCp.id);
				return {id: cp.id, capability: cp.capability};
			});
		}
		return undefined;
	}

	async function modifyAccount(args, ctx) {
		const newAccount = args.object;
		const list = getTemplates();
		log.log('ModifyCommandAssistant: id=' + args.accountId);

		// New credentials: clear the account's sync states, so that credential dashboards go.
		if (newAccount.credentials) {
			try {
				await pc.call(TEMPDB + 'del', '', {
					query: {from: SYNCSTATE, where: [{prop: 'accountId', op: '=', val: args.accountId}]}
				});
			} catch (e) {
				// The old next step read the record without looking at this: the read went out, and the
				// command failed with this error all the same.
				db.get([args.accountId]).catch(() => {});
				throw e;
			}
		}

		const got = await db.get([args.accountId]);
		const result = got.results;
		M.assertRequire(result && result.length);
		const account = result[0];
		const template = _.detect(list, t => t.templateId === account.templateId);
		M.hasPermission('writePermissions', template, ctx, log);

		const had = await keystore.has(account._id);
		if (had.value && newAccount.credentials) {
			await keystore.del(account._id);
		}
		await saveCredentials(account._id, newAccount.credentials);

		let diff;
		if (newAccount.capabilityProviders) {
			diff = diffLists(_.pluck(account.capabilityProviders, 'id'), _.pluck(newAccount.capabilityProviders, 'id'));
		} else {
			diff = {add: [], remove: []};
		}

		// B4: refused only now, with the new credentials already stored.
		if (template && diff.remove.length > 0) {
			const reject = diff.remove.some(id => {
				const match = _.detect(template.capabilityProviders, c => c.id === id);
				return match && match.alwaysOn;
			});
			if (reject) {
				const e = new Error('can\'t disable \'alwaysOn\' capabilities');
				e.errorCode = '400_BAD_REQUEST';
				throw e;
			}
		}

		await db.merge([{
			_id: args.accountId,
			username: newAccount.username,
			alias: newAccount.alias,
			capabilityProviders: providersArray(template, newAccount.capabilityProviders)
		}]);

		const changed = diff.add.length + diff.remove.length !== 0;
		try {
			if (changed && template && template.onCapabilitiesChanged) {
				await pc.call(template.onCapabilitiesChanged, '', {
					accountId: args.accountId,
					capabilityProviders: M.providerStates(template, newAccount.capabilityProviders)
				});
			}

			// New credentials: onCredentialsChanged to the template and the providers kept enabled.
			if (newAccount.credentials && !args.suppressNotifications) {
				const params = {accountId: args.accountId};
				// B5: diff.add holds ids, so this is a list of undefined and no provider is left out.
				const addedIds = _.pluck(diff.add, 'id');
				const transports = [];
				if (template && template.onCredentialsChanged) {
					transports.push({address: template.onCredentialsChanged, params});
				}
				const providers = newAccount.capabilityProviders || account.capabilityProviders;
				providers.forEach(cp => {
					if (template && addedIds.indexOf(cp.id) === -1) {
						const provider = _.detect(template.capabilityProviders, c => c.id === cp.id);
						if (provider && provider.onCredentialsChanged) {
							transports.push({address: provider.onCredentialsChanged, params, capabilityProviderId: provider.id});
						}
					}
				});
				await notifyTransports(transports);
			}

			// onEnabled true / false to the providers turned on / off.
			if (changed) {
				const transports = [];
				// B6: one params object per list, so each call carries the last id given to it.
				const toBusCalls = params => id => {
					if (template) {
						const provider = _.detect(template.capabilityProviders, c => c.id === id);
						if (provider && provider.onEnabled) {
							params.capabilityProviderId = id;
							transports.push({address: provider.onEnabled, params, capabilityProviderId: provider.id});
						}
					}
				};
				diff.add.forEach(toBusCalls({accountId: args.accountId, enabled: true}));
				diff.remove.forEach(toBusCalls({accountId: args.accountId, enabled: false}));
				await notifyTransports(transports);
			}
		} catch (e) {
			if (!(e instanceof TransportError)) {
				throw e;
			}
			// A transport failed: flip the failed providers back, and fail with TRANSPORT_FAILURE (B7).
			const failed = e.failed;
			const err = failed[0].exception;
			const cpIds = _.pluck(newAccount.capabilityProviders, 'id');
			failed.forEach(bad => {
				const idx = cpIds.indexOf(bad.item.capabilityProviderId);
				if (idx !== -1) {
					cpIds.splice(idx, 1);
				} else {
					cpIds.push(bad.item.capabilityProviderId);
				}
			});
			const newCps = providersArray(template, cpIds.map(id => ({id})));
			const saved = transportFailure('Failed to notify transports: ' + failed.map(r => r.item.address).join(','), err);
			await db.merge([{_id: args.accountId, capabilityProviders: newCps}]);
			throw saved;
		}
		return {};
	}

	// Foundations.Err.create("TRANSPORT_FAILURE", msg, inner)
	function transportFailure(msg, inner) {
		const e = new Error(msg);
		e.errorCode = 'TRANSPORT_FAILURE';
		e.innerError = inner;
		return e;
	}

	// ---- notifyAccountCreated (handlers/notify-created.js)
	async function notifyAccountCreated(args) {
		log.log('notifyAccountCreated: letting transports know of new account ' + args.accountId);
		const got = await db.get([args.accountId]);
		// A little time for the UI to show the new account.
		await sleep(1000);
		const result = got.results;
		M.assertRequire(result && result.length);
		let annotated;
		try {
			annotated = M.annotate(result[0], getTemplates(), log);
		} catch (e) {
			log.log('ServiceAccounts::CREATE - Annotate failed = ' + JSON.stringify(e));
		}

		const onCreates = _.compact(_.pluck(annotated.capabilityProviders, 'onCreate'));
		if (onCreates.length) {
			await allSucceed(onCreates.map(address => {
				log.log('Calling onCreate ' + address + ' account=' + args.accountId);
				return {what: 'onCreate for ' + address, call: () => pc.call(address, '', {accountId: args.accountId, config: args.config})};
			}), log);
		} else {
			log.log('onCreate: no onCreate methods for ' + annotated.templateId);
		}

		const onEnabled = annotated.capabilityProviders.filter(cp => !!cp.onEnabled && cp._id);
		if (onEnabled.length) {
			await allSucceed(onEnabled.map(cp => {
				log.log('Calling ' + cp.onEnabled + ' cap=' + cp.id + ' account=' + args.accountId + ' enabled=true');
				return {what: 'onEnabled for ' + cp.onEnabled, call: () => pc.call(cp.onEnabled, '', {
					accountId: args.accountId, capabilityProviderId: cp.id, enabled: true})};
			}), log);
		}

		if (annotated.onCapabilitiesChanged) {
			log.log('Calling onCapabilitiesChanged: ' + annotated.onCapabilitiesChanged);
			const template = _.detect(getTemplates(), t => t.templateId === annotated.templateId);
			await pc.call(annotated.onCapabilitiesChanged, '', {
				accountId: annotated._id,
				capabilityProviders: M.providerStates(template, annotated.capabilityProviders)
			});
		}
		log.log('notifyAccountCreated: transports have been notified ' + args.accountId);
		return {};
	}

	// ---- notifyAccountDeleted (handlers/notify-deleted.js)
	async function notifyAccountDeleted(args) {
		log.log('notifyAccountDeletedCommandAssistant: deleting account ' + args.accountId);
		const got = await db.get([args.accountId]);
		// A little time for the UI to show the account going.
		await sleep(2000);
		const result = got.results;
		M.assertRequire(result && result.length);
		const account = result[0];
		let annotated;
		try {
			annotated = M.annotate(account, getTemplates(), log);
		} catch (e) {
			log.log('ServiceAccounts::DELETE - Annotate failed = ' + JSON.stringify(e));
		}

		const onEnabled = annotated.capabilityProviders.filter(cp => !!cp.onEnabled && cp._id);
		if (onEnabled.length) {
			await allSucceed(onEnabled.map(cp => {
				log.log('Calling ' + cp.onEnabled + ' cap=' + cp.id + ' account=' + args.accountId + ' enabled=false');
				return {what: 'onEnabled for ' + cp.onEnabled, call: () => pc.call(cp.onEnabled, '', {
					accountId: args.accountId, capabilityProviderId: cp.id, enabled: false})};
			}), log);
		} else {
			log.log('No capabilities were enabled for account ' + args.accountId);
		}

		const template = _.detect(getTemplates(), t => t.templateId === account.templateId);
		if (template) {
			// Every provider of the template is told, enabled or not.
			const onDeletes = _.compact(_.pluck(template.capabilityProviders, 'onDelete'));
			if (onDeletes.length) {
				await allSucceed(onDeletes.map(address => {
					log.log('Calling onDelete ' + address + ' account=' + args.accountId + ' keepData=' + (args.keepData === true));
					return {what: 'onDelete for ' + address, call: () => pc.call(address, '', {
						accountId: args.accountId,
						keepData: args.keepData,
						alias: account.alias,
						templateId: account.templateId
					})};
				}), log);
			} else {
				log.log('onDelete: no onDelete methods for template ' + account.templateId);
			}
		} else {
			log.log('onDelete: no template for ' + account.templateId);
		}

		const has = await keystore.has(account._id);
		if (has.value) {
			await keystore.del(account._id);
		}
		await pc.call(TEMPDB + 'del', '', {
			query: {from: SYNCSTATE, where: [{prop: 'accountId', op: '=', val: args.accountId}]}
		});
		await db.del([args.accountId]);
		log.log('notifyAccountDeletedCommandAssistant: deleted account ' + args.accountId);
		return {};
	}

	// ---- stayRunning (handlers/running.js)
	async function stayRunning(args) {
		let timeout = 30;
		if (args && args.seconds) {
			timeout = (args.seconds > 3600) ? 3600 : args.seconds;
		}
		log.log('Accounts service running for ' + timeout + ' seconds ...');
		await sleep(timeout * 1000);
		resumeAccountDeletes().catch(() => {});
		log.log('Accounts service stopping after running for ' + timeout + ' seconds (this is normal)');
		return {};
	}

	// Deletes that were cut off, called again, five times at most for each account.
	async function resumeAccountDeletes() {
		log.log('resumeAccountDeletes: Any to delete?');
		const r = await db.find({from: KIND, where: [{prop: 'beingDeleted', op: '=', val: true}]});
		const accounts = r.results.filter(a => !a.retries || a.retries < 5);
		if (accounts.length === 0) {
			log.log('resumeAccountDeletes: No accounts to delete');
			return;
		}
		log.log('resumeAccountDeletes: Num accounts=' + accounts.length);
		await db.merge(accounts.map(acct => {
			acct.retries = acct.retries ? acct.retries + 1 : 1;
			return {_id: acct._id, retries: acct.retries};
		}));
		// B8: keepData is not known any more here, so a resumed delete wipes the account's data.
		await mapReduce(accounts, acct => {
			log.log('resumeAccountDeletes: resuming delete of account, id=' + acct._id + ', this is retry #' + acct.retries);
			return pc.call(SELF, 'notifyAccountDeleted', {accountId: acct._id});
		});
		log.log('resumeAccountDeletes: done');
	}

	// ---- setPrefs (handlers/set-prefs.js)
	function setPrefs(args) {
		if (args && args.deviceName) {
			// The device name, changed in Device Info, kept on the profile account.
			pc.fire('palm://com.palm.db/merge', '', {
				props: {deviceName: args.deviceName},
				query: {from: KIND, where: [
					{prop: 'templateId', op: '=', val: PROFILE},
					{prop: 'beingDeleted', op: '=', val: false}
				]}
			});
		}
		return {};
	}

	// ---- restoreCompleted, accountsChanged (handlers/restore-completed.js)
	async function restoreCompleted() {
		log.log('RestoreCompletedCommandAssistant');
		const list = getTemplates();
		const toCall = [];
		const all = await db.find({from: KIND});
		const accounts = all.results;

		// onCapabilitiesChanged and onEnabled for every account, so the transports set up their syncs.
		let i = accounts.length;
		while (i--) {
			let account = M.account(accounts[i]);
			if (account.beingDeleted) {
				continue;
			}
			const template = _.detect(list, t => t.templateId === account.templateId);
			if (!template) {
				continue;
			}
			account = M.annotate(account, [template], log);
			if (account.onCapabilitiesChanged) {
				toCall.push({address: account.onCapabilitiesChanged, params: {
					accountId: account._id,
					capabilityProviders: M.providerStates(template, account.capabilityProviders)
				}});
			}
			let j = account.capabilityProviders.length;
			while (j--) {
				const cp = account.capabilityProviders[j];
				if (cp.onEnabled) {
					toCall.push({address: cp.onEnabled, params: {accountId: account._id, capabilityProviderId: cp.id, enabled: true}});
				}
			}
			// The profile account has every capability of its template enabled.
			if (account.templateId === PROFILE) {
				const cpArray = (template.capabilityProviders && Array.isArray(template.capabilityProviders)) ?
					template.capabilityProviders.map(cap => ({id: cap.id, capability: cap.capability})) : [];
				db.merge([{_id: account._id, capabilityProviders: cpArray}]).catch(() => {});
			}
		}

		// Waited for, so that the device does not reset after an OTA before the syncs are set up.
		await mapReduce(toCall, c => pc.call(c.address, '', c.params), results => {
			let k = results.length;
			while (k--) {
				if (results[k].exception) {
					log.warn('WARNING: Transport \'onCapabilitiesChanged/onEnabled\' service call failed. call=' +
						results[k].item + ' error=' + results[k].exception);
				}
			}
			return {};
		});

		// Telephony accounts that sync, and accounts being deleted, are deleted.
		const toDelete = accounts.filter(a => {
			if (a.templateId === 'com.palm.telephony' && a._sync) {
				log.log('Deleting unused telephony account ' + a._id);
				return true;
			}
			if (a.beingDeleted) {
				log.log('Deleting ' + a.templateId + ' account beingDeleted ' + a._id);
				return true;
			}
			return false;
		});
		for (const a of toDelete) {
			db.del([a._id]).catch(() => {});
		}

		// The device name, kept on the profile account for the account lists.
		const prefs = await pc.call('palm://com.palm.systemservice/getPreferences', '', {keys: ['deviceName']});
		const deviceName = prefs.deviceName || '';
		pc.fire('palm://com.palm.db/merge', '', {
			props: {deviceName},
			query: {from: KIND, where: [
				{prop: 'templateId', op: '=', val: PROFILE},
				{prop: 'beingDeleted', op: '=', val: false}
			]}
		});
		return {};
	}

	// ---- appsChanged (handlers/apps-changed.js): an app came or went; read the templates again.
	async function appsChanged() {
		await reloadTemplates();
		return {};
	}

	// ---- createLocalAccount (handlers/create-local-account.js): the profile account when first use was skipped.
	async function createLocalAccount() {
		const r = await pc.call('palm://com.palm.service.accounts', 'listAccounts', {templateId: PROFILE});
		if (r.results.length === 0) {
			makeLocalAccount('LuneOS');
			return {returnValue: true, accountCreated: true};
		}
		return {returnValue: true, accountCreated: false};
	}

	function makeLocalAccount(username) {
		const account = {
			templateId: PROFILE,
			capabilityProviders: [
				{id: 'com.palm.palmprofile.contacts'},
				{id: 'com.palm.palmprofile.calendar'},
				{id: 'com.palm.palmprofile.tasks'},
				{id: 'com.palm.palmprofile.memos'},
				{id: 'com.palm.palmprofile.sms'},
				{id: 'com.palm.palmprofile.voice'},
				{id: 'com.palm.palmprofile.localfilestore'}
			],
			username,
			credentials: {}
		};
		log.log('Creating a palmprofile account with username:' + username);
		pc.call(SELF, 'createAccount', account).then(created => {
			log.log('----------- local acct created successfully ------------' + JSON.stringify(created.result && created.result._id));
			// The flag that tells the upstart job the profile account is there.
			try {
				fs.closeSync(fs.openSync(flagPath, 'w'));
			} catch (e) {
				log.error('could not write ' + flagPath + ': ' + e.message);
			}
		}, e => {
			log.log('----------- local acct creation failed ------------' + JSON.stringify(e));
		});
	}

	const methods = {
		listAccountTemplates, listAccounts, listAccountsPublic, getAccountInfo, createAccount,
		modifyAccount, deleteAccount, readCredentials, readCredentialsPublic, writeCredentials,
		hasCredentials, restoreCompleted, accountsChanged: restoreCompleted, appsChanged, setPrefs,
		notifyAccountCreated, notifyAccountDeleted, stayRunning, createLocalAccount
	};
	return {methods, saveCredentials, STALL};
}

module.exports = {createCommands, TIMEOUTS, SERVICE, FLAG, TransportError};
