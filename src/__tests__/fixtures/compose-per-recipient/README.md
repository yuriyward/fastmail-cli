# Synthetic mail-tracker compose output

The receipt and eight body files are unmodified output from the actual
`src/cli/compose.ts --per-recipient` CLI in mail-tracker, branch
`tower/c7fd8f850d62aaaf276a`, commit
`ec1b7de7265a44b92070dc9884251607b1e27261`.
The fastmail-cli regression test reads these files directly; it needs no tracker
checkout, DOM library, Worker or network access.

Generation used these synthetic inputs:

- To `bob@example.org`, Cc `carol@example.org`, Bcc `blind@example.org`.
- Subject `Compose contract fixture`.
- Plain body `Hello team,\nPlease read https://example.org/guide\n`.
- Template `<div>{{body}}<p>Regards, Owner</p></div>\n`.
- Origin `https://tracker.example.org`, dummy credential `synthetic-token`.
- Output directory `src/__tests__/fixtures/compose-per-recipient`.

A Bun preload replaced fetch: only `/api/messages` on that origin was accepted;
no request reached a network service. It returned status 201, `shared:false`,
message token `M` repeated 22 times, and one set for each address. Image tokens
were `A`, `B`, `C` repeated 22 times; redirect tokens were `D`, `E`, `F` repeated
22 times, each targeting `https://example.org/guide`. The producer generated the
synthetic draftId itself. No personal mail, credentials or production tokens are
in these fixtures.
