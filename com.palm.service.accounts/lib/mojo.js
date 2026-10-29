// Copyright (c) 2026 Herman van Hazendonk
// SPDX-License-Identifier: Apache-2.0

'use strict';

/*
	Copied from com.palm.service.contacts.linker/lib/mojo.js (less its
	palmCall, which is lib/palmcall.js here; the accounts service gives no
	subscribe to method(), as no caller brings it an $activity). The replies
	a service gave when it ran on mojoservice, kept as they were for its
	callers:

	- a command's result as it is when it is not an object
	- an object result with returnValue:true added, and {returnValue:true}
	  for a result that is falsy
	- an error as {errorText, errorCode, exception, returnValue:false}: with
	  no errorCode of its own, -9999 and "MojoService: no errorCode
	  supplied " before its text
	- a command still running after its timeout: error 504,
	  "commandTimeout in <service>/<method>"
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
	came (the linker's README.md tells how its linkerWatch stopped). Waiting, the callback
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
	run(params, ctx) is the command ([accounts]: ctx, the bus's, passed on); it gets timeoutS seconds. subscribe (the
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
				return reply(await Promise.race([Promise.resolve().then(() => run(params, ctx)), late]));
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

module.exports = {method, reply, exception, timeoutError, fromActivityManager, DEFAULT_TIMEOUT_S};
