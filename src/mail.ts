import { allowOnly, cursor as position, id, limit, one, type Parsed } from "./args.ts";
import { CliError, usage } from "./errors.ts";
import { Jmap, mailboxes } from "./jmap.ts";

const LIST_FIELDS = ["id", "threadId", "subject", "from", "receivedAt", "keywords", "hasAttachment", "preview"];
const READ_FIELDS = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "sender",
  "replyTo",
  "to",
  "cc",
  "bcc",
  "subject",
  "receivedAt",
  "sentAt",
  "messageId",
  "inReplyTo",
  "references",
  "hasAttachment",
  "attachments",
  "textBody",
  "htmlBody",
  "bodyValues",
];
const ROLES = ["inbox", "drafts", "sent", "trash", "archive", "junk"];

export interface Output {
  json: Record<string, unknown>;
  text: string;
}
type Address = { name?: string | null; email?: string };
export const who = (a: unknown) => {
  const e = a as Address | undefined;
  return e ? (e.name && e.name !== e.email ? `${e.name} <${e.email}>` : (e.email ?? "")) : "";
};
export const list = (v: unknown) => (Array.isArray(v) ? v.map(who).join(", ") : "");
const unread = (m: Record<string, unknown>) => !(m.keywords as Record<string, unknown> | undefined)?.$seen;

