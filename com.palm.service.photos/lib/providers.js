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

// How long a listing may go on in all, and the least time between two calls asking after it
const LISTING_LIMIT_MS = 30 * 60 * 1000;
const POLL_GAP_MS = 1000;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	const t = setTimeout(done, ms);
	function done() {
		if (signal) {
			signal.removeEventListener('abort', aborted);
		}
		resolve();
	}
	function aborted() {
		clearTimeout(t);
		reject(signal.reason);
	}
	if (signal) {
		signal.addEventListener('abort', aborted, {once: true});
	}
});

// Tries up to `attempts` times; each try ends after timeoutMs.
//
// continuable: a listing that may take longer than one call. The connector runs it as a job
// (_cloudcore/node/jobs.js): while it is not done it answers {pending, jobId, progress}, and
// is asked again with that jobId until it gives the result, for up to limitMs in all. A call
// that gets no answer is tried again with the jobId, so the work goes on where it was instead
// of starting over (one whose work failed starts it again); `attempts` is how many in a row may fail. A connector that
// has lost the job (it was restarted) is asked once more from the start. A connector from
// before jobs ignores continuable and answers as it always did. onProgress hears each
// pending answer's progress.
async function callProvider(bus, cap, method, params, {timeoutMs = 60000, attempts = 1, signal, continuable = false,
	limitMs = LISTING_LIMIT_MS, pollGapMs = POLL_GAP_MS, onProgress = null, now = Date.now} = {}) {
	if (!cap || !cap.serviceName) {
		throw new Error(`no service for ${method}`);
	}
	const uri = `luna://${cap.serviceName}/${method}`;
	const until = now() + limitMs;
	let jobId = null;
	let restarted = false;
	let failed = 0;
	let last;
	while (failed < attempts) {
		if (signal && signal.aborted) {
			throw signal.reason;
		}
		if (continuable && now() > until) {
			throw new Error(`${cap.serviceName}/${method}: not done in ${Math.round(limitMs / 60000)} min`);
		}
		const asked = continuable ? Object.assign({}, params, {continuable: true}, jobId ? {jobId} : {}) : params;
		let r;
		try {
			r = await bus.call(uri, asked, {timeoutMs});
		} catch (e) {
			last = e;
			failed++;
			continue;
		}
		if (r && r.returnValue === true && continuable && r.pending === true && typeof r.jobId === 'string') {
			jobId = r.jobId;
			failed = 0;
			if (onProgress && r.progress) {
				onProgress(r.progress);
			}
			await sleep(pollGapMs, signal);
			continue;
		}
		if (r && r.returnValue === true) {
			return r;
		}
		if (continuable && jobId && r && r.errorCode === 'JOB_UNKNOWN' && !restarted) {
			restarted = true;
			jobId = null;
			continue;
		}
		// The work itself failed: a try after this one starts it again, as before jobs
		last = new ProviderError(cap.serviceName, method, r);
		jobId = null;
		failed++;
	}
	throw last;
}

module.exports = {callProvider, ProviderError, LISTING_LIMIT_MS};
