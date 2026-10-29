// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's models/account-model.js, utils.js and
// publicwhitelist.js, Copyright (c) 2009-2013 LG Electronics, Inc., licensed
// under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The account record and the rules around it, as the old service had them
	(models/account-model.js, utils.js, publicwhitelist.js).
*/

const _ = require('./under');

const KIND = 'com.palm.account:1';

/*
	Account.annotate: the account (changed in place) with its template laid
	over it, template properties winning, and each of its capability
	providers with the template's provider of that id laid over it. Throws
	"template not found: <id>" when no template has its templateId.
*/
function annotate(acct, templates, log = console) {
	const templateId = acct.templateId;
	const template = _.detect(templates, t => t.templateId === templateId);
	if (!template) {
		throw new Error('template not found: ' + templateId);
	}
	const subset = acct.capabilityProviders;
	const result = _.extend(acct, template);
	result.capabilityProviders = subset;
	result.capabilityProviders = result.capabilityProviders.map(c => {
		const tmplCap = _.detect(template.capabilityProviders, tc => tc.id === c.id);
		if (!tmplCap) {
			log.warn('capability provider not found: ' + c.id + ' for template: ' + template.templateId);
			return c;
		}
		return _.extend(c, tmplCap);
	});
	return result;
}

// new Account() with a record's properties over it.
function account(record) {
	return _.extend({_kind: KIND}, record);
}

// Utils.getProviderStates: each of the template's providers, and whether it is among those given.
// (The names are the old ones: a TypeError's text names them, and a command answers with it.)
function providerStates(template, enabledCapabilities) {
	return template.capabilityProviders.map(cp => ({
		id: cp.id,
		enabled: enabledCapabilities.some(s => s.id === cp.id)
	}));
}

// Utils.createRegexFromGlob: * any run, ? one character, . and \ literal; nothing else escaped.
function regexFromGlob(glob) {
	let out = '^';
	for (let i = 0; i < glob.length; ++i) {
		const c = glob.charAt(i);
		switch (c) {
		case '*': out += '.*'; break;
		case '?': out += '.'; break;
		case '.': out += '\\.'; break;
		case '\\': out += '\\\\'; break;
		default: out += c;
		}
	}
	return out + '$';
}

// "[appid processid]": a WAM app's id came with its process number (DFISH-5527).
function stripProcess(id) {
	const space = id.indexOf(' ');
	return space !== -1 ? id.substr(0, space) : id;
}

/*
	Utils.hasPermission: true for the accounts app and service, and for a
	caller matching one of the template's (or annotated account's) globs in
	`permissions` ("readPermissions" / "writePermissions"); else it throws
	"Permission denied! ..." with errorCode "". ctx: the bus's, whose appId
	and sender are the message's applicationID and senderServiceName.
*/
function hasPermission(permissions, acct, ctx, log = console) {
	let caller = ctx ? ctx.appId || ctx.sender : '';
	caller = stripProcess(caller);
	if (caller === 'com.palm.app.accounts' || caller === 'com.palm.service.accounts') {
		return true;
	}
	const p = acct[permissions];
	if (p && p.some(permit => new RegExp(regexFromGlob(permit)).test(caller))) {
		return true;
	}
	const msg = 'Permission denied! ' + caller + ' is not specified in template ' + acct.templateId + ' ' + permissions;
	log.log(msg);
	const e = new Error(msg);
	e.errorCode = '';
	throw e;
}

// publicwhitelist.js: the apps that may call the *Public methods, and for which capability.
const WHITELIST = [
	{id: 'com.quickoffice.webos', capability: 'documents'},
	{id: 'com.quickoffice.ar', capability: 'documents'}
];

function whitelisted(id) {
	const stripped = stripProcess(id);
	return WHITELIST.find(w => w.id === stripped);
}

const publicById = id => whitelisted(id) !== undefined;

function publicByIdAndCapability(id, capability) {
	const p = whitelisted(id);
	return !!(p && capability && p.capability === capability.toLowerCase());
}

function permissionDenied() {
	const e = new Error('Permission denied.');
	e.errorCode = '';
	return e;
}

// Foundations' Assert.require
function assertRequire(cond, msg) {
	if (!cond) {
		throw new Error(msg || 'Assert.require failed');
	}
}

module.exports = {KIND, annotate, account, providerStates, regexFromGlob, stripProcess, hasPermission,
	publicById, publicByIdAndCapability, permissionDenied, assertRequire, WHITELIST};
