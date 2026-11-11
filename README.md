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
