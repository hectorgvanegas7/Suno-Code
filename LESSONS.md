# Lessons / gotchas

Running log of real bugs hit while building this automation, so they don't get
rediscovered from scratch. Newest first.

## start-flow Paso 4/4 falló: lógica de "Enter Flow + Assign" duplicada y divergente (2026-06-28)

`start-flow.js`'s `openFlowTab()` raised "No se encontró #lyrics en el Flow
después de Enter Flow" on a run where there was already an active assignment.
Root cause: there were TWO copies of the "enter the Flow and make sure an
assignment is loaded" logic. `run.js` had the complete version (Enter Flow →
wait → check `#lyrics` → if missing, click "Assign Most Urgent Song"), but
`start-flow.js`'s `openFlowTab()` had an incomplete copy that clicked Enter
Flow, checked `#lyrics` once, and gave up — it never clicked "Assign Most
Urgent Song". So whenever the Flow tab had been left at the landing state
(run.js closes its own Chrome at the end, shared profile), Paso 4 died.

**Fix:** extracted the canonical logic into `lib/flow-helpers.js`
(`enterFlowAndEnsureAssignment`) with retry/backoff, and made BOTH run.js and
start-flow.js import it. Single source of truth — they can't diverge again.

**Takeaway:** any piece of flow-navigation logic that lives in more than one
script is a divergence bug waiting to happen. When run.js and start-flow.js
(or any two scripts) need the same browser dance, it goes in `lib/`, not
copy-pasted. Also added `lib/pipeline-state.js` (state.json) so later steps can
detect if they're about to process a different song than the one generated.

## Checklist validator rejected "N/A" on a conditional item, burning all 3 attempts (2026-06-20)

The system prompt's checklist template has `Destinatarios múltiples
balanceados (si aplica): ✓/✗` — the "(si aplica)" means the item is
conditional, and for a single-recipient song (most of them) the only honest
answer is "N/A", not "✓". `hardValidate()`'s checklist check only accepted
lines containing a literal `✓`, so every single-recipient song got this
item flagged as a self-reported failure and burned all 3 regeneration
attempts before saving with the "no pasó la validación" warning banner —
even though the lyrics were correct from attempt 1.

**Fix:** lines containing `(si aplica)` are now also allowed to pass with
`N/A` (case-insensitive), as long as they don't also contain `✗`. Other
checklist lines still require a literal `✓`, unchanged.

**Takeaway:** any checklist item phrased as conditional ("si aplica") needs
its own pass condition in `hardValidate()` — don't assume every item reduces
to the same ✓/✗ binary just because the template prints `✓/✗` for all of
them.

## REDO chain-of-thought preamble leaked into song.txt, checklist symbol mismatch hid a real flag (2026-06-19, "Harry jode" song)

On a REDO with a structurally broken original (extra Pre-Coro/Puente sections),
Claude's response opened with several paragraphs of visible reasoning ("I need
to fully restructure this song because...") *before* the `**Título:**` block —
violating the system prompt's "no extra text before or after" rule. Nothing in
`hardValidate()` checked for this, so it passed on attempt 1 and the entire
preamble got saved straight into `song.txt` (parseSections' regex only looks
for `[Verse 1]` etc. so structural checks didn't notice; `suno-fill.js` also
parses by regex so the Suno form itself came out fine — only the on-disk file
was polluted).

Separately, the same response flagged a verbatim-quote violation (rule 13:
never quote survey dialogue directly — here a literal bathroom-singing chant)
using `⚠️ REVISAR MANUALMENTE` instead of `✗` in its own QA checklist.
`hardValidate()`'s checklist check only matched the literal `✗` character, so
this self-reported issue silently passed instead of triggering a regen.

**Fix:** `hardValidate()` now (a) fails if there's any non-empty text before
`**Título:**`, and (b) treats any checklist line that isn't a clean `✓` as a
failure, not just lines containing `✗`. `run.js` also now slices the saved
content starting at `**Título:**` defensively, even if validation is
exhausted and saved with a warning.

**Takeaway:** don't assume Claude's self-grading uses only the two symbols
shown in the prompt template (`✓`/`✗`) — validate by absence-of-pass, not
presence-of-a-specific-fail-symbol. Also: structural regex checks that scan
for markers anywhere in the text (by design, for robustness) can mask a
"there's text where there shouldn't be" bug — that needs an explicit check of
its own.

## "Priority Delivery" banner false-positived as REDO (2026-06-19)

`run.js`'s `isRedo` check tested for `div.bg-orange-50.border-orange-200` —
but that's not a REDO-specific selector. The unrelated "Priority Delivery"
banner (🚀 "This song was purchased with priority delivery") uses the exact
same orange classes and has no feedback box inside it. A priority-delivery
song with no REDO history hit the banner check, set `isRedo = true`, then
crashed in `readRedoFeedback()` because there's nothing to read.

**Fix:** call `readRedoFeedback()` first and derive `isRedo` from whether it
actually found feedback text (`div.whitespace-pre-wrap` inside the banner),
instead of from the banner's color classes alone.

**Takeaway:** any orange/red/green "status banner" class names on this site
are reused across unrelated states — never key detection logic off color
classes alone, always require the specific content/structure that only the
intended state has.

## CDP gotcha confirmed in practice (2026-06-19): run.js killed an open Suno window

The shared-profile risk documented below ("CDP lifecycle pattern") actually
fired: a Suno fill was sitting open (post-Create, screenshots already taken)
on port 9333 when `run.js` ran for the next song. `run.js`'s `finally` block
unconditionally calls `activeContext.close()` on its `launchPersistentContext`
— and since Chrome's singleton behavior makes that call attach to the
*already-running* process (same `user-data-dir`), closing it tore down the
whole shared browser, killing the debug port and the open Suno tab with it.

**Recovery:** just re-run `suno-open-for-login.js` and `suno-fill.js` — login
persists because session cookies live in the on-disk profile, not in the
closed process.

**Takeaway:** "Hector ya clickeó Create" does NOT make it safe to run `run.js`
while that Chrome window is still open. The only safe sequencing is: close/let
go of the Suno window first (or don't open it via `suno-open-for-login.js`
until right before the fill step), *then* run `run.js`. Treat any live Suno
tab as a hard blocker until it's done being used, not just "Create was already
clicked."

## "Mezcla de trato" validator false-positives inside longer words

`hardValidate()`'s usted-mismatch check used `\bvení\b`, `\bdecí\b`, etc. — but
JS regex `\w`/`\b` don't treat accented vowels (á é í ó ú ñ) as word
characters. So `\b` fires right after the í in "ven**í**a" or "dec**í**rselo",
making "vení"/"decí" match *inside* those completely correct, usted-consistent
words. This burned all 3 regen attempts on a real run even though the lyrics
had zero actual tú/vos mixing — the model kept "fixing" something that wasn't
broken until it gave up and saved with a warning.

**Fix:** replaced `\b` with explicit negative lookahead/lookbehind against the
accented-letter class (`(?<![a-záéíóúñ])...(?![a-záéíóúñ])`) so the boundary
check actually respects Spanish word characters.

**Takeaway:** any regex-based Spanish text validator using `\b` is suspect —
audit the others (estilo Suno checks, etc.) for the same accented-boundary gap.

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