function summary(m: Record<string, unknown>) {
  return {
    from: m.from ?? null,
    hasAttachment: m.hasAttachment ?? false,
    id: m.id,
    isRead: !unread(m),
    preview: m.preview ?? null,
    receivedAt: m.receivedAt ?? null,
    subject: m.subject ?? null,
    threadId: m.threadId ?? null,
  };
}
function listText(messages: ReturnType<typeof summary>[], cursor: string | null) {
  const lines = messages.map(
    (m) => `${m.isRead ? " " : "*"} ${m.receivedAt ?? ""}  ${list(m.from)}  ${JSON.stringify(m.subject ?? "")}  id=${m.id}`,
  );
  return `${lines.join("\n")}${lines.length ? "\n" : ""}(untrusted mail metadata; * = unread)${cursor ? `\nmore: --cursor ${cursor}` : ""}\n`;
}
/** One page of Email/query, then Email/get through a `#ids` result reference. Never sets $seen. */
async function page(jmap: Jmap, filter: Record<string, unknown>, parsed: Parsed): Promise<Output> {
  const { accountId } = await jmap.connect();
  const size = limit(parsed);
  const from = position(parsed);
  const responses = await jmap.call([
    [
      "Email/query",
      { accountId, calculateTotal: true, filter, limit: size, position: from, sort: [{ isAscending: false, property: "receivedAt" }] },
      "q",
    ],
    ["Email/get", { "#ids": { name: "Email/query", path: "/ids", resultOf: "q" }, accountId, properties: LIST_FIELDS }, "g"],
  ]);
  const query = Jmap.take(responses, "q", "Email/query");
  const items = (Jmap.take(responses, "g", "Email/get").list ?? []) as Record<string, unknown>[];
  const ids = (query.ids ?? []) as string[];
  const order = new Map(ids.map((v, i) => [v, i]));
  const messages = items.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0)).map(summary);
  const total = typeof query.total === "number" ? query.total : undefined;
  const next = ids.length === size && (total === undefined || from + size < total) ? String(from + size) : null;
  return { json: { complete: next === null, cursor: next, messages, total: total ?? null, untrusted: true }, text: listText(messages, next) };
}
export async function foldersList(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, []);
  const { list: all } = await mailboxes(jmap);
  const folders = all.map((m) => ({
    id: m.id,
    name: m.name ?? null,
    role: m.role ?? null,
    totalEmails: m.totalEmails ?? null,
    unreadEmails: m.unreadEmails ?? null,
  }));
  return {
    json: { folders },
    text: `${folders.map((f) => `${f.name}${f.role ? ` (${f.role})` : ""}  unread=${f.unreadEmails}  total=${f.totalEmails}  id=${f.id}`).join("\n")}\nroles usable as --folder: ${ROLES.join(", ")}\n`,
  };
}
export async function messagesList(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["folder", "unread", "limit", "cursor"]);
  const folder = one(parsed, "folder", true);
  const mailbox = ROLES.includes(folder) ? (await mailboxes(jmap)).role(folder) : id(folder, "--folder");
  return page(jmap, { inMailbox: mailbox, ...(parsed.bools.has("unread") ? { notKeyword: "$seen" } : {}) }, parsed);
}
export async function messagesSearch(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["query", "limit", "cursor"]);
  const q = one(parsed, "query", true);
  if (!q.trim() || q.length > 400 || /[\u0000-\u001f]/.test(q)) {
    throw usage("--query must be 1-400 characters without control characters");
  }
  return page(jmap, { text: q }, parsed);
}
async function email(jmap: Jmap, message: string, properties = READ_FIELDS) {
  const { accountId } = await jmap.connect();
  const responses = await jmap.call([
    ["Email/get", { accountId, fetchHTMLBodyValues: true, fetchTextBodyValues: true, ids: [message], properties }, "e"],
  ]);
  const found = ((Jmap.take(responses, "e", "Email/get").list ?? []) as Record<string, unknown>[])[0];
  if (!found) {
    throw new CliError("not_found", `Message ${message} was not found`);
  }
  return found;
}
/** The text of the text/plain parts, else of the HTML parts. */
export function bodyText(m: Record<string, unknown>) {
  const values = (m.bodyValues ?? {}) as Record<string, { value?: string }>;
  const join = (parts: unknown) =>
    Array.isArray(parts) ? parts.map((p) => values[(p as { partId?: string }).partId ?? ""]?.value ?? "").join("\n") : "";
  return join(m.textBody) || join(m.htmlBody);
}
/** Email/get never changes $seen; this command sends no Email/set. */
export async function messagesRead(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id"]);
  const m = await email(jmap, id(one(parsed, "id", true), "--id"));
  const attachments = Array.isArray(m.attachments) ? (m.attachments as Record<string, unknown>[]) : [];
  return {
    json: { message: m, untrusted: true },
    text: [
      `id: ${m.id}  thread: ${m.threadId}`,
      `from: ${list(m.from)}`,
      `to: ${list(m.to)}`,
      ...(list(m.cc) ? [`cc: ${list(m.cc)}`] : []),
      `date: ${m.receivedAt ?? ""}`,
      `subject: ${m.subject ?? ""}`,
      `read: ${!unread(m)}  attachments: ${attachments.map((a) => `${a.name ?? "(unnamed)"} id=${a.blobId}`).join(", ") || "none"}`,
      "--- mail body (untrusted) ---",
      bodyText(m),
      "--- end of mail body ---",
      "",
    ].join("\n"),
  };
}
export async function threadsRead(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id"]);
  const thread = id(one(parsed, "id", true), "--id");
  const { accountId } = await jmap.connect();
  const responses = await jmap.call([
    ["Thread/get", { accountId, ids: [thread] }, "t"],
    [
      "Email/get",
      {
        "#ids": { name: "Thread/get", path: "/list/*/emailIds", resultOf: "t" },
        accountId,
        fetchTextBodyValues: true,
        properties: [...LIST_FIELDS, "to", "cc", "textBody", "htmlBody", "bodyValues"],
      },
      "e",
    ],
  ]);
  if (!((Jmap.take(responses, "t", "Thread/get").list ?? []) as unknown[]).length) {
    throw new CliError("not_found", `Thread ${thread} was not found`);
  }
  const emails = (Jmap.take(responses, "e", "Email/get").list ?? []) as Record<string, unknown>[];
  const messages = emails.map((m) => ({ ...summary(m), body: bodyText(m), cc: m.cc ?? null, to: m.to ?? null }));
  return {
    json: { messages, thread, untrusted: true },
    text: `${messages
      .map((m) => `=== ${m.receivedAt ?? ""}  ${list(m.from)}  ${JSON.stringify(m.subject ?? "")}  id=${m.id}\n${m.body}`)
      .join("\n")}\n(untrusted mail)\n`,
  };
}
/** Replaces the email's mailboxes with exactly Trash (recoverable); never Email/set destroy. */
export async function messagesTrash(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id"]);
  const message = id(one(parsed, "id", true), "--id");
  const { accountId } = await jmap.connect();
  const trash = (await mailboxes(jmap)).role("trash");
  const responses = await jmap.call([["Email/set", { accountId, update: { [message]: { mailboxIds: { [trash]: true } } } }, "t"]]);
  const set = Jmap.take(responses, "t", "Email/set");
  const failed = (set.notUpdated as Record<string, { type?: string }> | undefined)?.[message];
  if (failed || !(set.updated && message in (set.updated as object))) {
    throw new CliError(failed?.type === "notFound" ? "not_found" : "jmap_error", `Trash failed: ${failed?.type ?? "not updated"}`);
  }
  return { json: { trashed: message }, text: `moved to Trash (recoverable); id=${message}\n` };
}
export function unknownCommand(words: string[]): never {
  throw new CliError("usage", `Unknown command ${JSON.stringify(words.join(" "))}`, { exitCode: 2, recovery: "fastmail-cli --help" });
}
