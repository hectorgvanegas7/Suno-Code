# Lessons / gotchas

Running log of real bugs hit while building this automation, so they don't get
rediscovered from scratch. Newest first.

## Multi-recipient surveys broke name validation entirely

`hardValidate()`'s name check used to grab the survey's "What's their name?"
field and take its *first word* as the dedicatee's name. For a single name
("Frank") that works. For a multi-recipient survey ("Mis hijos Christopher y
Soraya.") it took **"Mis"** as the name — then told the model on every retry
that "Christopher" and "Soraya" (correctly used per the MULTIPLE RECIPIENTS
prompt rule) were wrong and must be replaced with "mis". After 3 contradictory
correction rounds the model gave up and dumped raw chain-of-thought reasoning
into the response instead of a song, which got saved straight into `song.txt`.

**Fix:** extract candidate names by filtering out a filler-word list (mis, mi,
hijo, hija, hijos, hijas, y, and, su, sus, el, la, los, las, de, del) instead
of assuming the first word is the name. Validate each chorus's opening word
against the *set* of names, not a single fixed one.

**Takeaway:** any time the system prompt grows a new structural rule (multiple
recipients, parent format, phonetic respelling, etc.), check whether
`hardValidate()`'s assumptions still hold — it was written before any of those
existed and silently assumed exactly one recipient with no respelling.

## Suno fill scripts pasted `**Advertencias:**` into the lyrics box

When the `Advertencias` field was added to `song.txt`'s format, `suno-fill.js`
(then `suno-fill2.js`) still parsed "everything between `[Verse 1]` and
`NOTES:`" as the lyrics — which now included the Advertencias paragraph in
between. It got typed straight into Suno's lyrics textarea. Caught by the
required visual-verify screenshot before clicking Create, not by any
programmatic check.

**Fix:** stop the lyrics slice at whichever comes first, `**Advertencias:**`
or `NOTES:`.

**Takeaway:** the visual verify-before-Create step is not a formality — it's
caught a real defect every time it's been used so far. Never skip it.

## "Assign Most Urgent Song" — click target vanishes mid-click

After clicking "Enter Flow", the page briefly renders a default/loading state
(sometimes showing the "Assign Most Urgent Song" button) before client-side
code confirms whether an assignment is already active and swaps to the real
view. A script that checks for the button immediately and clicks it can be
clicking an element that's about to be replaced — Playwright reports "element
was detached from the DOM, retrying" and eventually times out. This is
deterministic (not flaky) whenever there's already an active assignment from
a previous session.

**Fix:** wait ~2s after "Enter Flow" for the page to settle, then check for a
concrete signal that an assignment is loaded (`#lyrics` field present) instead
of checking for the *absence* of the assign button.

## Toggling a panel that might already be open (e.g. Suno's "More Options")

Blindly clicking a show/hide toggle assumes a known starting state. On a
retry (form already filled once), the panel can already be expanded, and the
naive click collapses it instead — then the next step (clicking "Female"/
"Male" inside it) fails because the button is now hidden.

**Fix:** check whether the element you actually need (e.g. the gender button)
is already visible before clicking the toggle. See
`lib/playwright-helpers.js`'s `expandIfCollapsed`.

## CDP lifecycle pattern (Chrome automation that must survive logins / stay open)

- Launch Chrome as a **plain OS process** (`spawn`/`Start-Process`), not via
  Playwright's `launchPersistentContext`, when the session needs to survive a
  Google OAuth login or stay open after the script exits.
  - Playwright's automation flags (`--enable-automation`,
    `--remote-debugging-pipe`) make Google's OAuth flow show a "this browser
    may not be secure" block. A plain launch with a fixed
    `--remote-debugging-port` avoids it.
  - `launchPersistentContext` ties the browser's life to the controlling Node
    process via the debugging-pipe transport — closing/exiting that process
    closes Chrome too, even with a keep-alive promise.
- Chrome refuses remote debugging if `--user-data-dir` points at the literal
  default Chrome profile dir — needs a dedicated automation profile dir.
- Short-lived scripts then just `chromium.connectOverCDP('http://localhost:<port>')`,
  do their work, and disconnect (`browser.close()` on a CDP-attached browser
  just disconnects, it's safe).
- Gotcha: two scripts sharing the same `--user-data-dir` + `--profile-directory`
  can hijack/close each other's window due to Chrome's singleton behavior —
  don't run `run.js` while a Suno fill session needs to stay open.

## Flaky page-transition retries

Occasional one-off timeouts on button clicks during page transitions (survey
read finds 0 rows, or a generic detach-retry) have so far always been resolved
by simply rerunning the script. Worth distinguishing from the deterministic
"Assign Most Urgent Song" bug above — if the *same* script fails the *same*
way 2-3 times in a row, that's a real bug, not flakiness; investigate instead
of just retrying again.
