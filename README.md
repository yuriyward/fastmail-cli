# fastmail-cli

A small CLI that lets an AI agent read and draft personal Fastmail mail over JMAP. It never holds credentials: it reads an API token from `FASTMAIL_ACCESS_TOKEN`, and in production that is a dummy that the ward-access proxy replaces. Sending needs the owner's approval of the exact preview.

```
bun install
bun run check
bun src/main.ts --help
```

Drafts require a UTF-8 plain-text body via `--body-file`. Add
`--body-html-file body.html` to `drafts create`, `drafts reply`, or
`drafts forward` for a multipart/alternative draft with both plain text and HTML:

```sh
fastmail-cli drafts create --to bob@example.org --subject "Hello" --body-file body.txt --body-html-file body.html
```

The HTML file must be UTF-8 and at most 1 MB (1,048,576 bytes); HTML is not
sanitized. Replies and forwards quote the original inside a blockquote in the
HTML part, preserving its HTML when available and otherwise escaping its text.
The plain-text quotation is unchanged. Without `--body-html-file`, drafts
remain plain text.

## Split batches

```sh
fastmail-cli drafts create-split --dir compose-out --to bob@example.org --cc carol@example.org --bcc blind@example.org --subject "Hello" --attach file.pdf
fastmail-cli messages send-split --batch <uuid>
# Show the whole preview to the owner, then use its exact digest:
fastmail-cli messages send-split --batch <uuid> --user-confirmed --expect sha256:…
```

For ward-access, pass flat input names and use `drafts create-split --dir .`.
Flatten the compose output without changing any file contents:

| Compose file | Flat input name |
| --- | --- |
| `receipt.json` | `receipt.json` |
| `self/body.html` | `self.body.html` |
| `self/body.txt` | `self.body.txt` |
| `recipients/<i>/body.html` | `recipient-<i>.body.html` |
| `recipients/<i>/body.txt` | `recipient-<i>.body.txt` |

All files belong directly in the directory passed to `--dir`. For example,
ward-access inputs use `--input self.body.html=…`, rather than paths containing
slashes. Pass attachment files with flat names too.

The original nested compose layout remains supported for local use with
`--dir <compose-out>` (including `--dir .` in that directory). The CLI selects
flat mode when `self.body.txt` exists; only its absence selects nested mode.
Once selected, the layout must be complete: missing or unreadable files fail
before uploads or draft creation. If both layouts exist, flat mode takes precedence.
Bodies must be UTF-8 and at most 1 MB each.
`receipt.json` is mail-tracker’s per-recipient receipt:
`{token, to:[], cc:[], bcc:[], items:[{i,address,imageToken,linkTokens,...}], ...}`.
Each item’s nonnegative integer `i` selects its `recipients/<i>/` directory;
addresses must match To/Cc/Bcc exactly, case-insensitively, with no duplicates.
Routing comes from `items[].address`; other receipt metadata, including tokens and
recipient role arrays, is ignored. Attachment blobs are uploaded once and shared
by every draft. All copies share one Message-ID and one Date (set once through
JMAP `sentAt`); only the self draft has Bcc. No `X-Ward-Split` header is created.

The preview exits 3 and shows the complete self body, every MIME leaf, all
recipients, Sender/Reply-To, attachments, count and digest. Truncated or
undecodable text in any copy refuses preview. The CLI requires matching common
headers and one-to-one recipient routing. ward-access must independently verify
tracking-token ownership, destinations and body equivalence, attachments, identity,
approval consumption and journal retention before admitting the send. The CLI
cannot claim those proxy checks have passed during a read-only preview.

Wire contract for the matching ward-access policy:

- Drafts have `$draft`, `$seen`, `$ward-split-<uuid>` and exactly one role marker:
  `$ward-split-self` or `$ward-split-recipient-<i>`. The role index is the zero-based
  position in **To, then Cc, then Bcc**, independent of receipt directory indices.
  These markers are local accident guards; the proxy must validate actual content
  and recipients. The single-draft send path refuses split keywords; tracker lookup
  for untagged personalised drafts belongs to ward-access.
- Batch discovery uses paged `Email/query` with `hasKeyword`; `Email/get` includes
  `messageId`, `sentAt`, full body structure/values and the headers used by ordinary send.
- The batch digest is `sha256:` plus SHA-256 of RFC 8785 JCS of
  `{"v":1,"account":accountId,"identity":identityId,"mailFrom":identityEmail,"self":{"id":selfId,"blob":rawSha256Hex},"items":[{"id":draftId,"blob":rawSha256Hex,"rcptTo":lowercaseAddress}]}`.
  Items sort by draft ID; hashes have no `sha256:` prefix inside the manifest.
  `mailFrom` preserves the selected identity's email spelling.
- One `EmailSubmission/set` contains N creates, each with literal `emailId`,
  `identityId`, and `envelope:{mailFrom:{email,parameters:null},rcptTo:[{email,parameters:null}]}`.
  No sendAt or retries. `onSuccessDestroyEmail:["#r0", ...]` references only
  this request's submission creations. Acceptance means submitted, not delivered.
- Only after a known response with at least one acceptance, a separate `Email/set`
  patches the self draft's `mailboxIds/<drafts>` to null, `mailboxIds/<sent>` to true
  and `keywords/$draft` to null; mixed results also set `keywords/$ward-partial`.
  Filing errors are reported separately from submission results.

`outcome_unknown` means do not resend blindly; no self Sent move is attempted for
unknown submission outcomes. Rejected recipient drafts stay in Drafts. Trash them
with `messages trash --id <id>`; do not send them through the single-draft path.
Partial batch creation reports created draft IDs for the same cleanup.

Fastmail limits, shared-Message-ID acceptance and alias/own-copy duplicate
suppression need a live three-address test before relying on this flow.
