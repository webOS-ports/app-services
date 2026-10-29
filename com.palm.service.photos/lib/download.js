// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Fetches one photo to a file. The node LuneOS ships does current TLS
// itself, so the presigned https links the cloud connectors hand out
// (Dropbox temporary links, OneDrive download URLs, ...) are fetched as they
// are; on legacy webOS this took curl, as its node had neither TLS that
// those hosts accept nor https at all in the old download code.
//
// A connector that cannot hand out a link the service can use as it is
// gives a file:// path to a copy it made itself instead: MEGA serves only
// ciphertext, so its listPhotos decrypts each photo into
// /media/internal/.mega-photos first. Those are copied, but only from inside
// localRoot (the media root): the links come from db entries other apps can
// write too, and the service runs as root. A copy the connector marks as
// temporary (removeSource) is removed once it is copied: it was made only
// for this.

const fs = require('fs');
const fsp = fs.promises;
const {Readable, Transform} = require('stream');
const {pipeline} = require('stream/promises');
const {fileURLToPath} = require('url');
const {Paths} = require('./files');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

// Writes url to dest (through dest + ".part", so a half download never has
// the final name). Resolves with the number of bytes.
async function download(url, dest, {signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES,
	fetchImpl = globalThis.fetch, localRoot, removeSource = false} = {}) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (e) {
		throw new Error(`not a URL: ${String(url).slice(0, 80)}`);
	}
	if (parsed.protocol === 'file:' && localRoot) {
		return copyLocal(parsed, dest, {maxBytes, localRoot, removeSource});
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

// Copies a file:// photo from inside localRoot, symlinks resolved
async function copyLocal(parsed, dest, {maxBytes, localRoot, removeSource}) {
	let source;
	try {
		source = await fsp.realpath(fileURLToPath(parsed));
	} catch (e) {
		throw new Error(`no file at ${parsed.pathname}`);
	}
	if (!Paths.within(await fsp.realpath(localRoot), source)) {
		throw new Error(`not copying ${source}: outside ${localRoot}`);
	}
	const part = dest + '.part';
	const handle = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	let size;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new Error(`${source} is not a file`);
		}
		if (stat.size > maxBytes) {
			throw new Error(`${stat.size} bytes is more than the ${maxBytes} a photo may have`);
		}
		if (!stat.size) {
			throw new Error(`${source} is empty`);
		}
		await pipeline(handle.createReadStream({autoClose: false}), fs.createWriteStream(part, {mode: 0o644}));
		await fsp.rename(part, dest);
		size = stat.size;
	} catch (e) {
		await fsp.unlink(part).catch(() => {});
		throw e;
	} finally {
		await handle.close();
	}
	if (removeSource) {
		// The photo is ours now; a copy that cannot go is the connector's to clear.
		await fsp.unlink(source).catch(() => {});
	}
	return size;
}

module.exports = {download};
