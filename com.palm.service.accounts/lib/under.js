// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	The few underscore functions the old service used, as the device's
	underscore framework (0.6.0) had them. They are kept, not replaced by the
	Array methods, because they fail where those would not and the other way
	round, and a command answers with what failed: map, pluck, detect and
	compact read .map / .forEach / .filter of what they are given, so
	undefined fails with "Cannot read properties of undefined (reading
	'map')"; an object that is not an array is walked by its own keys; extend
	copies inherited properties too.
*/

const nativeForEach = Array.prototype.forEach;
const nativeMap = Array.prototype.map;
const nativeFilter = Array.prototype.filter;
const BREAK = {};

function isNumber(v) {
	return (v === +v) || Object.prototype.toString.call(v) === '[object Number]';
}

function each(obj, fn) {
	try {
		if (obj.forEach === nativeForEach) {
			obj.forEach(fn);
		} else if (isNumber(obj.length)) {
			for (let i = 0, l = obj.length; i < l; i++) {
				fn(obj[i], i, obj);
			}
		} else {
			for (const key in obj) {
				if (Object.prototype.hasOwnProperty.call(obj, key)) {
					fn(obj[key], key, obj);
				}
			}
		}
	} catch (e) {
		if (e !== BREAK) {
			throw e;
		}
	}
	return obj;
}

function map(obj, fn) {
	if (obj.map === nativeMap) {
		return obj.map(fn);
	}
	const out = [];
	each(obj, (v, i, l) => {
		out.push(fn(v, i, l));
	});
	return out;
}

function filter(obj, fn) {
	if (obj.filter === nativeFilter) {
		return obj.filter(fn);
	}
	const out = [];
	each(obj, (v, i, l) => {
		if (fn(v, i, l)) {
			out.push(v);
		}
	});
	return out;
}

function detect(obj, fn) {
	let found;
	each(obj, (v, i, l) => {
		if (fn(v, i, l)) {
			found = v;
			throw BREAK;
		}
	});
	return found;
}

const pluck = (obj, key) => map(obj, v => v[key]);
const compact = list => filter(list, v => !!v);
const values = obj => map(obj, v => v);

function extend(target, source) {
	for (const k in source) {
		target[k] = source[k];
	}
	return target;
}

module.exports = {each, map, filter, detect, pluck, compact, values, extend, isNumber};
