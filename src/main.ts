#!/usr/bin/env bun
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "./args.ts";
import { attachmentsDownload } from "./attachments.ts";
import { draftsCreate, draftsForward, draftsReply } from "./drafts.ts";
import { CliError } from "./errors.ts";
import { type Fetch, Jmap } from "./jmap.ts";
import { HELP, help } from "./help.ts";
import { foldersList, messagesList, messagesRead, messagesSearch, messagesTrash, type Output, threadsRead, unknownCommand } from "./mail.ts";
import { draftsCreateSplit, messagesSendSplit } from "./split.ts";
import { messagesSend } from "./send.ts";

export const SCHEMA_VERSION = 1;
export interface Deps {
  env: Record<string, string | undefined>;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  createFile: (path: string, data: Uint8Array) => Promise<void>;
}
export interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}
const defaults: Deps = {
  async createFile(path, data) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  },
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  readFile: async (path) => (path === "-" ? new Uint8Array(await Bun.stdin.arrayBuffer()) : readFile(path)),
  sleep: (ms) => Bun.sleep(ms),
};
async function dispatch(argv: string[], deps: Deps): Promise<Output> {
  const parsed = parseArgs(argv);
  const words = parsed.words;
  const key = words.join(" ");
  if (parsed.bools.has("help") || !words.length) {
    return { json: { help: help(key) }, text: help(key) };
  }
  const token = deps.env.FASTMAIL_ACCESS_TOKEN;
  const commands: Record<string, (jmap: Jmap) => Promise<Output>> = {
    "attachments download": (j) => attachmentsDownload(j, { create: deps.createFile }, parsed),
    "drafts create-split": (j) => draftsCreateSplit(j, { read: deps.readFile }, parsed),
    "messages send-split": (j) => messagesSendSplit(j, parsed),
    "drafts create": (j) => draftsCreate(j, { read: deps.readFile }, parsed),
    "drafts forward": (j) => draftsForward(j, { read: deps.readFile }, parsed),
    "drafts reply": (j) => draftsReply(j, { read: deps.readFile }, parsed),
    "folders list": (j) => foldersList(j, parsed),
    "messages list": (j) => messagesList(j, parsed),
    "messages read": (j) => messagesRead(j, parsed),
    "messages search": (j) => messagesSearch(j, parsed),
    "messages send": (j) => messagesSend(j, parsed),
    "messages trash": (j) => messagesTrash(j, parsed),
    "threads read": (j) => threadsRead(j, parsed),
  };
  const command = commands[key];
  if (!command) {
    unknownCommand(words);
  }
  if (!token) {
    throw new CliError("auth_missing", "FASTMAIL_ACCESS_TOKEN is not set; run through `ward-access fastmail <account> -- …`");
  }
  return command(new Jmap({ fetch: deps.fetch, sleep: deps.sleep, token }));
}
export async function run(argv: string[], overrides: Partial<Deps> = {}): Promise<Result> {
  const deps = { ...defaults, ...overrides };
  const json = argv.includes("--json");
  try {
    const out = await dispatch(argv, deps);
    return { exitCode: 0, stderr: "", stdout: json ? `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...out.json })}\n` : out.text };
  } catch (error) {
    const e =
      error instanceof CliError
        ? error
        : new CliError(error instanceof TypeError ? "network" : "internal", error instanceof Error ? error.message.slice(0, 200) : "failed");
    const { text, preview, ...details } = e.details ?? {};
    const stdout = preview ? (json ? `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, preview })}\n` : `${text}\n`) : "";
    const stderr = json
      ? `${JSON.stringify({ error: { code: e.code, message: e.message, recovery: e.recovery ?? null, ...details }, schemaVersion: SCHEMA_VERSION })}\n`
      : `error ${e.code}: ${e.message}${e.recovery ? `\ntry: ${e.recovery}` : ""}\n`;
    return { exitCode: e.exitCode, stderr, stdout };
  }
}
export { HELP };
if (import.meta.main) {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
