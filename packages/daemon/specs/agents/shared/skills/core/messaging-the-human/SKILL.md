---
name: messaging-the-human
description: "Use when project policy calls for a human decision or update, a human delivery is pending or failed, or a reply must resume the right work."
metadata:
  cli_surfaces_referenced:
    - gateway human list
    - gateway human show
    - queue create
    - queue transitions
    - queue block
    - send
  openrig:
    stage: provisional
    audience: all agents
    sibling_skills:
      - queue-handoff
      - openrig-user
---

# Messaging the Human

Project World supplies **when and why** to contact a human. This skill supplies
transport-neutral mechanics; installing it does not create an approval gate or
choose a connector. If policy leaves a material decision ambiguous, identify the
missing authority. Do not convert a solvable technical failure into a human gate.

## Discover, check, send, inspect

Discover the registered participants and inspect the chosen human:

```bash
rig gateway human list --json
rig gateway human show <entityId> --json
```

Use the returned `address` (`<entityId>@external`), not a username, remembered
seat, connector handle, or guessed kernel address. Where several humans exist,
use the decision ownership in Project World. An absent or ambiguous registration
needs a named registration correction, not a fallback address.

Check readiness: configured, enabled, active, ready, reason, and next action.
`indeterminate` is not ready. Follow the reported next inspection; do not enable
or reconfigure a connector merely to make the check pass.

Author for the person reading on a phone: a short subject in `--summary`, then
one complete brief in `--body-file`. State why it matters, your recommendation
and material tradeoff, the bounded action if approved, and the choice requested.
For an update, state the user-visible outcome and “No action needed.” Aim for
roughly 100–150 words; this is guidance, not a semantic validator. Keep technical
continuation, exact candidate/revision and evidence on the owning agent row and
in the durable artifact behind `--evidence-ref`. A local path is not a phone link
and Markdown evidence files are not automatically attached.

For example, a synthetic brief could say:

> The repaired status view is ready. I recommend updating this instance; live
> status will briefly pause. Sessions will be preserved. Approve this instance
> update, or hold? Supporting test detail follows in this thread.

This example grants no authority. Choose `--human-intent decision` for a request
or `--human-intent update` for a quiet FYI. Omission retains legacy decision
behavior; words such as “FYI” and tags do not change intent.

The sole outbound human-message primitive is:

```bash
rig queue create --destination <entityId>@external \
  --human-intent decision --summary "<short subject>" --body-file <brief-file> \
  --evidence-ref <durable-evidence> --verify --json
```

An optional `--human-detail-file <path>` supplies one coherent supplemental
reply in the same thread. Announce its purpose in the brief; the product also
marks that a detail reply follows. The primary must already contain the complete
scope, options and action. Do not split an agent dump blindly or move the essential
choice into overflow. Rendering checks every part and its accessibility fallback
before posting; an oversized request is refused with a field-specific correction,
never silently clipped. Shorten the brief or related detail as directed. Inspect
the failed row, then deliberately cancel/replace the authored request if its
content needs correction; a timeout alone is never a reason to replace it.

A follow-up **update** about earlier work ("the change you approved is merged")
can post into that item's thread with `--reply-to <earlier-qitem-id>`. It is
accepted only with `--human-intent update`. Name the item whose thread the
human saw, such as the parked row, and create the update on the same host as
that item. Send the update from the seat that owns that thread: the seat that
parked the row, or the author of the earlier item. A human reply in a thread
reaches its owning seat, so an update from any other seat posts as a new
message. It also posts as a new message, rather than being refused, if the
earlier thread is missing or closed. With the Slack connector's
`explicitAnswersOnly` off, it also posts as a new message while the earlier item
still waits on the human, since any reply in that thread would answer the
decision. In every such case the `--verify` result says `threaded: false` with
the reason.

