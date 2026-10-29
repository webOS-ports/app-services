// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

/*
	A stand-in palmbus for running the service on the host: outgoing calls go
	to onCall(uri, args, sender) -> a reply, an array of replies, or undefined
	(never replies); request() delivers a call to a registered service.
*/
'use strict';

const {EventEmitter} = require('events');

function createPalmbus(onCall) {
	const handles = [];
	const services = {};
	let token = 0;

	function Handle(name) {
		EventEmitter.call(this);
		this.name = name || '';
		this.methods = [];
		handles.push(this);
		if (name) {
			services[name] = this;
		}
	}
	Object.setPrototypeOf(Handle.prototype, EventEmitter.prototype);
	Handle.prototype.registerMethod = function (category, method) {
		this.methods.push((category || '/') + method);
	};
	Handle.prototype.subscriptionAdd = function () {};
	Handle.prototype.unregister = function () {
		this.unregistered = true;
	};
	Handle.prototype.pushRole = function () {};
	Handle.prototype.call = function (uri, payload) {
		const req = new EventEmitter();
		const args = JSON.parse(payload);
		req.cancel = function () {
			req.cancelled = true;
		};
		const self = this;
		setImmediate(async function () {
			let r;
			try {
				r = await onCall(uri.replace(/^palm:/, 'luna:'), args, self.name);
			} catch (e) {
				r = {returnValue: false, errorCode: -1, errorText: String(e && e.stack || e)};
			}
			if (r === undefined) {
				return;
			}
			for (const one of Array.isArray(r) ? r : [r]) {
				if (req.cancelled) {
					return;
				}
				req.emit('response', {payload: () => JSON.stringify(one)});
			}
		});
		return req;
	};
	Handle.prototype.callOneReply = Handle.prototype.call;
	Handle.prototype.watch = Handle.prototype.call;
	Handle.prototype.subscribe = Handle.prototype.call;

	// Deliver a call to the service registered as `name`; resolves with its first reply.
	function request(name, method, payload, caller) {
		caller = caller || {};
		const h = services[name];
		if (!h) {
			return Promise.reject(new Error('no service ' + name));
		}
		const replies = [];
		return new Promise(resolve => {
			token++;
			const t = String(token);
			h.emit('request', {
				method: () => method,
				category: () => '/',
				payload: () => JSON.stringify(payload || {}),
				uniqueToken: () => t,
				token: () => token,
				applicationID: () => caller.appId || '',
				senderServiceName: () => caller.service || '',
				sender: () => caller.service || caller.appId || '',
				isSubscription: () => false,
				respond: text => {
					replies.push(text);
					if (replies.length === 1) {
						resolve(text);
					}
					return true;
				}
			});
		});
	}

	return {Handle, handles, services, request, setAppId() {}};
}

module.exports = {createPalmbus};
