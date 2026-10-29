# Copyright and License Information

All content, including all source code files and documentation files in this repository unless otherwise noted are:

 Copyright (c) 2010-2013 LG Electronics, Inc.

All content, including all source code files and documentation files in this repository unless otherwise noted are:
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this content except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

DateJS 1.0 Alpha-1 by Coolite Inc. is licensed under the MIT License (see NOTICE).

Quick Info
-----------
Calendar reminders service for webOS: works out when each calendar event's
display alarm goes off, wakes the device for it, and has the calendar app
show the reminder, close it when the event ends, snooze it and dismiss it.

Core
-------
The service is a Node 22 rewrite of the mojoservice service, for the
launcher's plain-node path (`run-js-service` requires the directory, as it
has a `package.json`, and calls `run()`). Foundations, mojoservice and the
calendar framework are no longer loaded: the parts of the calendar
framework and of DateJS that the service used are ported in `lib/`.

| | |
|---|---|
| `service.js` | start-up: the bus, the time zone manager, the methods |
| `lib/commands.js` | the six bus methods: `onInit`, `onDBChanged`, `onWake`, `onAutoClose` (activitymanager calls them) and `onSnooze`, `onDismiss` (the calendar app) |
| `lib/reminders.js` | the reminders kind, the status record, and the wake, autoclose and db watch activities |
| `lib/alarm.js` | when an alarm goes off: the display alarm, its duration or date |
| `lib/calendar.js` | the calendar framework's next occurrence of a repeating event, and its time zone manager |
| `lib/datejs.js` | the DateJS functions those use, as plain functions |
| `lib/db.js` | db8 calls, answering as Foundations' DB did |
| `lib/mojo.js` | the replies and the `$activity` handling of mojoservice (as in the contacts linker) |
| `lib/bus.js`, `lib/errors.js` | the bus, as the cloud connectors and the messaging service have it |

What it keeps in db8:

- `com.palm.service.calendar.reminders:1`: one record per event with a
  reminder still to show or to close: `showTime` (when to show it),
  `autoCloseTime` (when to close it: the end of the event), the event's
  `startTime`, `endTime`, subject, location and calendar.
- `com.palm.service.calendar.remindersstatus:1`: one record: the last event
  `_rev` seen, `status` (`OK`, or `FAIL` to start over at the next run), and
  the ids of the three activities.

The activities: `calendar.reminders.wake` calls `onWake` at the earliest
`showTime`, `calendar.reminders.autoclose` calls `onAutoClose` at the
earliest `autoCloseTime`, and `calendar.reminders.dbchanged` (a db8 watch on
the events changed after the last `_rev`) calls `onDBChanged`. The calendar
app's `calendar.startreminders` calls `onInit` at boot.

All times go through DateJS's arithmetic, which adds through the local wall
clock: an alarm one day before an event on the day summer time ends goes
off 25 hours before it, at the same local time of day.

The first version does what the old service did, including its bugs. It was
checked by an A/B test: the old service, unchanged, on the host over the
VM's frameworks, and this one ran the same seeded calendars (single,
all-day and repeating events in eleven time zones, near DST changes, with
exception dates, counts and ends), with a clock the test sets, through the
same steps (time passing, events added, edited and deleted, snoozes,
dismisses, direct calls, failing db8, activitymanager and systemservice
calls, cancelled activities, a reboot). Every step's replies,
activitymanager calls, app launches and db8 contents were compared. The
bugs are then mended one commit at a time, each with its own test. These
are the ones that are still there (the code and tests refer to them by
these numbers):

3. A start over (status `FAIL`) looks for the activity ids on the query's
   results array instead of on its record, so it never cancels them.
   Harmless: they are created again with `replace`, which takes their
   place.
5. An exception date of a length other than 8, 15 or 16 ends the check of
   the event's other exception dates.
6. The time zone manager's daylight saving test is `dstStart <= t < dstEnd`,
   which is never true where DST spans the new year (the southern
   hemisphere), so an event in such a zone, seen from a device in another
   zone, repeats an hour off half the year.
7. The alarm duration parser takes one to three digits per part: `-PT1440M`
   is no offset at all, so a "one day before" alarm written that way goes
   off at the start of the event. Of weeks and days only the last counts
   (`-P1W2D` is two days).
8. The revision reached is the highest `_rev` of the events read, which can
   jump past events not read: more than 500 changes at once (db8's page),
   or the deleted ones' revision ahead of the changed ones'.
9. An event without an end gets a reminder with no `endTime` or
   `autoCloseTime`; `onWake` then fails on it, and none of the reminders
   of that wake is shown.
10. `onInit` reads the first 500 events only (db8's page).
11. If `getSystemTime` fails, or answers no time zone, the time zone manager
    waits for it for ever, and the command with it.
12. mojoservice made an activity for each call that brought none, and left
    the ones of `onWake`, `onAutoClose` and `onDBChanged` behind.
13. An exception date of a daily event (or of a weekly one on several days)
    skips the occurrence after it as well: the calendar framework counts the
    exception as the occurrence it was looking for, and goes on from the end
    of its search window.

Mended since the first version:

1. activitymanager will not `complete` an activity that is waiting
   ("Invalid transition: unsatisfied -> complete", errorCode -1000), and the
   old service moved its wake and autoclose activities with
   `complete({restart: true})`. It failed whenever they had not fired yet
   (an event added before the next reminder, a second snooze, a reminder
   deleted or dismissed while it was the next one); the failure ended the
   command, the db watch was not armed again, and the service no longer saw
   calendar changes until the next boot. An activity someone else cancelled
   failed the same way, every time. Now one that cannot be completed is
   created again under its name (`replace`), or cancelled when there is no
   reminder left to wait for; the same for the db watch.
2. The error handlers of the two reminder queries (next wake, next
   autoclose) and of onInit's event query read the error again, so a
   failed query left the command without an answer until it timed out, and
   what came after it undone. Now, as their comments meant: a failed
   reminder query leaves the activity as it is (status `dbError`), and a
   failed event query in onInit goes on with no events and a `FAIL` status,
   so the next run starts over.
4. One event the calendar framework could not work out (an exception date
   DateJS cannot parse, a repeating event with no start, an alarm whose
   value or action is not a string) threw, and all the reminders of that
   scan were lost; the status was `FAIL`, so every later run started over
   and failed on the same event again. Now that event is skipped, and
   logged.

These things deliberately differ from the old service:

- No activity is made for a call that brings none (12). A call from
  activitymanager adopts its activity as mojoservice did; onInit, onSnooze
  and onDismiss complete it when they are done, as mojoservice did, and the
  others leave it to their own `complete({restart: true})`.
- The bus's built-in methods are `info` and `quit`, not mojoservice's
  `__info`, `__quit` and `__gc`.

Tests
-------
    tests/run.sh

This runs the unit tests (`node --test`) on a stand-in world
(`tests/world.js`: an in-memory db8, activitymanager as the LuneOS VM
answers it, the app manager, and a clock the tests set), then jshint and a
parse of every module.
