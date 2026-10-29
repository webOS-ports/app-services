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
Service for various contacts-related methods: vCards (count, read, import,
export), favourites and their defaults, contact photos, the persons' sort
keys when the contacts app's sort order changes, finding a person by phone
number, and the phone numbers normalised again for a new region.

The service is a Node 22 rewrite of the mojoservice service, for the
launcher's plain-node path (`run-js-service` requires the directory, as it
has a `package.json`, and calls `run()`). The Foundations, mojoservice and
contacts frameworks are no longer loaded. Globalization and phonenumberlib
still are, from the device (`lib/frameworks.js`), for the locale the system
has.

| | |
|---|---|
| `service.js` | start-up: the bus, the locale, the frameworks, the methods |
| `lib/commands.js` | the 16 bus methods, answering as the old service did (`lib/mojo.js`) |
| `lib/records.js` | contact and person entries with the defaults the framework gave them |
| `lib/person.js` | a person read, made a favourite or not, its defaults, saved with its backups |
| `lib/photos.js` | a contact photo cropped (file cache or `/media/internal/.contactphotos`) and saved |
| `lib/vcard.js` | the vCard reader and writer |
| `lib/prefs.js` | the contacts app's prefs record (sort order, default account, phone region) |
| `lib/model.js`, `lib/linkhash.js` | names, phone numbers and contact hashes, as the contacts linker has them |
| `lib/bus.js`, `lib/db.js`, `lib/mojo.js`, `lib/frameworks.js` | the bus, db8, mojoservice's replies, the device's frameworks |

The first version gives the old service's replies and writes what it
wrote, bugs included. It was checked by an A/B test: the old service, run
unchanged on the host from the VM's frameworks, and this one ran the same
generated scenarios (persons and contacts as the linker leaves them, vCard
files, prefs, then every method with good and bad arguments), and every
step's reply, db8 contents, files written and calls to other services were
compared. The bugs are then mended one commit at a time, each with its own
test. The old service's bugs, by number:

- C1 (mended): `importVCard` answers `-9999 "contacts.map is not a function"` for
  every import that finishes, after it has saved every card: the service
  mapped over the importer's result, which is `true`. A missing file, or a
  first card that cannot be read, answers the same, having saved nothing.
  An account with no contacts kind answers `NO_PROVIDER_FOR_CONTACTS` with
  no `errorText` (the error was a plain object), and `exception`
  `"[object Object]"`.
- C2: `importVCard` never answers (until its 3600 s timeout) when the
  default account cannot be read, or a contact cannot be saved; `readVCard`
  and `importVCard` the same when a card after the first cannot be read.
- C3: `deleteContactImage` never deletes: with a path it fails with
  `"webOS is not defined"` (it called a Triton-only function), without one
  it never answers until its 60 s timeout.
- C4: a phone number, email or IM with no `favoriteData` of its own shares
  one default object with every other such point, for as long as the
  service runs. A default set on one is set on all of them; the clean-up of
  the app's other defaults then removes it from all of them, the chosen one
  too, so the default is lost; and what is left stays on that shared object
  for the next persons the service saves.
- C5: `favoritePerson` with `defaultData` reads the person twice: the
  default is set on the second copy, which refuses a person that is not a
  favourite yet, and for one that is, the first copy is saved after it and
  writes the points back without the default.
- C6: `vCardExportOne` and `vCardExportAll` always write vCard 3.0: the
  service passed `vCardVersion`, the exporter read `version`.
- C7: the vCard URL labels are off by one: a work URL is labelled `HOME`,
  a home URL `TYPE=` with no label.
- C8: `findPersonByPhone` with `returnAllMatches` lists the worst match
  first.
- C9: `sortOrderChanged` reads the persons without their `sortKey`, so it
  rewrites every person's sort key every time; called by hand (no
  `$activity`) it writes them and then fails with a `TypeError` on the
  missing activity.
- C10: `refetchPhoto`'s default crop for a photo with no `cropInfo` has
  the wrong shape: the image service is sent no focus and a scale of
  `null`.
- C11: `preBackup` lists the photos of the first 500 Palm Profile contacts
  only, and an empty path for every photo without a value.
- C12: `findPersonByPhone` searches for the normalised form
  `updatePersonLocaleAll` writes, which is not the form the linker writes:
  a 10-digit number the linker normalised is not found, and a shorter
  number that ends the same way is. `updatePersonLocaleAll` writes that
  other form (`-<subscriber number>---`, from the parsed number), so after
  it the linker's phone matches no longer line up with what it stored.
  Not mended here: the two forms are the linker's and this service's
  together, and which one is right is a decision of its own.
- C13: an organization's `location` was written as the framework's Address
  object, internals and all, and each save of the contact wrapped the
  stored one once more, one level deeper.
- C14: `SetUpWatch`'s own mojoservice activity was never completed (its
  assistant's `complete` did nothing).

These things deliberately differ from the old service:

- An organization's `location` is written as the address (C13).
- No activity is made for a command called without one. mojoservice made
  one (`<command>_<n>`) for every such call and completed it after;
  `SetUpWatch`'s it left behind (C14).
- A callback from activitymanager adopts its activity with `wait: true`,
  as the contacts linker does (its README says why).

Tests
-------
    CONTACTS_FRAMEWORKS=<a copy of a device's /usr/palm/frameworks> tests/run.sh

This runs the unit tests (`node --test`) over an in-memory db8
(`tests/fakedb.js`) and a stand-in bus, then jshint and a parse of every
module. The service needs the device's globalization and phonenumberlib;
without `CONTACTS_FRAMEWORKS`, the tests are skipped and say why.
`CONTACTS_TEST_TMP` is where they write their vCards (the system's
temporary directory by default).
