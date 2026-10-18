// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

// db8 (com.palm.db, com.palm.tempdb) over the bus, as promises. Every call
// resolves with the db8 response or throws a DbError; find() reads every page.

const PAGE = 500;      // the most db8 answers with in one find
const BATCH = 100;     // objects per put/merge

class DbError extends Error {
	constructor(method, response) {
		super(`${method}: ${(response && response.errorText) || JSON.stringify(response)}`);
		this.name = 'DbError';
		this.method = method;
		this.errorCode = response && response.errorCode;
		this.response = response;
	}
}

class Db {
	constructor(bus, service = 'com.palm.db') {
		this.bus = bus;
		this.service = service;
	}

	async call(method, params) {
		const response = await this.bus.call(`luna://${this.service}/${method}`, params);
		if (!response || response.returnValue !== true) {
			throw new DbError(method, response);
		}
		return response;
	}

	// One page: {results, next}
	async findPage(query) {
		const q = Object.assign({limit: PAGE}, query);
		const response = await this.call('find', {query: q});
		return {results: response.results || [], next: response.next};
	}

	// Every page, or at most `max` results
	async find(query, max = Infinity) {
		let results = [];
		let page;
		do {
			const q = Object.assign({}, query);
			if (page) {
				q.page = page;
			}
			const r = await this.findPage(q);
			results = results.concat(r.results);
			page = r.next;
		} while (page && results.length < max);
		return results.length > max ? results.slice(0, max) : results;
	}

	async count(query) {
		const response = await this.call('find', {query: Object.assign({limit: 1}, query), count: true});
		return response.count || 0;
	}

	async get(ids) {
		if (!ids.length) {
			return [];
		}
		const response = await this.call('get', {ids});
		return response.results || [];
	}

	// The ids of the new objects, in order
	async put(objects) {
		const ids = [];
		for (let i = 0; i < objects.length; i += BATCH) {
			const response = await this.call('put', {objects: objects.slice(i, i + BATCH)});
			for (const r of response.results || []) {
				ids.push(r.id);
			}
		}
		return ids;
	}

	async merge(objects) {
		for (let i = 0; i < objects.length; i += BATCH) {
			await this.call('merge', {objects: objects.slice(i, i + BATCH)});
		}
	}

	async mergeQuery(query, props) {
		const response = await this.call('merge', {query, props});
		return response.count || 0;
	}

	async del(ids) {
		if (!ids.length) {
			return;
		}
		await this.call('del', {ids});
	}

	async delQuery(query) {
		const response = await this.call('del', {query});
		return response.count || 0;
	}
}

module.exports = {Db, DbError};
