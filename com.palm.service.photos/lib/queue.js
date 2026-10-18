// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// Runs jobs one at a time, in order. A job queued under a key that is
// already waiting or running is not queued again; its caller gets the
// promise of the one that is.
class SerialQueue {
	constructor() {
		this.tail = Promise.resolve();
		this.keyed = new Map();
		this.pending = 0;
	}

	run(key, job) {
		if (key && this.keyed.has(key)) {
			return this.keyed.get(key);
		}
		this.pending++;
		const p = this.tail.then(() => job());
		this.tail = p.catch(() => {}).then(() => {
			this.pending--;
		});
		if (key) {
			this.keyed.set(key, p);
			const forget = () => this.keyed.delete(key);
			p.then(forget, forget);
		}
		return p;
	}

	get busy() {
		return this.pending > 0;
	}
}

module.exports = {SerialQueue};
