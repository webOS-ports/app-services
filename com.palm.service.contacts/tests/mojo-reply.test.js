// Copyright (c) 2026 Herman van Hazendonk <github.com@herrie.org>
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/*
	An error reply names the error but carries no stack: the reply goes to
	whichever app called, and the stack is logged on the device instead.
*/

const {test} = require('node:test');
const assert = require('node:assert');

const mojo = require('../lib/mojo');

const STACK = /\n\s+at |\.js:\d+|node:internal/;

test('an Error replies as "Name: message", with no stack', () => {
	const e = mojo.exception(new Error('boom'));
	assert.strictEqual(e.exception, 'Error: boom');
	assert.doesNotMatch(e.exception, STACK);
	assert.strictEqual(e.returnValue, false);
	const t = mojo.exception(new TypeError('x is not a function'));
	assert.strictEqual(t.exception, 'TypeError: x is not a function');
	assert.ok(t.exception.indexOf(__dirname) === -1);
});

test('an Error with an errorCode keeps it, and still no stack', () => {
	const err = new Error('gone');
	err.errorCode = -3;
	const e = mojo.exception(err);
	assert.deepStrictEqual([e.errorCode, e.errorText, e.exception], [-3, 'gone', 'Error: gone']);
});

test('what is not an Error replies as it always did', () => {
	assert.strictEqual(mojo.exception('Missing args!').exception, 'Missing args!');
	assert.strictEqual(mojo.exception({message: 'dup', errorCode: 'X'}).exception, '[object Object]');
});
