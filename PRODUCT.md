# fastmail-cli

**Job:** "When an AI agent works for me on my personal Fastmail mail, I want it to list, search, read, follow threads, download attachments and draft through one predictable CLI, so that it can answer about my mail and prepare replies without ever sending anything I did not approve."

## Users

| Who | Uses it to |
| --- | --- |
| An AI agent acting for the mailbox owner, through `ward-access fastmail` | List, search and read mail and threads, download attachments, create drafts, preview and (after approval) send them, trash mail |
| The mailbox owner | Approve the exact preview of what is sent |

Not a user: anyone wanting calendar, contacts, masked email, sieve, vacation, push or several accounts (owner, 2026-11-09: mail only, one account).

## Never

- **N1** Send without `--user-confirmed` and a matching `--expect` digest, which the agent passes only after the owner approved that whole preview. This is a CLI courtesy; the enforcement boundary is ward-access, which holds the token and gates `EmailSubmission/set`.
- **N2** Commit tokens, mail, exports or mail-derived fixtures; tests and examples use synthetic identities.
- **N3** Pick recipients fuzzily; every recipient is one exact address per flag. Replies take the original's Reply-To, else From, and `--all` its To and Cc minus your own identities.
- **N4** Reads never set `$seen` or write. Trash replaces mailboxes with exactly Trash. Permanent deletion is limited to accepted split recipient drafts through submission creation references (owner-approved split design v3, 2026-11-12).

## Contract

- Auth: `FASTMAIL_ACCESS_TOKEN` only, sent as a Bearer token. No login; ward-access passes a dummy and injects the real token at its proxy.
- Discovery: `GET https://api.fastmail.com/jmap/session`; `apiUrl`, `uploadUrl`, `downloadUrl` and the primary mail account come from it. Mailboxes are resolved by role. Proxy from `HTTPS_PROXY`, extra CA from `NODE_EXTRA_CA_CERTS`.
- Writes: one `Email/set create` into Drafts with `$draft`; `Email/set update` of mailboxIds to exactly Trash; one `EmailSubmission/set create` with a literal email id, the identity matching the draft's From and `onSuccessUpdateEmail` moving it Drafts → Sent and clearing `$draft`.
- Split writes: `drafts create-split` creates N recipient drafts and one self draft. `messages send-split` submits N explicit one-address envelopes in one request, destroys only accepted recipient drafts, and separately moves the self draft to Sent only after a known outcome with at least one acceptance; mixed outcomes add `$ward-partial`. See README for the wire contract.
- Digest: `sha256:` of the draft's raw message blob. The preview lists every leaf MIME part and every text value in full; a truncated or undecodable text part refuses it.
- Reads retry 429 with Retry-After; writes never retry. A lost submission is `outcome_unknown`; a failed Sent move after an accepted submission is sent with a warning.
- `--json` output carries `schemaVersion: 1`; lists carry `complete` and `cursor`; mail-derived text is marked untrusted.

## Design

ward-access `docs/design/2026-11-09-fastmail/` (design v1.1 and its review).

## Changelog

- 2026-11-09: created from the owner-approved design ("має сенс", "all good, u can work").

- 2026-11-12: implemented owner-approved split design v3; token verification, durable approval consumption and journal remain ward-access responsibilities.
