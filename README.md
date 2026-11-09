# fastmail-cli

A small CLI that lets an AI agent read and draft personal Fastmail mail over JMAP. It never holds credentials: it reads an API token from `FASTMAIL_ACCESS_TOKEN`, and in production that is a dummy that the ward-access proxy replaces. Sending needs the owner's approval of the exact preview.

```
bun install
bun run check
bun src/main.ts --help
```
