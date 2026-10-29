// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The two loadable frameworks the contacts services cannot do without, run
	as they are: Globalization (phone number parsing and comparison, name
	formatting, the sort name, isLetter) and phonenumberlib (the parse the
	contacts framework keys a stored phone number on). Their scores and keys
	decide what links and what a phone number finds, so they are not
	rewritten here (this file is the contacts linker's); they are loaded from where
	the device has them, each in a vm context of its own with the little of
	Foundations and underscore they use.

	A root is either a device frameworks directory
	(/usr/palm/frameworks/<name>/version/1.0/) or a loadable-frameworks
	checkout (<root>/<name>/).
*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEVICE_ROOT = '/usr/palm/frameworks';

function frameworkDir(root, name) {
	const device = path.join(root, name, 'version', '1.0');
	if (fs.existsSync(path.join(device, 'manifest.json'))) {
		return device;
	}
	const checkout = path.join(root, name);
	if (fs.existsSync(path.join(checkout, 'manifest.json'))) {
		return checkout;
	}
	throw new Error('framework ' + name + ' not found under ' + root);
}

function sources(dir) {
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
	return manifest.files.javascript.map(f => fs.readFileSync(path.join(dir, 'javascript', f), 'utf8'));
}

// Foundations.Class.create as Globalization uses it: initialize, inheritance, and $super.
function createClass(parent, methods) {
	if (!methods) {
		methods = parent;
		parent = null;
	}
	const Klass = function () {
		if (this.initialize) {
			this.initialize.apply(this, arguments);
		}
	};
	if (parent) {
		Klass.prototype = Object.create(parent.prototype);
	}
	for (const k of Object.keys(methods)) {
		Klass.prototype[k] = methods[k];
	}
	Klass.prototype.$super = function () {
		const self = this;
		return function () {
			return parent.prototype.initialize.apply(self, arguments);
		};
	};
	Klass.prototype.constructor = Klass;
	return Klass;
}

/*
	loadGlobalization({root, language, region, phoneRegion}) -> Globalization

	The locale is set as mojoservice set it for a "globalized" service: the
	language and region from the system locale, and the phone region the
	same as the region (mojoservice passes no phone region of its own).
*/
function loadGlobalization({root = DEVICE_ROOT, language = 'en', region = 'us', phoneRegion} = {}) {
	const dir = frameworkDir(root, 'globalization');
	const Foundations = {
		Class: {create: createClass},
		EnvironmentUtils: {isBrowser: () => false, isTriton: () => false, isNode: () => true},
		Comms: {loadFile: p => fs.readFileSync(p, 'utf8')}
	};
	const underscore = {
		_: {
			each(obj, fn, ctx) {
				if (Array.isArray(obj)) {
					obj.forEach(fn, ctx);
				} else {
					for (const k of Object.keys(obj)) {
						fn.call(ctx, obj[k], k, obj);
					}
				}
			},
			isArray: Array.isArray
		}
	};
	const mojoservice = {locale: language + '_' + region, region, phoneRegion: phoneRegion || region};
	const MojoLoader = {
		root: dir + '/',
		require() {
			return {foundations: Foundations, underscore, mojoservice};
		}
	};
	const Assert = {
		requireFunction(f, msg) {
			if (typeof f !== 'function') {
				throw new Error(msg);
			}
		}
	};
	const context = vm.createContext({console: quietConsole(), MojoLoader, Assert, exports: {}});
	vm.runInContext(sources(dir).join('\n') + '\n;this.Globalization = Globalization;', context,
		{filename: path.join(dir, 'globalization.js')});
	return context.Globalization;
}

// phonenumberlib: PhoneNumberLib.Parse(number, REGION).
function loadPhoneNumberLib({root = DEVICE_ROOT} = {}) {
	const dir = frameworkDir(root, 'phonenumberlib');
	const context = vm.createContext({console: quietConsole(), exports: {}});
	vm.runInContext(sources(dir).join('\n') + '\n;this.PhoneNumberLib = PhoneNumberLib;', context,
		{filename: path.join(dir, 'PhoneNumber.js')});
	return context.PhoneNumberLib;
}

// The frameworks log freely (Globalization announces its locale); only their errors are kept.
function quietConsole() {
	return {log() {}, info() {}, warn() {}, debug() {}, error: (...a) => console.error(...a)};
}

module.exports = {loadGlobalization, loadPhoneNumberLib, frameworkDir, DEVICE_ROOT};
