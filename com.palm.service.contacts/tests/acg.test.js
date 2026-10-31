// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The hub lets the service call a method only when its client permissions
	(files/sysbus/*.perm.json) name a group that holds the method. lib/photos.js
	crops contact photos through the image service, whose groups are in
	luna-sysservice's com.webos.service.systemservice.api.json. Only the two
	methods it calls: image.management would add resize and imageInfo.
*/

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PERM = path.join(__dirname, '..', 'files', 'sysbus', 'com.palm.service.contacts.perm.json');

const CALLS = {
	'com.webos.service.image/convert': 'image.convert',
	'com.webos.service.image/ezResize': 'image.ezresize'
};

describe('client permissions', () => {
	const groups = JSON.parse(fs.readFileSync(PERM, 'utf8'))['com.palm.service.contacts'];

	it('name a group for each image method the service calls', () => {
		for (const [call, group] of Object.entries(CALLS)) {
			assert.ok(groups.includes(group), call + ' needs ' + group);
		}
	});

	it('hold no wider image group', () => {
		assert.ok(!groups.includes('image.management'));
	});
});
