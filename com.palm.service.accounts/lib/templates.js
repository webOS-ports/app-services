// Copyright (c) 2026 Herman van Hazendonk
// Derived from the old service's accounts.js and models/template-model.js,
// Copyright (c) 2009-2013 LG Electronics, Inc., and the globalization
// framework's locale.js and resources.js, Copyright (c) 2010-2013 LG
// Electronics, Inc., licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The account templates, read as the old service read them (accounts.js,
	models/template-model.js):

	- every *.json file directly in each subdirectory of each root, in the
	  order the directories list them; a file that cannot be listed or
	  stat'ed ends the walk of its root there;
	- each read in its localized form, as the globalization framework's
	  ResourceBundle found it (localized() below), parsed, taken as a list
	  when it is not one, and checked against schemas/template-file.json;
	- each template left out when the locale is not in its allowed_locales
	  or is in its disallowed_locales, checked against schemas/template.json,
	  its icon paths made absolute, and the first of a templateId kept;
	- a file that fails anywhere is logged and its templates from there on
	  are left out;
	- the list sorted by loc_name as the old one sorted it.

	Apps watch com.palm.signaling:1 in tempdb (appId
	"com.palm.accounts.templates") for the list of templateIds; signal()
	rewrites it when it changed, without waiting, as the old service did.
*/

const fs = require('fs');
const path = require('path');
const {validate} = require('./schema');

const TEMPLATE_ROOTS = [
	'/usr/palm/public/accounts',
	'/media/cryptofs/apps/usr/palm/accounts'
];
const SCHEMAS = path.join(__dirname, '..', 'schemas');
const TEMPDB = 'palm://com.palm.tempdb/';
const SIGNAL_APP = 'com.palm.accounts.templates';

// Globalization.Locale.parseLocaleString
function parseLocale(locale) {
	const ret = {};
	if (locale && locale.length > 0) {
		ret.language = locale.slice(0, 2);
		ret.locale = ret.language;
	} else {
		return ret;
	}
	if (locale.length >= 5) {
		ret.region = locale.slice(3, 5);
		ret.locale = ret.locale + '_' + ret.region;
	}
	if (locale.length >= 7) {
		ret.carrier = locale.substring(6);
		ret.locale = ret.locale + '_' + ret.carrier;
	}
	return ret;
}

/*
	The locale the globalization framework took for a service: the
	systemservice's languageCode_countryCode, cut to two letters each.
*/
function currentLocale(languageCode, countryCode) {
	const l = parseLocale(languageCode + '_' + countryCode);
	return l.language + '_' + l.region;
}

function loadFile(p) {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch (e) {
		return undefined;
	}
}

/*
	Globalization.ResourceBundle(locale, root).getLocalizedResource(file):
	the first non-empty one of resources/<lang>/<region>/<carrier>/,
	resources/<lang>/<region>/, resources/<lang>/, resources/<locale>/,
	resources/en/ and the root itself.
*/
function localized(root, locale, file) {
	const l = parseLocale(locale);
	const resources = root.charAt(root.length - 1) !== '/' ? root + '/resources' : root + 'resources';
	const language = resources + '/' + l.language;
	const region = language + '/' + l.region;
	const tries = [];
	if (l.carrier) {
		tries.push(region + '/' + l.carrier);
	}
	tries.push(region, language, resources + '/' + locale, resources + '/en', root);
	const rel = file.charAt(0) !== '/' ? '/' + file : file;
	for (const dir of tries) {
		const text = loadFile(dir + rel);
		if (text) {
			return {text, locale: l.locale || ''};
		}
	}
	return {text: undefined, locale: l.locale || ''};
}

function templatePaths(roots) {
	const json = /\.json$/i;
	const found = [];
	for (const root of roots) {
		try {
			for (const dir of fs.readdirSync(root)) {
				const dirPath = [root, dir].join('/');
				if (fs.statSync(dirPath).isDirectory()) {
					for (const file of fs.readdirSync(dirPath)) {
						const full = [dirPath, file].join('/');
						if (json.test(full) && fs.statSync(full).isFile()) {
							found.push({parent: dirPath, file});
						}
					}
				}
			}
		} catch (e) {
			// Did not find account templates here (no public synergy apps?)
		}
	}
	return found;
}

