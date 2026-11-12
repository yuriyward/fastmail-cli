import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { address, allowOnly, one, type Parsed } from "./args.ts";
import { identities, sender, uploads, type Files } from "./drafts.ts";
import { CliError, usage } from "./errors.ts";
import { CORE, Jmap, MAIL, mailboxes, SUBMISSION } from "./jmap.ts";
import { type Output } from "./mail.ts";
import { blobDigest, preview, stored } from "./send.ts";

const SELF = "$ward-split-self";
const RCPT = "$ward-split-recipient-";
const invalid = (message: string) => new CliError("invalid_batch", message);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const emails = (v: unknown): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw invalid("Invalid address list");
  return v.map(a => address(String(a?.email ?? "")).toLowerCase());
};

/** JCS for the manifest's JSON-only domain; keys sort by UTF-16 code units (RFC 8785). */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`).join(",")}}`;
  throw invalid("Non-JSON manifest value");
}
export interface BatchManifest {
  v: 1;
  account: string;
  identity: string;
  mailFrom: string;
  self: { id: string; blob: string };
  items: { id: string; blob: string; rcptTo: string }[];
}
export function batchDigest(manifest: BatchManifest): string {
  return blobDigest(new TextEncoder().encode(jcs({ ...manifest, items: [...manifest.items].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) })));
}

