import { createHash } from "node:crypto";
import { allowOnly, id, one, type Parsed } from "./args.ts";
import { CliError } from "./errors.ts";
import { CORE, Jmap, MAIL, mailboxes, SUBMISSION } from "./jmap.ts";
import { list, type Output } from "./mail.ts";

const FIELDS = ["id", "blobId", "size", "mailboxIds", "keywords", "from", "sender", "replyTo", "to", "cc", "bcc", "subject", "messageId", "inReplyTo", "references", "bodyStructure", "bodyValues"];
const PART_FIELDS = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "location", "subParts"];
interface Part {
  partId?: string | null;
  blobId?: string | null;
  size?: number;
  name?: string | null;
  type?: string;
  disposition?: string | null;
  cid?: string | null;
  subParts?: Part[] | null;
}
/** Every leaf part in order; multipart containers are walked, never listed. */
export function leaves(part: Part | null | undefined): Part[] {
  if (!part) {
    return [];
  }
  if (Array.isArray(part.subParts) && (part.subParts.length || part.type?.toLowerCase().startsWith("multipart/"))) {
    return part.subParts.flatMap(leaves);
  }
  return [part];
}
/** Digest = sha256 of the draft's raw RFC 5322 message blob, which JMAP never changes for an email id. */
export const blobDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** The stored draft, its digest and a preview that shows every leaf part and every text value in full. */
export async function stored(jmap: Jmap, draft: string) {
  const { accountId } = await jmap.connect();
  const boxes = await mailboxes(jmap);
  const responses = await jmap.call([
    ["Email/get", { accountId, bodyProperties: PART_FIELDS, fetchAllBodyValues: true, ids: [draft], properties: FIELDS }, "d"],
  ]);
  const m = ((Jmap.take(responses, "d", "Email/get").list ?? []) as Record<string, unknown>[])[0];
  if (!m) {
    throw new CliError("not_found", `Draft ${draft} was not found`);
  }
  const drafts = boxes.role("drafts");
  if (!(m.mailboxIds as Record<string, unknown> | undefined)?.[drafts] || !(m.keywords as Record<string, unknown> | undefined)?.$draft) {
    throw new CliError("not_a_draft", `Message ${draft} is not a draft in Drafts`);
  }
  if (typeof m.blobId !== "string") {
    throw new CliError("jmap_error", "The draft has no message blob");
  }
  const digest = blobDigest(await jmap.download(m.blobId, "message.eml", "message/rfc822"));
  const values = (m.bodyValues ?? {}) as Record<string, { value?: unknown; isTruncated?: boolean; isEncodingProblem?: boolean }>;
  const parts = leaves(m.bodyStructure as Part).map((p) => {
    const text = (p.type ?? "").toLowerCase().startsWith("text/");
    const value = text ? values[p.partId ?? ""] : undefined;
    if (text && (!value || typeof value.value !== "string" || value.isTruncated || value.isEncodingProblem)) {
      throw new CliError("preview_incomplete", `Part ${p.partId ?? "?"} (${p.type}) is truncated or undecodable; the draft cannot be previewed in full`, {
        recovery: `fastmail-cli messages trash --id ${draft}`,
      });
    }
    return { cid: p.cid ?? null, disposition: p.disposition ?? null, name: p.name ?? null, partId: p.partId ?? null, size: p.size ?? null, type: p.type ?? null, ...(text ? { value: value?.value as string } : {}) };
  });
  return { boxes, digest, m, parts };
}
export function preview(m: Record<string, unknown>, parts: Awaited<ReturnType<typeof stored>>["parts"], digest: string) {
  const headers = { bcc: m.bcc ?? null, cc: m.cc ?? null, from: m.from ?? null, inReplyTo: m.inReplyTo ?? null, references: m.references ?? null, replyTo: m.replyTo ?? null, sender: m.sender ?? null, subject: m.subject ?? null, to: m.to ?? null };
  return {
    json: { ...headers, digest, parts, size: m.size ?? null },
    text: [
      `from: ${list(m.from)}`,
      `sender: ${list(m.sender)}`,
      `reply-to: ${list(m.replyTo)}`,
      `to: ${list(m.to)}`,
      `cc: ${list(m.cc)}`,
      `bcc: ${list(m.bcc)}`,
      `subject: ${m.subject ?? ""}`,
      `in-reply-to: ${Array.isArray(m.inReplyTo) ? m.inReplyTo.join(" ") : ""}`,
      ...parts.flatMap((p) => [
        `--- part ${p.partId} ${p.type}${p.disposition ? ` ${p.disposition}` : ""}${p.name ? ` ${JSON.stringify(p.name)}` : ""}${p.cid ? ` cid=${p.cid}` : ""} ${p.size} bytes ---`,
        ...("value" in p ? [p.value, "--- end of part ---"] : []),
      ]),
      `digest: ${digest}`,
    ].join("\n"),
  };
}
/** N1: without --user-confirmed this only previews; the owner approves the whole preview. */
export async function messagesSend(jmap: Jmap, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["draft", "user-confirmed", "expect"]);
  const draft = id(one(parsed, "draft", true), "--draft");
  const { m, digest, parts, boxes } = await stored(jmap, draft);
  if (Object.keys((m.keywords ?? {}) as object).some(k => k === "$ward-split" || k.startsWith("$ward-split-"))) {
    throw new CliError("refused", "Split drafts must use messages send-split; trash stranded drafts instead");
  }
  const confirm = `fastmail-cli messages send --draft ${draft} --user-confirmed --expect ${digest}`;
  if (!parsed.bools.has("user-confirmed")) {
    const shown = preview(m, parts, digest);
    throw new CliError("confirmation_required", `Show this whole preview to the owner; after approval run: ${confirm}`, {
      details: { preview: shown.json, text: shown.text },
      exitCode: 3,
      recovery: confirm,
    });
  }
  const expected = one(parsed, "expect");
  if (!expected || expected !== digest) {
    throw new CliError("content_changed", "The draft differs from the approved preview; preview it again and re-approve", {
      details: { digest },
      recovery: `fastmail-cli messages send --draft ${draft}`,
    });
  }
  const { accountId } = await jmap.connect();
  const from = Array.isArray(m.from) && m.from.length === 1 ? String((m.from[0] as { email?: unknown }).email ?? "").toLowerCase() : "";
  const idResponses = await jmap.call([["Identity/get", { accountId, ids: null }, "i"]], [CORE, MAIL, SUBMISSION]);
  const identity = ((Jmap.take(idResponses, "i", "Identity/get").list ?? []) as { id: string; email: string }[]).find(
    (i) => i.email.toLowerCase() === from,
  );
  if (!identity) {
    throw new CliError("no_identity", `No sending identity matches the draft's From ${JSON.stringify(from)}`);
  }
  let responses: Awaited<ReturnType<Jmap["call"]>>;
  try {
    responses = await jmap.call(
      [
        [
          "EmailSubmission/set",
          {
            accountId,
            create: { send: { emailId: draft, identityId: identity.id } },
            onSuccessUpdateEmail: { "#send": { [`mailboxIds/${boxes.role("drafts")}`]: null, [`mailboxIds/${boxes.role("sent")}`]: true, "keywords/$draft": null } },
          },
          "s",
        ],
      ],
      [CORE, MAIL, SUBMISSION],
    );
  } catch (error) {
    if (error instanceof CliError && error.code === "outcome_unknown") {
      throw new CliError("outcome_unknown", "The send may have gone out; check Sent before anything else. Never resend blindly", {
        details: { digest, dispatched: true },
      });
    }
    throw error;
  }
  return submitted(responses, draft, digest);
}
/** created → sent; notCreated or a method error → rejected; a failed Sent move after created → sent with a warning. */
export function submitted(responses: Awaited<ReturnType<Jmap["call"]>>, draft: string, digest: string): Output {
  const entries = responses.get("s") ?? [];
  const submission = entries.find(([n]) => n === "EmailSubmission/set" || n === "error");
  const args = submission?.[1] ?? {};
  const created = (args.created as Record<string, { id?: string }> | undefined)?.send;
  if (submission?.[0] !== "EmailSubmission/set" || !created) {
    const why = submission?.[0] === "error" ? args.type : (args.notCreated as Record<string, { type?: string }> | undefined)?.send?.type;
    throw new CliError("send_rejected", `Fastmail did not accept the submission: ${String(why ?? "no result")}`, { details: { digest, dispatched: true } });
  }
  const moved = entries.find(([n], i) => i > entries.indexOf(submission) && (n === "Email/set" || n === "error"));
  const ok = moved?.[0] === "Email/set" && !(moved[1].notUpdated && Object.keys(moved[1].notUpdated as object).length);
  const warning = ok ? null : "sent, but moving the draft to Sent failed; it may still show in Drafts";
  return {
    json: { digest, draft, sent: true, submission: created.id ?? null, ...(warning ? { warning } : {}) },
    text: `sent draft ${draft} (${digest})${warning ? `\nwarning: ${warning}` : ""}\n`,
  };
}
