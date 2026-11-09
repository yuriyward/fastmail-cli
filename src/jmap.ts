import { CliError } from "./errors.ts";

export const SESSION_URL = "https://api.fastmail.com/jmap/session";
export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
export const SUBMISSION = "urn:ietf:params:jmap:submission";
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Call = [string, Record<string, unknown>, string];
export interface JmapOptions {
  token: string;
  fetch: Fetch;
  /** Waits between read retries; tests pass a fake. */
  sleep: (ms: number) => Promise<void>;
}
interface Session {
  accountId: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  username: string;
}
const READ_RETRIES = 4;
/** Codes the ward-access proxy answers with; anything else from upstream is jmap_error. */
const GATE = ["approval_required", "content_changed", "refused", "busy", "outcome_unknown"];

function failure(status: number, body: unknown): CliError {
  const b = body as { error?: { code?: unknown; message?: unknown }; type?: unknown; detail?: unknown } | null;
  const upstream = typeof b?.error?.code === "string" ? b.error.code : typeof b?.type === "string" ? b.type : `http_${status}`;
  const code =
    status === 401 ? "unauthorized" : status === 404 ? "not_found" : status === 429 ? "throttled" : GATE.includes(upstream) ? upstream : "jmap_error";
  const message = typeof b?.error?.message === "string" ? b.error.message : typeof b?.detail === "string" ? b.detail : `JMAP returned ${status}`;
  return new CliError(code, message.slice(0, 300), { details: { status, upstream } });
}
async function parse(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError("jmap_error", `JMAP returned non-JSON (${response.status})`);
  }
}
/** RFC 6570 level-1 expansion of the session's download/upload templates; every value is percent-encoded. */
export function expand(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? ""));
}
export const isWrite = (calls: Call[]) => calls.some(([name]) => name.endsWith("/set"));

export class Jmap {
  private readonly options: JmapOptions;
  private session: Session | undefined;
  constructor(options: JmapOptions) {
    this.options = options;
  }
  private headers(extra: Record<string, string> = {}) {
    return { accept: "application/json", authorization: `Bearer ${this.options.token}`, ...extra };
  }
  /** Reads retry 429 with Retry-After; nothing else retries. */
  private async read(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.options.fetch(url, { ...init, redirect: "error" });
      if (response.status !== 429 || attempt >= READ_RETRIES) {
        return response;
      }
      await response.arrayBuffer();
      const after = Number(response.headers.get("retry-after"));
      await this.options.sleep(Math.min(Number.isFinite(after) && after >= 0 ? after * 1000 : 1000 * 2 ** attempt, 30_000));
    }
  }
  async connect(): Promise<Session> {
    if (this.session) {
      return this.session;
    }
    const response = await this.read(SESSION_URL, { headers: this.headers(), method: "GET" });
    const body = (await parse(response)) as Record<string, unknown> | null;
    if (!response.ok) {
      throw failure(response.status, body);
    }
    const accountId = (body?.primaryAccounts as Record<string, unknown> | undefined)?.[MAIL];
    const urls = [body?.apiUrl, body?.downloadUrl, body?.uploadUrl];
    if (typeof accountId !== "string" || !urls.every((u) => typeof u === "string" && u.startsWith("https://"))) {
      throw new CliError("jmap_error", "The JMAP session has no mail account or URLs");
    }
    this.session = {
      accountId,
      apiUrl: urls[0] as string,
      downloadUrl: urls[1] as string,
      uploadUrl: urls[2] as string,
      username: typeof body?.username === "string" ? body.username : "",
    };
    return this.session;
  }
  /**
   * One JMAP request. Method errors become CliErrors. A write whose response is lost is outcome_unknown;
   * writes never retry.
   */
  async call(calls: Call[], using: string[] = [CORE, MAIL]): Promise<Map<string, [string, Record<string, unknown>][]>> {
    const session = await this.connect();
    const init: RequestInit = {
      body: JSON.stringify({ methodCalls: calls, using }),
      headers: this.headers({ "content-type": "application/json" }),
      method: "POST",
    };
    let response: Response;
    if (isWrite(calls)) {
      try {
        response = await this.options.fetch(session.apiUrl, { ...init, redirect: "error" });
      } catch {
        throw new CliError("outcome_unknown", "The request was sent but no response arrived; it may have been applied", {
          details: { dispatched: true },
        });
      }
    } else {
      response = await this.read(session.apiUrl, init);
    }
    const body = (await parse(response).catch(() => null)) as { methodResponses?: unknown } | null;
    if (!response.ok) {
      throw failure(response.status, body);
    }
    if (!Array.isArray(body?.methodResponses)) {
      throw new CliError("jmap_error", "JMAP response has no methodResponses");
    }
    const out = new Map<string, [string, Record<string, unknown>][]>();
    for (const entry of body.methodResponses as [string, Record<string, unknown>, string][]) {
      const [name, args, callId] = entry;
      out.set(callId, [...(out.get(callId) ?? []), [name, args ?? {}]]);
    }
    return out;
  }
  /** The single response of `callId` named `name`; a method error is thrown with its JMAP type. */
  static take(responses: Map<string, [string, Record<string, unknown>][]>, callId: string, name: string) {
    for (const [n, args] of responses.get(callId) ?? []) {
      if (n === "error") {
        throw new CliError("jmap_error", `${name} failed: ${String(args.type)}`, { details: { upstream: args.type ?? null } });
      }
      if (n === name) {
        return args;
      }
    }
    throw new CliError("jmap_error", `JMAP response lacks ${name}`);
  }
  async download(blobId: string, name: string, type: string): Promise<Uint8Array> {
    const session = await this.connect();
    const url = expand(session.downloadUrl, { accountId: session.accountId, blobId, name, type });
    const response = await this.read(url, { headers: this.headers({ accept: "*/*" }), method: "GET" });
    if (!response.ok) {
      throw failure(response.status, await parse(response).catch(() => null));
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  async upload(data: Uint8Array, type: string): Promise<{ blobId: string; size: number; type: string }> {
    const session = await this.connect();
    const url = expand(session.uploadUrl, { accountId: session.accountId });
    const response = await this.options.fetch(url, {
      body: data,
      headers: this.headers({ "content-type": type }),
      method: "POST",
      redirect: "error",
    });
    const body = (await parse(response).catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || typeof body?.blobId !== "string") {
      throw failure(response.status, body);
    }
    return { blobId: body.blobId, size: Number(body.size ?? data.length), type: String(body.type ?? type) };
  }
}
/** Mailbox ids by role (inbox, drafts, sent, trash, …) plus every mailbox as listed. */
export async function mailboxes(jmap: Jmap) {
  const { accountId } = await jmap.connect();
  const responses = await jmap.call([
    ["Mailbox/get", { accountId, ids: null, properties: ["id", "name", "role", "totalEmails", "unreadEmails"] }, "m"],
  ]);
  const list = (Jmap.take(responses, "m", "Mailbox/get").list ?? []) as Record<string, unknown>[];
  const roles = new Map<string, string>();
  for (const m of list) {
    if (typeof m.role === "string" && typeof m.id === "string") {
      roles.set(m.role, m.id);
    }
  }
  const role = (name: string) => {
    const found = roles.get(name);
    if (!found) {
      throw new CliError("jmap_error", `The account has no ${name} mailbox`);
    }
    return found;
  };
  return { list, role };
}