/** mail-tracker compose --per-recipient: items map directory indices to addresses. */
function receiptMap(value: unknown): Map<number, string> {
  const items = value && typeof value === "object" ? (value as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items)) throw usage("receipt.json must contain per-recipient items");
  const result = new Map<number, string>();
  for (const item of items) {
    if (!item || typeof item !== "object") throw usage("Invalid recipient item in receipt.json");
    const { i, address: email } = item as Record<string, unknown>;
    if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0 || typeof email !== "string") {
      throw usage("Receipt items require a nonnegative integer i and an address");
    }
    if (result.has(i)) throw usage("Duplicate receipt index");
    result.set(i, address(email).toLowerCase());
  }
  return result;
}
export async function draftsCreateSplit(jmap: Jmap, files: Files, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["dir", "to", "cc", "bcc", "subject", "attach"]);
  const dir = one(parsed, "dir", true);
  const subject = one(parsed, "subject", true);
  const get = (name: string) => (parsed.flags.get(name) ?? []).map(email => ({ email: address(email) }));
  const to = get("to"), cc = get("cc"), bcc = get("bcc");
  if (!to.length) throw usage("--to is required");
  const destinations = [...to, ...cc, ...bcc].map(a => a.email.toLowerCase());
  if (new Set(destinations).size !== destinations.length) throw usage("Split recipients must be distinct, case-insensitively");
  const mapping = receiptMap(JSON.parse(decode(await files.read(join(dir, "receipt.json")))));
  if (mapping.size !== destinations.length || new Set(mapping.values()).size !== mapping.size || destinations.some(a => ![...mapping.values()].includes(a))) {
    throw usage("Receipt recipients must match To/Cc/Bcc exactly, case-insensitively");
  }
  // Probe the flat layout first so ward-access only needs flat input filenames.
  // Only a missing flat self text selects nested mode; never mix layouts or hide IO errors.
  let flat = true;
  let selfText: Uint8Array;
  try {
    selfText = await files.read(join(dir, "self.body.txt"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    flat = false;
    selfText = await files.read(join(dir, "self", "body.txt"));
  }
  const readBody = async (name: string, text?: Uint8Array) => {
    const path = (extension: string) => flat
      ? join(dir, `${name}.body.${extension}`)
      : join(dir, name, `body.${extension}`);
    text ??= await files.read(path("txt"));
    const html = await files.read(path("html"));
    if (text.length > 1024 * 1024 || html.length > 1024 * 1024) throw usage("Compose bodies must be at most 1 MB each");
    return { text: decode(text), html: decode(html) };
  };
  // Read and validate the entire local input before any upload or draft creation.
  const selfBody = await readBody("self", selfText);
  const bodies = new Map<number, {text: string; html: string}>();
  for (const [i, email] of mapping) {
    const name = flat ? `recipient-${i}` : join("recipients", String(i));
    bodies.set(destinations.indexOf(email), await readBody(name));
  }
  const { accountId, username } = await jmap.connect();
  const from = sender(await identities(jmap), username);
  const attachments = await uploads(jmap, files, parsed);
  const drafts = (await mailboxes(jmap)).role("drafts");
  const batch = randomUUID();
  const common = {
    attachments, from: [from], sender: null, replyTo: null, to, cc: cc.length ? cc : null, subject,
    messageId: [`${randomUUID()}@${from.email.split("@")[1]}`], inReplyTo: null, references: null,
    // JMAP sentAt generates the RFC 5322 Date header; capture once for the whole batch.
    sentAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mailboxIds: { [drafts]: true },
    textBody: [{partId: "text", type: "text/plain"}], htmlBody: [{partId: "html", type: "text/html"}],
  };
  const draft = (body: {text: string; html: string}, marker: string, self = false) => ({
    ...common, ...(self && bcc.length ? { bcc } : {}),
    keywords: { $draft: true, $seen: true, [`$ward-split-${batch}`]: true, [marker]: true },
    bodyValues: {text: {value: body.text}, html: {value: body.html}},
  });
  const create: Record<string, unknown> = { self: draft(selfBody, SELF, true) };
  for (const [i, body] of bodies) create[`r${i}`] = draft(body, `${RCPT}${i}`);
  const set = Jmap.take(await jmap.call([["Email/set", {accountId, create}, "c"]]), "c", "Email/set");
  const created = (set.created ?? {}) as Record<string, {id?: string}>;
  if (Object.keys(create).some(k => !created[k]?.id)) throw new CliError("jmap_error", "Split batch creation failed or was partial; trash any created drafts", {details: {batch, created, notCreated: set.notCreated ?? null}});
  return {json: {batch, drafts: created, copies: destinations.length}, text: `batch created: ${batch}\n`};
}

export async function messagesSendSplit(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["batch", "user-confirmed", "expect"]);
  const batch = one(parsed, "batch", true);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(batch)) throw usage("--batch must be a lowercase UUID");
  const keyword = `$ward-split-${batch}`;
  const {accountId} = await jmap.connect();
  const ids: string[] = [];
  // Bounded pages, including an extra read when the result is exactly a full page.
  for (;;) {
    const q = Jmap.take(await jmap.call([["Email/query", {accountId, filter: {hasKeyword: keyword}, position: ids.length, limit: 100}, "q"]]), "q", "Email/query");
    if (!Array.isArray(q.ids) || q.ids.some(i => typeof i !== "string" || ids.includes(i))) throw invalid("Invalid batch query result");
    ids.push(...q.ids as string[]);
    if (q.ids.length < 100) break;
  }
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw invalid("Batch must contain distinct recipient drafts and one self draft");
  const drafts = [];
  for (const id of ids) drafts.push({id, ...await stored(jmap, id)});
  const selfDrafts = drafts.filter(d => (d.m.keywords as Record<string, unknown>)[SELF]);
  if (selfDrafts.length !== 1) throw invalid("Batch must contain exactly one self draft");
  const self = selfDrafts[0]!;
  const destinations = [...emails(self.m.to), ...emails(self.m.cc), ...emails(self.m.bcc)];
  if (!destinations.length || new Set(destinations).size !== destinations.length || drafts.length !== destinations.length + 1) throw invalid("Recipient count or uniqueness mismatch");
  const from = emails(self.m.from);
  if (from.length !== 1) throw invalid("Exactly one From is required");
  const allIdentities = await identities(jmap);
  const identity = allIdentities.find(i => i.email.toLowerCase() === from[0]);
  if (!identity) throw new CliError("no_identity", "No identity matches batch From");
  const items: BatchManifest["items"] = [];
  const seen = new Set<number>();
  for (const d of drafts) {
    const keywords = d.m.keywords as Record<string, unknown>;
    if (!keywords[keyword]) throw invalid("Batch keyword changed");
    for (const field of ["from", "sender", "replyTo", "to", "cc", "subject", "messageId", "sentAt", "inReplyTo", "references"]) {
      if (jcs(d.m[field] ?? null) !== jcs(self.m[field] ?? null)) throw invalid(`Batch ${field} differs`);
    }
    if (d === self) continue;
    if (emails(d.m.bcc).length) throw invalid("Recipient draft has Bcc");
    const markers = Object.keys(keywords).filter(k => k.startsWith(RCPT) && keywords[k]);
    const raw = markers[0]?.slice(RCPT.length) ?? "";
    const index = Number(raw);
    if (markers.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(raw) || !destinations[index] || seen.has(index)) throw invalid("Invalid recipient marker");
    seen.add(index);
    items.push({id: d.id, blob: d.digest.slice(7), rcptTo: destinations[index]!});
  }
  const digest = batchDigest({v: 1, account: accountId, identity: identity.id, mailFrom: identity.email, self: {id: self.id, blob: self.digest.slice(7)}, items});
  const confirm = `fastmail-cli messages send-split --batch ${batch} --user-confirmed --expect ${digest}`;
  if (!parsed.bools.has("user-confirmed")) {
    const shown = preview(self.m, self.parts, digest);
    throw new CliError("confirmation_required", `Show the whole preview to the owner; after approval run: ${confirm}`, {exitCode: 3, recovery: confirm, details: {preview: {...shown.json, batch, copies: items.length, recipients: items.map(i => i.rcptTo)}, text: `${shown.text}\ncopies: ${items.length}\nBatch sending requires ward-access verification that copies differ only in tracking tokens.`}});
  }
  if (one(parsed, "expect") !== digest) throw new CliError("content_changed", "Batch differs from the approved digest; preview and approve again", {details: {digest}});
  const create = Object.fromEntries(items.map((item, i) => [`r${i}`, {emailId: item.id, identityId: identity.id, envelope: {mailFrom: {email: identity.email, parameters: null}, rcptTo: [{email: item.rcptTo, parameters: null}]}}]));
  let result: Record<string, unknown>;
  try {
    const responses = await jmap.call([["EmailSubmission/set", {accountId, create, onSuccessDestroyEmail: Object.keys(create).map(k => `#${k}`)}, "s"]], [CORE, MAIL, SUBMISSION]);
    if (!(responses.get("s") ?? []).some(([name]) => name === "EmailSubmission/set" || name === "error")) throw new CliError("outcome_unknown", "Missing submission response");
    result = Jmap.take(responses, "s", "EmailSubmission/set");
  } catch (e) {
    if (e instanceof CliError && e.code === "outcome_unknown") throw new CliError("outcome_unknown", "Batch may have sent; never resend blindly. Self copy was not moved to Sent", {details: {batch, digest, outcomes: items.map(i => ({...i, outcome: "unknown"}))}});
    if (e instanceof CliError) throw new CliError(e.code, e.message, {details: {batch, digest, outcomes: items.map(i => ({draft: i.id, recipient: i.rcptTo, outcome: "rejected"})), ...(e.details ?? {})}});
    throw e;
  }
  const created = (result.created ?? {}) as Record<string, {id?: string}>;
  const failed = (result.notCreated ?? {}) as Record<string, unknown>;
  const outcomes = items.map((item, i) => ({draft: item.id, recipient: item.rcptTo, outcome: created[`r${i}`] ? "accepted" : failed[`r${i}`] ? "rejected" : "unknown", submission: created[`r${i}`]?.id ?? null, error: failed[`r${i}`] ?? null}));
  const accepted = outcomes.filter(o => o.outcome === "accepted").length;
  const unknown = outcomes.some(o => o.outcome === "unknown");
  let warning: string | null = null;
  if (accepted && !unknown) {
    try {
      const boxes = self.boxes;
      const patch = {[`mailboxIds/${boxes.role("drafts")}`]: null, [`mailboxIds/${boxes.role("sent")}`]: true, "keywords/$draft": null, ...(accepted < items.length ? {"keywords/$ward-partial": true} : {})};
      const move = Jmap.take(await jmap.call([["Email/set", {accountId, update: {[self.id]: patch}}, "m"]]), "m", "Email/set");
      if (!Object.hasOwn((move.updated ?? {}) as object, self.id)) warning = "Submission accepted, but self copy was not moved to Sent";
    } catch (e) { warning = `Submission accepted; Sent move failed: ${e instanceof Error ? e.message : "unknown"}`; }
  }
  const report = {batch, digest, outcomes, accepted, ...(warning ? {warning} : {})};
  if (unknown) throw new CliError("outcome_unknown", "Some submission outcomes are unknown; no Sent move; never resend blindly", {details: report});
  if (!accepted) throw new CliError("send_rejected", "No submissions accepted", {details: report});
  return {json: report, text: outcomes.map(o => `${o.recipient}: ${o.outcome}`).join("\n") + (warning ? `\nwarning: ${warning}` : "") + "\n"};
}