// models/template-model.js: AccountTemplate(copy, prefixPath)
function makeTemplate(copy, prefix, schema, log) {
	const result = validate(copy, schema);
	if (!result.valid) {
		log.log('validator errors=' + JSON.stringify(result.errors, undefined, 2));
		log.log('len=' + result.errors.length);
		throw new Error('validation errors in template: ' + copy.templateId + ' errors=' + JSON.stringify(result.errors));
	}
	const t = Object.assign({}, copy);
	if (prefix.substr(-1) !== '/') {
		prefix += '/';
	}
	const absolutize = icon => {
		if (icon === undefined) {
			return;
		}
		Object.keys(icon).forEach(key => {
			icon[key] = prefix + icon[key];
		});
	};
	absolutize(t.icon);
	if (t.capabilityProviders) {
		t.capabilityProviders.forEach(cp => absolutize(cp.icon));
	}
	return t;
}

function createTemplates({roots = TEMPLATE_ROOTS, schemas = SCHEMAS, pc, log = console} = {}) {
	// -> the templates, sorted
	function load(locale) {
		const paths = templatePaths(roots);
		// An object, as the old one had: a templateId such as "constructor" is taken for a duplicate.
		const hash = {};
		const fileSchema = JSON.parse(fs.readFileSync(path.join(schemas, 'template-file.json'), 'utf8'));
		const templateSchema = JSON.parse(fs.readFileSync(path.join(schemas, 'template.json'), 'utf8'));
		log.log('Found ' + paths.length + ' account templates');

		function add(parent, loc, obj) {
			if (obj.allowed_locales && !obj.allowed_locales.some(l => l === loc)) {
				log.log('Ignoring template ' + obj.templateId + ' because ' + loc + ' is not in allowed_locales');
				return;
			}
			if (obj.disallowed_locales && obj.disallowed_locales.some(l => l === loc)) {
				log.log('Ignoring template ' + obj.templateId + ' because ' + loc + ' is in disallowed_locales');
				return;
			}
			const t = makeTemplate(obj, parent, templateSchema, log);
			if (typeof hash[t.templateId] !== 'undefined') {
				log.log('*** WARNING: ignoring duplicate account template: ' + t.templateId);
			} else {
				hash[t.templateId] = t;
			}
		}

		for (const p of paths) {
			try {
				const {text, locale: loc} = localized(p.parent, locale, p.file);
				let list = JSON.parse(text);
				// a bare template, or (the old form) a list of them
				if (!Array.isArray(list)) {
					list = [list];
				}
				const result = validate(list, fileSchema);
				if (!result.valid) {
					throw new Error(p.parent + '/' + p.file + ' failed validation: ' + JSON.stringify(result.errors));
				}
				list.forEach(obj => add(p.parent, loc, obj));
			} catch (e) {
				log.error('Parse error for file: \'' + (p.parent + '/' + p.file) + '\', stack=\n' + e.stack);
			}
		}

		// _.values: integer-like ids first, in numeric order, then the others as they were added.
		const templates = Object.keys(hash).map(k => hash[k]);
		templates.sort((a, b) => {
			const nameA = (a.loc_name || '').toLocaleUpperCase();
			const nameB = (b.loc_name || '').toLocaleUpperCase();
			return nameA.localeCompare(nameB);
		});
		return templates;
	}

	/*
		The tempdb record apps watch, rewritten when the list of ids changed.
		current() is read when the find answers, as the old service read its
		list then (a reload in between is what it compares).
	*/
	function signal(current) {
		const query = {
			from: 'com.palm.signaling:1',
			where: [{prop: 'appId', op: '=', val: SIGNAL_APP}]
		};
		pc.call(TEMPDB + 'find', '', {query}).then(r => {
			const templates = current();
			const ids = templates.map(t => t.templateId).sort().toString();
			if (!r.results || !r.results[0] || ids !== r.results[0].templates) {
				log.log('There are ' + templates.length + ' templates. A template was added or deleted');
				// The put goes ahead whatever the delete answers, as it did.
				const put = () => pc.fire(TEMPDB + 'put', '', {
					objects: [{_kind: 'com.palm.signaling:1', appId: SIGNAL_APP, templates: ids}]
				});
				pc.call(TEMPDB + 'del', '', {query}).then(put, put);
			} else {
				log.log('There are ' + templates.length + ' templates, same as before.');
			}
		}, () => {});
	}

	return {load, signal};
}

module.exports = {createTemplates, parseLocale, currentLocale, localized, templatePaths, TEMPLATE_ROOTS};
