// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The palmprofile template as shipped (account-templates/palmprofile), against
	the callers that write the profile account. A caller missing from
	writePermissions is refused by createAccount and modifyAccount
	(model.js hasPermission), and the bus gives a run-js-service service its
	directory name as appId, not the bus name it registers.
*/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/model');

const FILE = path.join(__dirname, '..', '..', 'account-templates', 'palmprofile',
	'com.palm.palmprofile', 'com.palm.palmprofile.json');
const template = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const quiet = {log() {}, warn() {}, error() {}};

test('the community account bridge may write the profile account', () => {
	// Signing in creates or renames the profile; the bridge's appId is its
	// service directory, org.webosports.service.communityaccount.
	assert.strictEqual(M.hasPermission('writePermissions', template,
		{appId: 'org.webosports.service.communityaccount', sender: 'com.palm.accountservices'}, quiet), true);
});

test('First Use may write the profile account', () => {
	assert.strictEqual(M.hasPermission('writePermissions', template, {appId: 'org.webosports.app.firstuse'}, quiet), true);
});

test('an app not in the template may not', () => {
	assert.throws(() => M.hasPermission('writePermissions', template, {appId: 'com.example.app'}, quiet),
		/Permission denied/);
});
