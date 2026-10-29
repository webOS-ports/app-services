// Copyright (c) 2026 Herman van Hazendonk
// Derived from mojoservice, Copyright 2009-2011 Hewlett-Packard Development
// Company, L.P., and Foundations' comms/palmcall.js and control/activity.js,
// Copyright (c) 2009-2012 Hewlett-Packard Development Company, L.P., licensed
// under the Apache License, Version 2.0.
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

/*
	The replies the linker gave when it ran on mojoservice, kept as they were
	for its callers (the contacts app among them):

	- a command's result as it is when it is not an object: true for
	  manualLink, forceAutolink and the watch, a sentence for yieldAutolink
	- an object result with returnValue:true added, and {returnValue:true}
	  for a result that is falsy
	- an error as {errorText, errorCode, exception, returnValue:false}: with
	  no errorCode of its own, -9999 and "MojoService: no errorCode
	  supplied " before its text
	- a command still running after its timeout: error 504,
	  "commandTimeout in com.palm.service.contacts.linker/<method>"
*/

const DEFAULT_TIMEOUT_S = 60;
const AM = 'palm://com.palm.activitymanager';

// A callback from activitymanager: the legacy name, the OSE one, or its proxy for the creator.
function fromActivityManager(sender) {
	return sender === 'com.palm.activitymanager' || sender === 'com.webos.service.activitymanager' ||
		/_com\.webos\.service\.activitymanager_proxy$/.test(sender || '');
}

function reply(result) {
	if (!result) {
		return {returnValue: true};
	}
	if (typeof result === 'object') {
		result.returnValue = true;
	}
	return result;
}

function exception(e) {
	const out = {
		errorText: e && e.message,
		errorCode: e && e.errorCode,
		exception: e && e.stack ? e.stack : String(e),
		returnValue: false
	};
	if (out.errorCode === undefined) {
		out.errorCode = -9999;
		out.errorText = 'MojoService: no errorCode supplied ' + (out.errorText || '');
	}
	return out;
}

/*
	A bus call that fails as Foundations' PalmCall failed: errorCode the
	reply's (or -1), and errorText "palm://<service>/<method> <args>: <the
	reply's errorText>", which is what a command that fails on it answers.
*/
function palmCall(call) {
	const wrapped = async (uri, args, opts) => {
		try {
			return await call(uri, args, opts);
		} catch (e) {
			if (!e || e.errorCode === 'BUS_TIMEOUT' || e.errorCode === 'BUS_BAD_REPLY') {
				throw e;
			}
			// bus.js says "<uri> failed" for a reply with no errorText of its own.
			const text = !e.errorText || e.errorText === uri + ' failed' ? 'Unknown PalmCall failure' : e.errorText;
			const err = new Error(uri.replace(/^luna:/, 'palm:') + ' ' + JSON.stringify(args) + ': ' + text);
			err.errorCode = e.errorCode === 'BUS_ERROR' || !e.errorCode ? -1 : e.errorCode;
			throw err;
		}
	};
	if (call.subscribe) {
		wrapped.subscribe = call.subscribe;
	}
	return wrapped;
}

function timeoutError(service, command) {
	const e = new Error('commandTimeout in ' + service + '/' + command);
	e.errorCode = 504;
	return e;
}