With `explicitAnswersOnly` on, a human's typed reply in a decision's thread is
**conversation**: it reaches you tagged `conversation` and resolves nothing.
Answer it in the same thread with `--human-intent update --reply-to
<decision-id>`. When you believe you have their answer, offer it with
`--confirm "<your reading>"` on that update; never treat prose such as "yes" as
approval. Pick the kind that fits:
- an action to approve (merge a PR, close an issue): a decision with
  `--confirm "<the action>"`; it shows that button and "Not now";
- a plan or long text to approve: a plain decision; it shows "Confirm" and
  "Not now";
- a choice: `--human-questions-file` option buttons;
- information to acknowledge: `--human-intent ack`; no buttons, the human
  reacts ✅ ("acknowledged"); you keep working meanwhile.
"Not now" resolves the decision as "not now": propose something different in
its thread. 👍/👎 on any of your messages is feedback, never a decision; on 👎
you get a row: propose an alternative, do not ask why. For a yes/go decision,
put the action on a button with
`--confirm "<call to action>"` on the decision itself (e.g. "Build it", "Write the
issue"); a click approves with exactly that text. The decision resolves, once,
on a button click, a reply starting with `answer:`, a Confirm click (with
exactly your stated reading), or a ✅ from the asked human (on an acknowledgement
request it means "acknowledged"; on a decision with buttons it does nothing). After a click, the buttons
turn into the outcome; an offer that lost to another answer shows "Not used". Answering does not close the request. Link its outcome with
`--link pr:<url>`, `--link issue:<url>` or `--link qitem:<id>` on `rig queue
update` or `create`: the thread closes once every linked outcome is finished, or
when the human replies `cancel`. A request quiet for `staleReminderDays` (default
3) reminds the human while unanswered and you once answered; reminders close
nothing.

A **decision** with a few clear choices can carry `--human-questions-file <path>`:
a JSON array of 1–4 questions, each
`{"id", "question", "options": [{"id", "label", "recommended"?}]}` with 2–4
options (labels up to 75 characters, at most one recommended). Slack shows each
question as a row of buttons. Each click records that answer on the item, and
the decision resolves once every question has one. You then receive one reply
row listing the answers, and the item's `humanAnswers` holds the option ids. The
human may instead answer in the thread (any reply with `explicitAnswersOnly`
off, an `answer:` reply with it on), so read the reply rather than assuming an
option was picked. Keep the
brief complete: the questions add buttons, they do not replace the explanation.

If an existing agent-owned row must wait for a **decision**, block it on the **new live qitem ID**
(`rig queue block <work-id> --on <human-qitem-id> ...`), not on the human address.
Completion of the human qitem resumes its dependants. Blocking on the human as
well would issue another notification for the same decision.

The row persists before bounded delivery verification. Read its qitem ID and
verification result; `posted` proves connector posting, **not human readership**.
`transport-failed`, `never-posted`, or a pending/indeterminate result leaves the
row intact. Inspect that same row and its next action; never create a second row
or blindly resend because verification timed out.

```bash
rig queue transitions <qitem-id>
```

For `update`, confirmed complete delivery may close the delivery obligation.
It creates no approval obligation and cannot be used as a decision blocker.
Delivered updates remain queryable for Feed; a failure or ambiguous send stays
separate. A root message alone does not prove supplemental delivery. Retries
reconcile stable part identities and send only missing parts. An FYI reply is
not a human decision.

For a decision, a correlated reply binds to that exact human and qitem and records the resolution
that resumes the owner. Check the recorded result before claiming the decision
arrived; a delivery receipt alone is not acceptance.

## Existing blockers and other channels

An existing agent-owned row may be blocked on `<entityId>@host`. That is an
internal custody label resolved through the human registry to the same external
participant; it is not a second delivery address. Keep the owner and continuation
on that row. Inspect its existing delivery receipt before considering another
request, so a legacy blocker does not produce a duplicate message. Never derive
`@host` from the current rig name.

`rig send` reaches an agent's terminal only. It is not a human transport or a
durable human obligation. Agent-to-agent work uses the queue handoff path.
Connector-specific configuration and handles belong to registry/readiness tools,
not to project-independent message instructions.
