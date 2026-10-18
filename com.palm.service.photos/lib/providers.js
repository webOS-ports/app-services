// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Calls to the service behind a cloud account (its capability's
// serviceName): listAlbums, listPhotos, upload, deletePhoto,
// getPhotoComments, addPhotoComments.

class ProviderError extends Error {
	constructor(service, method, response) {
		super(`${service}/${method}: ${(response && (response.errorText || response.detail || response.errorCode)) ||
			JSON.stringify(response)}`);
		this.name = 'ProviderError';
		this.response = response;
	}
}

// Tries up to `attempts` times; each try ends after timeoutMs.
async function callProvider(bus, cap, method, params, {timeoutMs = 60000, attempts = 1, signal} = {}) {
	if (!cap || !cap.serviceName) {
		throw new Error(`no service for ${method}`);
	}
	let last;
	for (let i = 0; i < attempts; i++) {
		if (signal && signal.aborted) {
			throw signal.reason;
		}
		try {
			const r = await bus.call(`luna://${cap.serviceName}/${method}`, params, {timeoutMs});
			if (r && r.returnValue === true) {
				return r;
			}
			last = new ProviderError(cap.serviceName, method, r);
		} catch (e) {
			last = e;
		}
	}
	throw last;
}

module.exports = {callProvider, ProviderError};
