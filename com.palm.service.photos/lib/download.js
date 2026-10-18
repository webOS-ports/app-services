// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Fetches one photo to a file. The node LuneOS ships does current TLS
// itself, so the presigned https links the cloud connectors hand out
// (Dropbox temporary links, OneDrive download URLs, ...) are fetched as they
// are; on legacy webOS this took curl, as its node had neither TLS that
// those hosts accept nor https at all in the old download code.

const fs = require('fs');
const fsp = fs.promises;
const {Readable, Transform} = require('stream');
const {pipeline} = require('stream/promises');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

// Writes url to dest (through dest + ".part", so a half download never has
// the final name). Resolves with the number of bytes.
async function download(url, dest, {signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
	fetchImpl = globalThis.fetch} = {}) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (e) {
		throw new Error(`not a URL: ${String(url).slice(0, 80)}`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`not fetching a ${parsed.protocol} URL`);
	}
	const signals = [AbortSignal.timeout(timeoutMs)];
	if (signal) {
		signals.push(signal);
	}
	const part = dest + '.part';
	try {
		const response = await fetchImpl(parsed.href, {redirect: 'follow', signal: AbortSignal.any(signals)});
		if (!response.ok || !response.body) {
			throw new Error(`HTTP ${response.status} for ${parsed.host}`);
		}
		const length = Number(response.headers.get('content-length'));
		if (length > maxBytes) {
			throw new Error(`${length} bytes is more than the ${maxBytes} a photo may have`);
		}
		let bytes = 0;
		const limit = new Transform({
			transform(chunk, encoding, callback) {
				bytes += chunk.length;
				callback(bytes > maxBytes ? new Error(`more than ${maxBytes} bytes`) : null, chunk);
			}
		});
		await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(part, {mode: 0o644}));
		if (!bytes) {
			throw new Error(`empty response from ${parsed.host}`);
		}
		await fsp.rename(part, dest);
		return bytes;
	} catch (e) {
		await fsp.unlink(part).catch(() => {});
		throw e;
	}
}

module.exports = {download};
