# Copyright and License Information

This service is a rewrite, for Node 22, of the accounts service that ran on
mojoservice:

 Copyright (c) 2026 Herman van Hazendonk

It is licensed under the GNU General Public License, version 3 or (at your
option) any later version: see COPYING. The rest of the app-services
repository keeps its own licence.

The rewrite follows the old service closely, and the files ported from it
(service.js, lib/commands.js, keystore.js, model.js and templates.js) say so
in their headers, as do lib/mojo.js, lib/palmcall.js and lib/db.js for
mojoservice and Foundations, and lib/templates.js for the globalization
framework. That code is:

 Copyright (c) 2009-2013 LG Electronics, Inc.
 Copyright (c) 2010-2013 LG Electronics, Inc. (globalization)
 Copyright (c) 2009-2012 Hewlett-Packard Development Company, L.P.
 Copyright 2009-2011 Hewlett-Packard Development Company, L.P. (mojoservice)

licensed under the Apache License, Version 2.0 (see LICENSE), which allows
it to be part of a GPL-3.0 work. lib/under.js is derived from Underscore.js
0.6.0, (c) 2010 Jeremy Ashkenas, DocumentCloud Inc., which is freely
distributable under the terms of the MIT license. lib/schema.js is Kris
Zyp's JSONSchema validator as Foundations shipped it, Copyright (c) 2007
Kris Zyp SitePen (www.sitepen.com), and stays under the MIT license. The
files kept from the old service as they were (backup/, db/,
desktop-support/, files/, ls2/, schemas/, tempdb/ and palm_bus_config.json)
are LG Electronics' and stay under the Apache License, Version 2.0.

Quick Info
-----------
Accounts Javascript Service: the accounts (`com.palm.account:1` in db8),
their credentials (in com.palm.keymanager, one key per account) and the
account templates the transports install under
`/usr/palm/public/accounts` and `/media/cryptofs/apps/usr/palm/accounts`.

Core
-------
The service is a Node 22 rewrite of the mojoservice one, for the launcher's
plain-node path (`run-js-service` requires the directory, as it has a
`package.json`, and calls `run()`). Foundations and mojoservice are no
longer loaded.

| | |
|---|---|
| `service.js` | start-up: the bus, the locale, the templates, the methods |
| `lib/commands.js` | the 20 bus methods, answering as the old service did (`lib/mojo.js`) |
| `lib/templates.js` | reading, localizing and checking the templates; the `com.palm.account.templates:1` signal in tempdb |
| `lib/model.js` | an account as the methods return it; who may see which account |
| `lib/keystore.js` | an account's credentials in com.palm.keymanager |
| `lib/palmcall.js` | calls to other services as Foundations' PalmCall made them, and its mapReduce |
| `lib/db.js`, `lib/under.js` | Foundations' DB and the parts of underscore 0.6 the old code relied on |
| `lib/schema.js` | the JSON schema validator of Foundations (Kris Zyp's), as it was |
| `lib/bus.js`, `lib/errors.js`, `lib/mojo.js` | the bus, and the replies mojoservice gave |

db/, tempdb/, backup/, desktop-support/, files/, ls2/ and schemas/ are the
old service's, unchanged.

The first version reproduces the old service's replies and records
exactly, including its bugs. It was checked by an A/B test: the old service
and this one ran on the same seeded templates, accounts, credentials and
transport replies (transports answering, failing, never answering), locale
changes and restores, and every step's reply, db8 and tempdb contents, the
keymanager's keys and the calls made to other services were compared. The
bugs were then mended one commit at a time, each with its own test; the
code, tests and commits refer to them by these numbers:

- B1: `notifyAccountCreated` and `notifyAccountDeleted` never went on once
  one transport's `onCreate`, `onEnabled` or `onDelete` failed: the later
  steps were never made, and a deleted account was never removed.
- B2: `createAccount` with a password created the account even when a
  validator turned the credentials down.
- B3: a failed call's error text carried the password, keydata or
  credentials of its arguments, into a method's reply and into the log (a
  keymanager `store` that failed, for one, answered with the account's
  keydata). This one is mended from the first version on (below).
- B4: `modifyAccount` cleared the account's sync states before it checked
  anything, so a caller without write permission, or a call for an unknown
  account, cleared them; and it turned down disabling an `alwaysOn`
  capability only after the account's credentials had been replaced.
- B5: `modifyAccount` sent `onCredentialsChanged` to the capabilities it
  had just enabled too (the list of those it added was all `undefined`).
- B6: the `onEnabled` calls a list of capabilities made all named the last
  one's account and capability.
- B7: when a transport's `onCredentialsChanged` failed, the rollback
  disabled that capability, and failed with a TypeError for a
  template-level transport or a credentials-only change.
- B8: a delete resumed at start-up lost its `keepData`, so the transports
  were told to delete the account's data.
- B9: a credentials write whose `store` failed after the `remove` lost all
  of the account's credentials.

Left as it was: `hasCredentials` answers any caller, without the permission
check `readCredentials` makes. It says only whether an account has
credentials, and com.palm.app.backup, the enyo syncui and
com.palm.service.photos call it as they are.

These things deliberately differ from the old service:

- No activitymanager activity is made for each call, and an `$activity` in
  a call is not adopted: no caller of this service brings one.
- When the locale cannot be read at start-up, the templates are read for
  `en_us` (and that is logged). The old service never answered anything.
- `getSystemTime` is not called at start-up: nothing used its answer.
- A password, keydata or credentials value in a failed call's error text is
  written as `<hidden>` (B3).
- The service leaves the bus after 30 s with no call (mojoservice: 5 s),
  and an unknown method or a payload that is no object gets the bus's
  error rather than mojoservice's.
- The template schemas are read once for each time the templates are read.
- `__quit` is kept (stark.files calls it); `__info` and `__gc` are not.

Tests
-------
    tests/run.sh

This runs the unit tests (`node --test`) over an in-memory db8 and tempdb
(`tests/fakedb.js`), keymanager and transports on a stand-in bus
(`tests/palmbus.js`, `tests/boot.js`), then jshint and a parse of every
module. The credentials in the tests are made up.
