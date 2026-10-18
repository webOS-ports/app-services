// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Outgoing calls over a palmbus handle, as promises and subscriptions with
// parsed payloads. The rest of the service only sees this interface:
//   call(uri, params, {timeoutMs}) -> Promise<payload>
//   subscribe(uri, params, onPayload) -> {cancel()}

const DEFAULT_TIMEOUT_MS = 60000;

function parse(message, uri) {
	try {
		return JSON.parse(message.payload());
	} catch (e) {
		return {returnValue: false, errorText: `bad JSON from ${uri}`};
	}
}

class PalmBus {
	constructor(handle) {
		this.handle = handle;
	}

	call(uri, params, {timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
		return new Promise((resolve, reject) => {
			let request;
			try {
				request = this.handle.call(uri, JSON.stringify(params || {}));
			} catch (e) {
				reject(e);
				return;
			}
			const timer = timeoutMs > 0 ? setTimeout(() => {
				try {
					request.cancel();
				} catch (e) {
					// already over
				}
				reject(new Error(`${uri}: no answer in ${timeoutMs} ms`));
			}, timeoutMs) : null;
			request.addListener('response', message => {
				if (timer) {
					clearTimeout(timer);
				}
				resolve(parse(message, uri));
			});
		});
	}

	subscribe(uri, params, onPayload) {
		const request = this.handle.subscribe(uri, JSON.stringify(params || {}));
		let open = true;
		request.addListener('response', message => {
			if (open) {
				onPayload(parse(message, uri));
			}
		});
		return {
			cancel() {
				if (open) {
					open = false;
					try {
						request.cancel();
					} catch (e) {
						// already over
					}
				}
			}
		};
	}
}

module.exports = {PalmBus};
