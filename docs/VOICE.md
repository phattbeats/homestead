# Homestead Voice Guide

The voice that Homestead writes in is intentional. It's an editorial product
decision, not an accident of how the templates happened to fall out. This
guide captures the rules so the voice stays a decision when contributors
add or change surface copy.

## Core register

**Warm, dry, slightly amused.** Homestead is a household app, not an
enterprise tool. We do not write in compliance register, we do not write
in utility CLI register, and we do not write in pure cheerful-marketing
register either. We write like a friend who happens to be very good at
running a house — the way that friend would text you about it.

Examples of the register:

| Surface | Copy | Why it lands |
|---|---|---|
| Tasks empty | "Nothing to do. Suspicious." | Self-aware about the rare state, doesn't pretend the user has "achieved" anything. |
| Install coach body | "Notifications only work once Homestead is on your Home Screen." | Plain explanation, no chiding. |
| Greeting | "Morning, Brandon." / "Afternoon, Alex." | First name, plain time-of-day — the kind of header you'd see from a roommate. |

## Rules

1. **Empty states are editorial surfaces.**
   An empty state is the user looking at a screen that hasn't accrued
   content yet. The copy on that screen teaches the user the *register*
   we want them to expect. "Nothing to do. Suspicious." (the Tasks
   empty state) is kept because it lands in the warm/dry register and
   because it implicates the user in the joke. Don't replace empty
   states with `No data yet.` That strips the only first-impression the
   surface gets to make. **When you add a new empty state, write copy
   that fits the register above. Don't leave a placeholder.**

2. **One voice, no shifts across modules.**
   Homesteader, agent drawer, calendar, all of it shares the register.
   If a third-party module's copy reads like a different product, the
   install is wrong, not the host — fix it at install time per the
   PHA-2201 manifest contract.

3. **No exclamation marks unless something actually happened.**
   Saved a task — "Saved." is fine. Notifications enabled — "On." is
   fine. The app does not congratulate the user for opening it.

4. **Plain error copy, on the page, not in a dialog.**
   Errors are inline with `color:#b3453a; font-size:13px; min-height:18px`.
   Dialogs are reserved for actions the user is about to take (confirm
   a destructive op, install a third-party app). Errors never gate
   progress behind a modal the user has to dismiss to read.

5. **The user is always the subject.**
   "You can revisit this from the avatar menu under Set up notifications."
   is fine. "The user may re-engage the optional secondary surface at
   their convenience" is not — even rewritten, that's not how this app
   talks.

## Surfaces that are NOT editorial

These are deliberately flat because the content is the message:

- **Permission status chips**: `On` / `Off` / `Denied`. No colour commentary.
- **Dates and times**: RFC-style formatting (`Aug 23, 2026 · 9:14 AM`).
- **Form labels and helper text**: imperative + terse.
- **Logs / analytics strings**: enums; never shown to the user.

If a contributor adds an emoji or exclamation to one of these, that's
the bar for "wrong surface" — flatten it.

## Decision log

- **2026-08-23 — PHA-2498 #4 (kept "Nothing to do. Suspicious.")**
  Reviewer flagged that the empty-state voice was charming and within
  the editorial register, but that registering it as an editorial
  surface (rule 1 above) was implicit in the codebase rather than
  documented. Rule 1 captures it. The copy stays.

- **Future**: add entries here when a reviewer overrules an empty
  state (or defends one against a "this isn't a joke app" rebuttal).
  The bar for changing existing copy is "the register is wrong," not
  "I would have written it differently."
