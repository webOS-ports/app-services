// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The hub lets the service call a method only when its client permissions
	(files/sysbus/*.perm.json) name a group that holds the method. lib/person.js
	crops the list photo with the image service's ezResize and calls nothing
	else there, so it holds that method's group alone. The groups are in
	luna-sysservice's com.webos.service.systemservice.api.json.
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PERM = path.join(__dirname, '..', 'files', 'sysbus', 'com.palm.service.contacts.linker.perm.json');

describe('client permissions', () => {
	const groups = JSON.parse(fs.readFileSync(PERM, 'utf8'))['com.palm.service.contacts.linker'];

	it('name the group of the one image method the service calls', () => {
		assert.ok(groups.includes('image.ezresize'));
	});

	it('hold no wider image group', () => {
		assert.ok(!groups.includes('image.convert'));
		assert.ok(!groups.includes('image.management'));
	});
});
