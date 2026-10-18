// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	com.palm.service.photos: the photo aggregator of webOS 3.0, written anew
	for LuneOS. It brings the photos of cloud accounts (every account with
	PHOTO.UPLOAD) down into the media database as albums, makes the
	thumbnails the Photos app shows, and does the album and photo work the
	app asks for: create, rename, delete, copy between the device and the
	cloud. See README.md.

	run-js-service starts it as a node module (package.json). It talks to the
	bus through palmbus itself rather than webos-service, which first creates
	an activity for every call; and it exits when it has been idle for a
	while, as the bus starts it again on the next call.
*/

const palmbus = require('palmbus');
const path = require('path');
const log = require('./lib/log');
const {PalmBus} = require('./lib/bus');
const {Paths} = require('./lib/files');
const {Thumbnailer} = require('./lib/thumbnailer');
const {PhotosService, SERVICE} = require('./lib/photos');
const {methods, SUBSCRIPTIONS} = require('./lib/methods');

const IDLE_EXIT_MS = 5 * 60 * 1000;
const RESYNC_MS = 15 * 60 * 1000;

function run() {
	process.title = SERVICE;
	const handle = new palmbus.Handle(SERVICE);
	const bus = new PalmBus(handle);
	const paths = new Paths('/media/internal');
	const service = new PhotosService({
		bus,
		paths,
		thumbnailer: new Thumbnailer({tmpDir: path.join(paths.generated, '.in')})
	});
	const table = methods(service);
	const subscriptions = new Map();     // uniqueToken -> unsubscribe
	let inFlight = 0;
	let lastActivity = Date.now();

	for (const name of Object.keys(table).concat(SUBSCRIPTIONS, ['quit'])) {
		handle.registerMethod('/', name);
	}

	const respond = (message, response) => {
		try {
			message.respond(JSON.stringify(response));
		} catch (e) {
			log.warn(`could not answer ${message.method()}: ${e.message}`);
		}
	};

	const completeActivity = payload => {
		const activity = payload && !Array.isArray(payload) && payload.$activity;
		if (activity && activity.activityId) {
			bus.call('luna://com.palm.activitymanager/complete', {activityId: activity.activityId}, {timeoutMs: 10000})
				.catch(() => {});
		}
	};

	handle.addListener('request', message => {
		lastActivity = Date.now();
		const method = message.method();
		let payload;
		try {
			payload = JSON.parse(message.payload() || '{}');
		} catch (e) {
			respond(message, {returnValue: false, errorCode: -1, errorText: 'bad JSON'});
			return;
		}

		if (method === 'quit') {
			respond(message, {returnValue: true, status: 'quitting'});
			setTimeout(() => process.exit(0), 200);
			return;
		}

		if (method === 'subscribeToAccountsInfo') {
			service.start().then(() => {
				respond(message, {returnValue: true, accounts: service.accounts.snapshot()});
				if (message.isSubscription()) {
					const token = message.uniqueToken();
					handle.subscriptionAdd(token, message);
					subscriptions.set(token, service.subscribe(update => {
						respond(message, Object.assign({returnValue: true}, update));
					}));
					// The app subscribes when it opens: bring every account up to date
					service.background(service.syncAll(true), 'sync on subscribe');
				}
			});
			return;
		}

		const handler = table[method];
		if (!handler) {
			respond(message, {returnValue: false, errorCode: -1, errorText: `Unknown method ${method}`});
			return;
		}
		inFlight++;
		Promise.resolve()
			.then(() => handler(payload))
			.catch(e => {
				log.error(`${method}: ${e && (e.stack || e.message)}`);
				return {returnValue: false, errorCode: -1, errorText: (e && e.message) || String(e)};
			})
			.then(response => {
				respond(message, response);
				completeActivity(payload);
			})
			.finally(() => {
				inFlight--;
				lastActivity = Date.now();
			});
	});

	handle.addListener('cancel', message => {
		const unsubscribe = subscriptions.get(message.uniqueToken());
		if (unsubscribe) {
			unsubscribe();
			subscriptions.delete(message.uniqueToken());
		}
		lastActivity = Date.now();
	});

	// While the app is open, every account is synced again now and then
	setInterval(() => {
		if (subscriptions.size) {
			service.background(service.syncAll(false), 'periodic sync');
		}
	}, RESYNC_MS).unref();

	// Gone when idle; the bus starts the service again when it is called
	setInterval(() => {
		if (service.busy || inFlight) {
			lastActivity = Date.now();
		} else if (Date.now() - lastActivity > IDLE_EXIT_MS) {
			service.stop();
			process.exit(0);
		}
	}, 60000);

	process.on('uncaughtException', e => {
		log.error(`uncaught: ${e && (e.stack || e.message)}`);
		service.clearSyncStates().finally(() => process.exit(1));
	});
	process.on('unhandledRejection', e => {
		log.error(`unhandled rejection: ${e && (e.stack || e.message)}`);
	});

	service.start().then(() => service.clearSyncStates());
}

module.exports = {run};

if (require.main === module) {
	run();
}
