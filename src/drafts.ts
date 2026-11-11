import { basename, extname } from "node:path";
import { address, allowOnly, id, one, type Parsed } from "./args.ts";
import { CliError, usage } from "./errors.ts";
import { CORE, Jmap, MAIL, mailboxes, SUBMISSION } from "./jmap.ts";
import { bodyText, list, type Output } from "./mail.ts";

export interface Files {
  read(path: string): Promise<Uint8Array>;
}
/** The ward-access proxy admits uploads up to 10 MB per blob. */
const ATTACHMENT_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
};
type EmailAddress = { name?: string | null; email: string };
type Part = { blobId: string; type: string; name: string; disposition: "attachment" };

const recipients = (parsed: Parsed, name: string): EmailAddress[] => (parsed.flags.get(name) ?? []).map((a) => ({ email: address(a) }));
async function bodyFile(files: Files, parsed: Parsed) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await files.read(one(parsed, "body-file", true)));
}
async function htmlFile(files: Files, parsed: Parsed): Promise<string | undefined> {
  const path = one(parsed, "body-html-file");
  if (path === undefined) return undefined;
  const bytes = await files.read(path);
  if (bytes.length > 1024 * 1024) throw usage(`${path} is over 1 MB`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function uploads(jmap: Jmap, files: Files, parsed: Parsed): Promise<Part[]> {
  const read: { path: string; bytes: Uint8Array }[] = [];
  for (const path of parsed.flags.get("attach") ?? []) {
    const bytes = await files.read(path);
    if (bytes.length > ATTACHMENT_BYTES) {
      throw usage(`${path} is over 10 MB; large attachments are not supported`);
    }
    read.push({ bytes, path });
  }
  const out: Part[] = [];
  for (const { path, bytes } of read) {
    const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const blob = await jmap.upload(bytes, type);
    out.push({ blobId: blob.blobId, disposition: "attachment", name: basename(path), type });
  }
  return out;
}
async function identities(jmap: Jmap) {
  const { accountId } = await jmap.connect();
  const responses = await jmap.call([["Identity/get", { accountId, ids: null }, "i"]], [CORE, MAIL, SUBMISSION]);
  return (Jmap.take(responses, "i", "Identity/get").list ?? []) as { id: string; email: string; name?: string }[];
}
/** The identity sending from the session user's address, else the first one. */
function sender(all: { email: string; name?: string }[], username: string, prefer: string[] = []): EmailAddress {
  const lower = (s: string) => s.toLowerCase();
  const found =
    all.find((i) => prefer.map(lower).includes(lower(i.email))) ?? all.find((i) => lower(i.email) === lower(username)) ?? all[0];
  if (!found) {
    throw new CliError("no_identity", "The account has no sending identity");
  }
  return { email: found.email, name: found.name || null };
}
interface Draft {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  html?: string | undefined;
  attachments: Part[];
  inReplyTo?: string[] | null;
  references?: string[] | null;
}
/** One Email/set create into Drafts with `$draft` (and `$seen`, so the owner's unread count stays honest). */
async function create(jmap: Jmap, d: Draft): Promise<Output> {
  const { accountId } = await jmap.connect();
  const drafts = (await mailboxes(jmap)).role("drafts");
  const email: Record<string, unknown> = {
    attachments: d.attachments,
    bcc: d.bcc?.length ? d.bcc : null,
    bodyValues: { text: { value: d.text }, ...(d.html !== undefined ? { html: { value: d.html } } : {}) },
    ...(d.html !== undefined ? { htmlBody: [{ partId: "html", type: "text/html" }] } : {}),
    cc: d.cc?.length ? d.cc : null,
    from: [d.from],
    keywords: { $draft: true, $seen: true },
    mailboxIds: { [drafts]: true },
    subject: d.subject,
    textBody: [{ partId: "text", type: "text/plain" }],
    to: d.to,
    ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
    ...(d.references ? { references: d.references } : {}),
  };
  const responses = await jmap.call([["Email/set", { accountId, create: { draft: email } }, "c"]]);
  const set = Jmap.take(responses, "c", "Email/set");
  const created = (set.created as Record<string, { id?: string }> | undefined)?.draft;
  if (!created?.id) {
    const why = (set.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.draft;
    throw new CliError("jmap_error", `Draft not created: ${why?.type ?? "unknown"} ${why?.description ?? ""}`.trim());
  }
  return {
    json: { attachments: d.attachments.length, draft: created.id, subject: d.subject },
    text: `draft created: id=${created.id}\nnext: fastmail-cli messages send --draft ${created.id}  (preview only; sending needs the owner's approval)\n`,
  };
}
export async function draftsCreate(jmap: Jmap, files: Files, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["to", "cc", "bcc", "subject", "body-file", "body-html-file", "attach"]);
  const to = recipients(parsed, "to");
  if (!to.length) {
    throw usage("--to is required (one exact address per --to)");
  }
  const subject = one(parsed, "subject", true);
  const text = await bodyFile(files, parsed);
  const html = await htmlFile(files, parsed);
  const { username } = await jmap.connect();
  const from = sender(await identities(jmap), username);
  const attachments = await uploads(jmap, files, parsed);
  return create(jmap, { attachments, bcc: recipients(parsed, "bcc"), cc: recipients(parsed, "cc"), from, subject, text, html, to });
}
const ORIGINAL = ["id", "messageId", "references", "subject", "from", "replyTo", "to", "cc", "sentAt", "receivedAt", "textBody", "htmlBody", "bodyValues", "attachments"];
async function original(jmap: Jmap, message: string) {
  const { accountId } = await jmap.connect();
  const responses = await jmap.call([
    ["Email/get", { accountId, fetchHTMLBodyValues: true, fetchTextBodyValues: true, ids: [message], properties: ORIGINAL }, "o"],
  ]);
  const found = ((Jmap.take(responses, "o", "Email/get").list ?? []) as Record<string, unknown>[])[0];
  if (!found) {
    throw new CliError("not_found", `Message ${message} was not found`);
  }
  return found;
}
const prefixed = (prefix: string, subject: unknown) => {
  const s = typeof subject === "string" ? subject : "";
  return new RegExp(`^${prefix}:`, "i").test(s.trim()) ? s : `${prefix}: ${s}`;
};
const addresses = (v: unknown) => (Array.isArray(v) ? (v as EmailAddress[]).filter((a) => typeof a?.email === "string") : []);
/** RFC 5322 threading from the original's Message-ID and References, never from JMAP ids. */
function threading(o: Record<string, unknown>) {
  const ids = Array.isArray(o.messageId) ? (o.messageId as string[]) : [];
  const refs = Array.isArray(o.references) ? (o.references as string[]) : [];
  return { inReplyTo: ids.length ? ids : null, references: ids.length || refs.length ? [...refs, ...ids] : null };
}
/** Reply-To, else From; `all` adds To and Cc minus the owner's identities, deduplicated case-insensitively. */
export function replyRecipients(o: Record<string, unknown>, all: boolean, own: string[]) {
  const mine = new Set(own.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  const keep = (list: EmailAddress[]) =>
    list.filter((a) => {
      const key = a.email.toLowerCase();
      if (mine.has(key) || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  const replyTo = addresses(o.replyTo);
  const to = keep(replyTo.length ? replyTo : addresses(o.from));
  if (to.length) {
    return { cc: all ? keep([...addresses(o.to), ...addresses(o.cc)]) : [], to };
  }
  // A reply to your own message goes to its To; --all adds its Cc.
  return { to: keep(addresses(o.to)), cc: all ? keep(addresses(o.cc)) : [] };
}
const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
/** Escape generated text only; supplied HTML and the original HTML remain intact. */
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const textHtml = (text: string) => escapeHtml(text).replace(/\n/g, "<br>\n");
function originalHtml(o: Record<string, unknown>): string {
  const values = (o.bodyValues ?? {}) as Record<string, { value?: string }>;
  const parts = Array.isArray(o.htmlBody) ? o.htmlBody as { partId?: string }[] : [];
  return parts.length ? parts.map((p) => values[p.partId ?? ""]?.value ?? "").join("\n") : textHtml(bodyText(o));
}
export async function draftsReply(jmap: Jmap, files: Files, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id", "all", "body-file", "body-html-file", "attach"]);
  const o = await original(jmap, id(one(parsed, "id", true), "--id"));
  const text = await bodyFile(files, parsed);
  const html = await htmlFile(files, parsed);
  const { username } = await jmap.connect();
  const own = await identities(jmap);
  const { to, cc } = replyRecipients(o, parsed.bools.has("all"), [username, ...own.map((i) => i.email)]);
  if (!to.length) {
    throw new CliError("no_recipients", "The original has no reply address other than your own");
  }
  const from = sender(own, username, [...addresses(o.to), ...addresses(o.cc)].map((a) => a.email));
  const attachments = await uploads(jmap, files, parsed);
  const said = `On ${o.sentAt ?? o.receivedAt ?? "an earlier date"}, ${list(o.from)} wrote:`;
  return create(jmap, {
    attachments,
    cc,
    from,
    subject: prefixed("Re", o.subject),
    html: html === undefined ? undefined : `${html}\n<p>${escapeHtml(said)}</p>\n<blockquote>${originalHtml(o)}</blockquote>`,
    text: `${text}\n\n${said}\n${quote(bodyText(o))}\n`,
    to,
    ...threading(o),
  });
}
export async function draftsForward(jmap: Jmap, files: Files, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["id", "to", "body-file", "body-html-file", "attach"]);
  const o = await original(jmap, id(one(parsed, "id", true), "--id"));
  const to = recipients(parsed, "to");
  if (!to.length) {
    throw usage("--to is required (one exact address per --to)");
  }
  const text = await bodyFile(files, parsed);
  const html = await htmlFile(files, parsed);
  const { username } = await jmap.connect();
  const from = sender(await identities(jmap), username);
  // The original's attachments travel by blob id: blobs are immutable and already in the account.
  const carried = (Array.isArray(o.attachments) ? (o.attachments as Record<string, unknown>[]) : []).map((a) => ({
    blobId: String(a.blobId),
    disposition: "attachment" as const,
    name: typeof a.name === "string" ? a.name : "attachment",
    type: typeof a.type === "string" ? a.type : "application/octet-stream",
  }));
  const attachments = [...carried, ...(await uploads(jmap, files, parsed))];
  const header = [
    "---------- Forwarded message ----------",
    `From: ${list(o.from)}`,
    `Date: ${o.sentAt ?? o.receivedAt ?? ""}`,
    `Subject: ${o.subject ?? ""}`,
    `To: ${list(o.to)}`,
    ...(list(o.cc) ? [`Cc: ${list(o.cc)}`] : []),
  ].join("\n");
  return create(jmap, {
    attachments,
    from,
    references: threading(o).references,
    subject: prefixed("Fwd", o.subject),
    html: html === undefined ? undefined : `${html}\n<p>${textHtml(header)}</p>\n<blockquote>${originalHtml(o)}</blockquote>`,
    text: `${text}\n\n${header}\n\n${bodyText(o)}\n`,
    to,
  });
}
