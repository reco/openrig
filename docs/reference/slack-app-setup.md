# Create your own Slack app for OpenRig (experimental)

> **Experimental in 0.6.0.** The manifest (`rig slack manifest`) and this setup guide are new
> and have not been confirmed against a real app creation. The Slack connector itself and its
> `setup`, `verify`, `enable`, `disable` and `status` commands are not experimental. If a step
> here does not match what Slack shows you, please
> [open an issue](https://github.com/mvschwarz/openrig/issues/new/choose) or send a pull request
> ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

OpenRig's Slack connector talks to a Slack app that you create in your own workspace. OpenRig
ships the app's manifest; it does not host an app, run an install endpoint, or publish anything
to the Slack Marketplace. The app is a Socket Mode app, so it lives in the one workspace you
create it in.

`rig slack manifest` prints the manifest. It works offline, before any daemon or token exists:

```bash
rig slack manifest          # the manifest as YAML
rig slack manifest --url    # Slack's create-app link with the manifest prefilled
rig slack manifest --json   # the manifest, its scopes and events, and why each scope is requested
```

The TUI shows the same link on the Connections page while Slack is not configured. Neither the
CLI nor the TUI opens a browser, accepts tokens, or creates an app.

## Steps

These are the expected steps, based on Slack's app-manifest documentation. They have not yet
been confirmed against a real creation run. Slack's form may ask for something the prefill did
not fill in; if so, follow the form.

1. Open the link from `rig slack manifest --url` in a browser.
2. Sign in to Slack if asked, pick the workspace, review the prefilled manifest, and click
   **Create**.
3. Under **Socket Mode**, confirm it is enabled. Enable it if it is not.
4. Under **Basic Information → App-Level Tokens**, generate a token with the
   `connections:write` scope and copy it (it starts with `xapp-`).
5. Install the app to the workspace and approve the requested scopes.
6. Under **OAuth & Permissions**, copy the **Bot User OAuth Token** (it starts with `xoxb-`).
7. Put both tokens in a private env file readable only by you (`chmod 600`):

   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

8. Invite the bot to the channel you will use (`/invite @OpenRig` in that channel).
   `rig slack verify` reports NOT ready until the app is a member.
9. Register yourself as the human the connector delivers to, with a Slack binding that names
   your Slack user ID (`rig gateway human add`; its `--help` shows the binding format).
   Messages from Slack users who are not registered are not delivered. `rig slack enable`
   needs a readable human registry: on a fresh install with no registry, or with an invalid
   one, it is refused.
10. Run `rig slack setup --channel <channel-id> --secrets-env-file <path>`, then
    `rig slack verify`, then `rig slack enable`.

## What the app asks for

Run `rig slack manifest --json` for the exact list and the reason for each scope. There are two
groups:

- **Baseline scopes**: posting messages, reading message history in public channels the app is
  a member of, and reading channel details.
  `rig slack verify` checks these.
- **Feature scopes**: `files:read` (download attachments people send), `files:write` (upload
  attachments to Slack), `app_mentions:read` (receive @-mentions of the app), `reactions:read`
  (receive emoji reactions: a ✅ that answers a decision, 👍/👎 feedback, any other reaction on an ask reaches the asking seat), `reactions:write` (show each received message's progress
  as reactions: received 👀, picked 🤔, coding ⌨️, typing ✍️, done ✅), `users:read` (tell people from bots
  among a channel's members), and `groups:history` / `groups:read` (use a private
  channel: its messages, history and membership check). `rig slack verify` warns when one of these is missing (if
  Slack returns the granted scopes) but does not require them, so a READY from verify does not
  prove attachments, mentions, reactions or a private channel will work.

If a feature scope was not granted, the effect differs by feature:

- **Attachments** (`files:read`, `files:write`): the file download or upload call fails. A
  message with an attachment that could not be downloaded is still delivered, with the failed
  file named in it. A post whose attachment could not be uploaded still delivers its text, and
  the failure appears only in the daemon log (`rig daemon logs`).
- **Mentions** (`app_mentions:read`): Slack does not deliver `app_mention` events to the app.
  Only `rig slack verify` warns that the scope is missing; nothing reports the missing events.
- **Reactions** (`reactions:read`): Slack does not deliver `reaction_added` events, so a ✅ answers
  nothing and a reaction on an ask doesn't reach the asking agent. Use a button or an `answer:`
  reply instead; a reply in the ask's thread still reaches the agent.
- **Private channel** (`groups:history`, `groups:read`): Slack delivers no messages from a private
  channel, history recovery fails there, and `rig slack verify` cannot confirm the app is a member.
  A public channel needs neither scope.

So after installing, compare the granted scopes Slack shows for the app with all ten scopes that
`rig slack manifest --json` lists.

The app subscribes to messages in public and private channels it is a member of
(`message.channels`, `message.groups`), to mentions of the app (`app_mention`), and to reactions
(`reaction_added`). It does not request direct-message access. For a private channel, invite the
app to it (`/invite @<app name>`); Slack does not let an app join a private channel by itself.

The manifest also turns on **Interactivity**, so the human can answer a decision's structured
questions by clicking a button (`rig queue create --human-questions-file`). In Socket Mode the
clicks arrive over the same socket, so no request URL is needed. An app created from an older
manifest has Interactivity off: turn it on under **Interactivity & Shortcuts**, or the buttons
will do nothing.

How a decision is answered depends on `explicitAnswersOnly` in `slack-connector.json`:

- **On (this build's default):** a typed reply in the decision's thread is conversation. It goes
  to the asking seat, which can answer in the same thread (`rig queue create --human-intent update
  --reply-to <decision>`), and it resolves nothing. Every decision shows buttons: the seat's
  action (or "Confirm"), or option buttons; typing is always possible and reaches the seat. Information
  (`--human-intent update`) has no buttons and needs no acknowledgement. 👍 and 👎 on any
  bot message are recorded as feedback and never decide. The decision resolves on a button click
  (including an approve button carrying the seat's call to action, `--confirm "Build it"` on the
  decision), a reply starting with `answer:`, a Confirm click on the seat's stated reading
  (`--confirm <reading>` on an update replying to the decision), or a ✅ from the asked human on
  their own reply in the thread (that reply's text), or on a Confirm
  offer. It resolves once; later answers reach the seat as messages.
  Answering does not close the request: its thread stays open until the outcome the seat linked
  (`rig queue update --link pr:<url>|issue:<url>|qitem:<id>`) is finished, or the asked human
  replies `cancel`. After `staleReminderDays` (default 3) without activity, an unanswered request
  reminds its human in the thread and an answered one reminds its seat. Reminders close nothing.
- **Off:** any typed reply in the thread answers the decision.

Each click gets one short reply in the decision's thread: what was recorded, or, when OpenRig
refuses the click or can't record it, why and what to do instead (the sender isn't registered, the
decision is no longer waiting for answers or was sent to someone else, the button no longer
matches its questions, or the message can't be matched to a decision). Slack's redelivery of a
click OpenRig already handled gets no second reply. The reply is best effort: while Slack is
rate-limiting OpenRig's posts it may not be posted, and the click is handled the same either way.

In the decision's `humanAnswers`, clicked answers remain option-id strings. A whole typed reply
that answers (explicitAnswersOnly off, or an `answer:` reply) is stored as `{kind: "typed-reply", text: "…", placement: "first-unanswered", unansweredCount: N}`
under the first unanswered question. That placement is automatic; it does not mean the person
selected that question. `N` counts the other question slots still empty in `humanAnswers` after
that placement. Earlier button answers are preserved; no other questions are filled in.
Read `text` as the person's words,
even when it equals an option id. The reply still closes the decision, so `done` is not approval.
A file-only reply closes the decision without recording a typed answer. If all button answers were
already recorded, they stay final and the typed reply remains in the correlated reply row.

## What the connector does with the tokens

The tokens stay in the env file you created. The connector reads them from that file and uses them
to authenticate to Slack: it opens an outbound Socket Mode connection with the app-level token and
calls Slack's Web API with the bot token. This connector has no OpenRig-hosted component and
makes outbound connections only. That statement is about this Slack connector, not about every
part of OpenRig.

## Next

- `rig slack status` shows what is still missing, without contacting Slack.
- `rig slack verify` checks the granted baseline scopes and channel membership with Slack.

## One channel per rig or seat (optional)

By default every human-bound item posts to the one channel from `rig slack setup --channel`.
To follow each rig separately, post a rig's items, or a single seat's, to its own channel:

```bash
rig slack channel-map set my-rig C0EXAMPLE1
rig slack channel-map set pr@my-rig C0EXAMPLE2
rig slack channel-map list
rig slack channel-map remove pr@my-rig
```

- **Which channel an item posts to.** The item's seat is matched exactly first (`pr@my-rig`),
  then its rig (`my-rig`). Anything unmapped posts to the default channel, so a config
  without a map behaves exactly as before. Aggregate delivery digests have no single seat and
  always post to the default channel.
- **Threads.** Updates, `--reply-to` and later notifications for an item stay in its thread.
  With a map configured, if a seat's channel has changed since the thread was opened, the
  next post opens a new thread in the seat's current channel, and `--reply-to` records the
  fallback as `root-other-channel`. With no map, threads behave exactly as before: an item's
  next notification reuses its open thread in whatever channel that thread was posted in.
- **Changing the map.** A change applies to new posts. A post already in flight (one being
  retried after a failure or an unconfirmed send) finishes in the channel and thread it started
  in, and its retry checks that channel first so it is not posted twice. This includes adding
  the first map: a post first tried before any map existed finishes in the default channel.
  Without a map, OpenRig records nothing about a post's channel, so if the default channel
  changes while a post is being retried, the retry goes to the new default channel (as it always
  has); that also applies to a post first tried before the map was added.
- **Rate limits on posts.** When Slack rate-limits a post and asks for a pause of 10 seconds or
  less, OpenRig waits that long and retries the post once. A longer pause, or a second refusal,
  is left to the retry of retained posts.
- **Replies and new messages.** A reply in an item's thread reaches that item's seat, in any
  channel. To answer it in the same thread, the seat sends `rig queue create --human-intent update
  --reply-to <the inbound reply's row>`. A message the human starts (or a reply in a thread OpenRig does not know) goes to
  the connector's inbound destination, whichever channel it is in. Missed-message recovery
  (below) covers the default channel only.

Invite the app to every mapped channel (`/invite @OpenRig`). `rig slack verify` checks
membership in the default channel and every mapped channel, and reports NOT ready until the
app is in all of them. A saved change reaches a running connector when it next rewires:
`rig slack disable` then `rig slack enable`, or a daemon restart. The TUI's Connections page
says whether the running configuration matches the file.

The map is stored as `channelMap` in `slack-connector.json`, as a list of `{ "match", "channel" }`
entries. Saving refuses any other field. A field written by a newer OpenRig is ignored when the
connector reads the file, and `rig slack status` names it. Private channels and direct messages
are not supported targets.

## Reconnect recovery and status

The daemon scans available top-level messages in the configured channel after a
Socket Mode connection and on its existing five-minute retry cadence. Recovered
tasks say **Recovered after a gap** and show the original Slack posting time.
They use the same sender admission, routing, attachment handling, fixed identity
and dead-letter path as live messages. A durable dead letter is custody of a
failed delivery, not successful delivery.

Recovery keeps a per-channel checkpoint across reconnects, restarts and channel
switches. On upgrade it initializes once from the newest retained accepted
channel landing; without such evidence it starts at feature adoption. **Older
history is unknown.** New live messages never move the recovery checkpoint. A
partial scan resumes its saved interval; only an exhausted interval advances the
covered boundary. Each new interval ends five seconds before the local clock to
allow recent messages to become visible; larger clock skew or visibility lag is
not covered by that margin. A corrupt or unreadable checkpoint leaves recovery unavailable
and preserves the existing file; live inbound continues.

Each pass admits at most four pages, 100 entries and 15 seconds of work, with a
five-second history-request ceiling. Work already started on a message, such as
an attachment transfer, is not cancelled by these limits or by a stop, and a new
pass waits for it to finish. Rate limits retain Slack's Retry-After across restart.
Transport and server failures use a five-second backoff unless Slack supplies Retry-After.
When Slack reports a plan history limit, recovery still lands the available page
and advances normally, retaining an older-history limitation in status across restarts.
Missing bot credentials, history scope, membership, retention limits and API
failures appear as recovery limitations. No additional scope is required to keep
live delivery working. Thread-reply catch-up and dead-connection detection remain
outside this recovery scope; global chronological order is not promised.

`rig slack status` retains local configuration checks and adds a bounded daemon
snapshot: socket state/generation, last event, recovery interval/state/reason,
retry time and accepted/dead-lettered recovery counts since the connector last
started (they reset when it is enabled or disabled, and when the daemon restarts).
It also reports the durable dead-letter backlog: the retained records for inbound messages,
reactions and click answers that await retry, counted from both dead-letter files so the number
survives a restart, and shown as unknown with a reason (and no count) when a file cannot be read.
Human-readable coverage and pending bounds use ISO timestamps; JSON keeps Slack timestamps.
The status read calls no Slack API and starts no scan. If the daemon cannot be
observed, local configuration remains visible and live state is unknown. A
connected socket or valid configuration alone does not prove end-to-end delivery.

## Progress on received messages

Each human message the connector receives shows the seat's progress as a reaction: received, picked
(its row is claimed; it stays while the seat works), coding (a Claude seat is editing files), typing
(it is writing its reply to the human), done (the row is closed or the seat answered in the thread).
Reactions are the only progress signal. The emoji are configurable in `slack-connector.json`:

```json
"receipts": { "received": "eyes", "picked": "thinking_face", "coding": "keyboard", "typing": "writing_hand", "done": "white_check_mark" }
```

Use any standard or custom emoji name, without colons. Slack apps cannot upload custom emoji: a
workspace member uploads them under **Customize workspace → Emoji**, then the names go here.

## Approving permission prompts from Slack

A seat listed with `rig slack setup --approval-seat <member@rig>` sends its permission prompts to
its human as Approve / Deny buttons. The message shows the full Bash command or tool input, with
credentials masked; an input too long to show in full is not sent (the prompt stays in the
terminal). Only the human the request is addressed to can answer. Each request is one-shot and
expires with the hook's 10-minute timeout; on expiry, or with no answer, the prompt appears in the
terminal as before. A deny rule in the seat's own settings still wins over an Approve. Every answer
is recorded on its queue row.

Each request carries the seat's own token (issued at launch, bound to its node, name and occupant
generation), so a seat cannot ask in another seat's name by mistake. It is not a defence against a
hostile seat: every seat runs as the same OS user, so one seat can read the token secret or another
seat's environment. The real control is the human judging the full command, the seat and its working
directory on the card.

This answers permission prompts only. It does not override a runtime's own safety decisions (for
example Claude Code's auto-mode classifier denials). Known-safe actions belong in each seat's own
settings allow rules, not here. Claude Code seats only for now; Codex seats come next.

## Channels with several people

In a channel with more than one human member, only a message that @mentions the app is for the
seat, in threads too. Every other message still reaches the seat as quiet context (tagged
`not-addressed`, no nudge, no reactions). With one human, every message is for the seat. The
connector counts members (bots excluded, via `users:read`) every 10 minutes, and at once when
someone joins or leaves (`member_joined_channel` / `member_left_channel`, part of the manifest).
