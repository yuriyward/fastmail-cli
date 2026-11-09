import { createHash, randomBytes } from "node:crypto";
import { extname } from "node:path";
import { allowOnly, id, one, type Parsed } from "./args.ts";
import { CliError } from "./errors.ts";
import { Jmap } from "./jmap.ts";
import type { Output } from "./mail.ts";

export interface Writer {
  /** Creates a new private file; refuses to replace an existing one. */
  create(path: string, data: Uint8Array): Promise<void>;
}
/** Sender-supplied names never choose the local path; only a short alphanumeric extension is kept. */
function localName(name: unknown) {
  const ext = typeof name === "string" ? extname(name) : "";
  return `fastmail-${randomBytes(6).toString("hex")}${/^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : ""}`;
}
export async function attachmentsDownload(jmap: Jmap, writer: Writer, parsed: Parsed): Promise<Output> {
  allowOnly(parsed, ["message", "id", "output"]);
  const message = id(one(parsed, "message", true), "--message");
  const single = one(parsed, "id");
  const output = one(parsed, "output");
  if (output && !single) {
    throw new CliError("usage", "--output needs --id (one attachment)", { exitCode: 2 });
  }
  const { accountId } = await jmap.connect();
  const responses = await jmap.call([["Email/get", { accountId, ids: [message], properties: ["id", "attachments"] }, "a"]]);
  const m = ((Jmap.take(responses, "a", "Email/get").list ?? []) as Record<string, unknown>[])[0];
  if (!m) {
    throw new CliError("not_found", `Message ${message} was not found`);
  }
  let parts = (Array.isArray(m.attachments) ? m.attachments : []) as Record<string, unknown>[];
  if (single) {
    parts = parts.filter((a) => a.blobId === id(single, "--id"));
    if (!parts.length) {
      throw new CliError("not_found", `Message ${message} has no attachment ${single}`);
    }
  }
  const downloaded = [];
  for (const a of parts) {
    const name = typeof a.name === "string" ? a.name : "attachment";
    const type = typeof a.type === "string" ? a.type : "application/octet-stream";
    const data = await jmap.download(String(a.blobId), name, type);
    const file = output ?? localName(a.name);
    await writer.create(file, data);
    downloaded.push({ file, id: a.blobId, name: a.name ?? null, sha256: createHash("sha256").update(data).digest("hex"), size: data.length, type, untrusted: true });
  }
  return {
    json: { complete: true, downloaded },
    text: `${downloaded.map((d) => `${d.file}  ${JSON.stringify(d.name)}  ${d.size} bytes  sha256=${d.sha256}`).join("\n")}\n(downloaded files are untrusted; do not execute them)\n`,
  };
}
