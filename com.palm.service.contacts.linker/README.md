# Copyright and License Information

All content, including all source code files and documentation files in this repository except otherwise noted are:

 Copyright (c) 2010-2013 LG Electronics, Inc.

All content, including all source code files and documentation files in this repository except otherwise noted are:
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this content except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Quick Info
-----------
Contacts Linker Service for webOS. Takes a contact and finds similar contacts to join together to create people.

Core
-------
This repository contains the service for linking contacts.

The service is a Node 22 rewrite of the mojoservice linker, for the
launcher's plain-node path (`run-js-service` requires the directory, as it
has a `package.json`, and calls `run()`). The Foundations, mojoservice and
contacts frameworks are no longer loaded. Globalization and phonenumberlib
still are, from the device (`lib/frameworks.js` says why).

| | |
|---|---|
| `service.js` | start-up: the bus, the locale, the frameworks, the methods |
| `lib/commands.js` | the 13 bus methods, answering as the old service did (`lib/mojo.js`) |
| `lib/autolinker.js` | a run over the changed contacts: link, refresh, or a person of its own |
| `lib/rankers.js` | which persons a contact looks like: name, mobile, email, IM, manual links and unlinks |
| `lib/person.js`, `lib/model.js` | a person made from its contacts, as the contacts framework made it |
| `lib/savenew.js` | `saveNewPersonAndContacts`, which the contacts app saves a new contact with |
| `lib/clb.js`, `lib/linkhash.js` | the manual link and unlink records and the hashes they are keyed on |
| `lib/watch.js` | re-arming the `linkerWatch` activity at the `_rev` a run reached |

The first version reproduces the old service's linking decisions exactly,
including its bugs. It was checked by an A/B test: the old service and this
one ran on the same seeded contacts, edits, deletes, manual links and
unlinks, saves and watch callbacks, and every step's reply and db8 contents
were compared. The bugs are then mended one commit at a time, each with its
own test. These are the ones that are still there (the code and tests refer to
them by these numbers):

- Q7.4: `setupWatch` always fails: it calls a function that was renamed.
- Q7.5: `saveNewPersonAndContacts` takes out the contacts that have an
  `_id` by splicing while it loops, so a contact with an `_id` that follows
  another one gets a new id instead of its own.
- Q7.8: `performedUnlink` over the bus always fails: it wants the
  framework's person object.
- Q7.9: `getManualLinks` / `getUnlinkLinks` over the bus never work: with
  an id they do not answer until the command times out (504), and with a
  contact object they want the framework's contact.
- Q7.12: the contacts are read without paging, so `forceAutolink` handles
  only the first 500.
- Q7.14: the phone lookups share one `where` clause, so every one of them
  asks for the contact's last mobile number.
- Q7.15: a mobile number is looked up by a key (Globalization's subscriber
  number) that is not a prefix of the key the person stores it under
  (phonenumberlib's). Ordinary 10-digit US numbers and NL mobile numbers
  never find a match.
- Q7.17: a person keeps IM entries with an empty value, so a contact with an
  empty IM links to every person that has one.
- The manual unlink check reuses one variable for the contact ids it walks,
  so it can read past the end of a person's ids and fail the contact with
  a `TypeError`.
- When there are several speed-dial backups, every one of them restores the
  first one's numbers.

These things deliberately differ from the old service:

- The old service wrote the framework's own Address object, internals and
  all, as an organization's location; this writes the address.
- The four similarity rankers (name, phone, email, IM) run one after the
  other, in that order. The old service ran them at the same time, so the
  order in which their persons came in depended on which db8 reply came
  back first. That order breaks ties: which person keeps its record, and
  the order of a merged person's `contactIds`. On the VM, two runs of the
  old service over the same 200 contacts once ended with 141 and 142
  persons. The order used here is the one replies take when they come
  back in the order they were asked for.
- When `linkerWatch` cannot be completed, it is created again from the
  revision the run reached.
- activitymanager's callbacks adopt the activity with `wait: true`. A run
  that leaves changed contacts behind (more than the 500 a run reads, or
  contacts changed while it ran) is called back at once, while the run
  before it still holds the activity. mojoservice's adopt did not wait, so
  it failed with errorCode 11 ("Resource temporarily unavailable"), the
  callback ran nothing, and `linkerWatch` stopped: on the VM the old
  service linked 491 persons out of 1000 contacts and no more. The callback
  now runs once the activity is handed over to it. A callback for the
  activity and `_rev` of one still running is that callback delivered
  again, and runs nothing (activitymanager's callback serial cannot tell
  them apart: it is seeded from the time in seconds).
- `dbUpdatedRelinkChanges` called by hand, from no activity, re-arms
  nothing. The old service re-armed the activity mojoservice had made for
  the call, which turned every such call into one more watch that called
  it back.

Tests
-------
    LINKER_FRAMEWORKS=<a copy of a device's /usr/palm/frameworks> tests/run.sh

This runs the unit tests (`node --test`) over an in-memory db8
(`tests/fakedb.js`) and a stand-in bus, then jshint and a parse of every
module. The tests that link need the device's globalization and
phonenumberlib; without `LINKER_FRAMEWORKS`, those tests are skipped and
say why.