/*
	A command given an $activity takes it on first. activitymanager calling
	back: adopt it, which makes the activity ours to complete, and answer at
	once. The adopt waits (wait:true) when the activity is still held: after
	a run completes it with restart:true and contacts are left, activitymanager
	calls back at once, before that run has let go of it. mojoservice did
	not wait, so that adopt failed, the callback ran nothing and no other
	came (README.md tells how linkerWatch stopped). Waiting, the callback
	runs on the "orphan" event that hands it the activity; a "cancel",
	"complete" or "stop" before it, an error, or no hand-over within the
	command's time, and it runs nothing and answers {status: "adopt failed"},
	as an error would make activitymanager cancel the activity. Anyone else
	passing one: monitor it, and fail the command if that fails. -> the
	subscription to end when the command is done, or a reply to give
	instead of running.
*/
async function takeActivity(subscribe, params, ctx, waitMs) {
	const a = params.$activity;
	const adopt = fromActivityManager(ctx.sender);
	const args = {activityId: a.activityId, subscribe: true};
	if (adopt) {
		args.wait = true;
		if (a.callback && a.callback.serial) {
			args.serial = a.callback.serial;
		}
	}
	const uri = AM + '/' + (adopt ? 'adopt' : 'monitor');
	const failed = (e, text) => {
		const err = new Error(uri + ' ' + JSON.stringify(args) + ': ' +
			(text || (e && e.errorText) || (e && e.message) || 'Unknown PalmCall failure'));
		err.errorCode = typeof (e && e.errorCode) === 'number' ? e.errorCode : -1;
		return {instead: adopt ? reply({status: 'adopt failed', error: String(err)}) : exception(err)};
	};
	let handOver = null;
	const handedOver = new Promise(resolve => {
		handOver = resolve;
	});
	const onEvent = e => {
		if (e.returnValue === false) {
			handOver({e, text: e.errorText || 'the subscription failed'});
		} else if (e.event === 'orphan') {
			handOver({});
		} else if (e.event === 'cancel' || e.event === 'complete' || e.event === 'stop') {
			handOver({text: '"' + e.event + '" while waiting to adopt'});
		}
	};
	let held;
	try {
		held = await subscribe(uri.replace(/^palm:/, 'luna:'), args, {onEvent});
	} catch (e) {
		return failed(e);
	}
	if (adopt && ctx.replyNow) {
		ctx.replyNow({returnValue: true});
	}
	if (adopt && held.first && held.first.adopted === false) {
		let timer;
		const late = new Promise(resolve => {
			timer = setTimeout(() => resolve({text: 'not handed over in ' + Math.round(waitMs / 1000) + ' s'}), waitMs);
			if (timer.unref) {
				timer.unref();
			}
		});
		const got = await Promise.race([handedOver, late]);
		clearTimeout(timer);
		if (got.text) {
			held.cancel();
			return failed(got.e, got.text);
		}
	}
	return {held};
}

/*
	A bus method ({handler, raw, timeoutMs}) that replies as mojoservice did:
	run(params) is the command; it gets timeoutS seconds. subscribe (the
	bus's) takes on an $activity the call brings (takeActivity). claim, if
	given, is asked first for a call that brings one: -> a function to call
	when the command is done, or a status to answer with instead of running.
*/
function method(service, name, run, {timeoutS = DEFAULT_TIMEOUT_S, log = console, subscribe, claim} = {}) {
	return {
		raw: true,
		timeoutMs: (timeoutS + 5) * 1000,
		handler: async (params, ctx = {}) => {
			let taken = {}, release = null;
			if (subscribe && params && params.$activity && params.$activity.activityId !== undefined) {
				if (claim) {
					release = claim(params, ctx);
					if (typeof release === 'string') {
						log.error(service + ': ' + name + ': ' + release);
						return reply({status: release});
					}
				}
				taken = await takeActivity(subscribe, params, ctx, timeoutS * 1000);
				if (taken.instead) {
					if (release) {
						release();
					}
					log.error(service + ': ' + name + ': ' + (taken.instead.error || taken.instead.errorText));
					return taken.instead;
				}
			}
			let timer;
			const late = new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(timeoutError(service, name)), timeoutS * 1000);
				if (timer.unref) {
					timer.unref();
				}
			});
			try {
				return reply(await Promise.race([Promise.resolve().then(() => run(params)), late]));
			} catch (e) {
				log.error(service + ': ' + name + ' failed: ' + ((e && e.stack) || e));
				return exception(e);
			} finally {
				clearTimeout(timer);
				if (release) {
					release();
				}
				if (taken.held) {
					taken.held.cancel();
				}
			}
		}
	};
}

module.exports = {method, reply, exception, palmCall, timeoutError, fromActivityManager, DEFAULT_TIMEOUT_S};
