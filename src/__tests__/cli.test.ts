import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { replyRecipients } from "../drafts.ts";
import { run } from "../main.ts";
import { leaves } from "../send.ts";

type Seen = { method: string; url: URL; body: string; headers: Headers };
type Call = [string, Record<string, unknown>, string];
const SESSION = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  downloadUrl: "https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  primaryAccounts: { "urn:ietf:params:jmap:mail": "u1" },
  uploadUrl: "https://api.fastmail.com/jmap/upload/{accountId}/",
  username: "owner@example.com",
};
const RAW = "From: owner@example.com\r\nTo: bob@example.org\r\nSubject: hi\r\n\r\nhello\r\n";
const DIGEST = `sha256:${createHash("sha256").update(RAW).digest("hex")}`;
const BOXES = [
  { id: "mb-in", role: "inbox", name: "Inbox" },
  { id: "mb-dr", role: "drafts", name: "Drafts" },
  { id: "mb-se", role: "sent", name: "Sent" },
  { id: "mb-tr", role: "trash", name: "Trash" },
];
const DRAFT = {
  blobId: "blob-raw",
  bodyStructure: {
    subParts: [
      { partId: "1", type: "text/plain", size: 5 },
      { partId: "2", type: "image/png", disposition: "inline", cid: "img1", size: 70, blobId: "b2" },
    ],
    type: "multipart/mixed",
  },
  bodyValues: { "1": { isEncodingProblem: false, isTruncated: false, value: "hello" } },
  from: [{ email: "Owner@example.com", name: "Owner" }],
  id: "d1",
  keywords: { $draft: true, $seen: true },
  mailboxIds: { "mb-dr": true },
  subject: "hi",
  to: [{ email: "bob@example.org", name: null }],
};
type Method = (args: Record<string, unknown>, call: Call) => Call[] | Call;
function fake(methods: Record<string, Method> = {}, overrides: { lost?: boolean } = {}) {
  const calls: Seen[] = [];
  const files = new Map<string, Uint8Array>();
  const defaults: Record<string, Method> = {
    "Email/get": (a, c) => ["Email/get", { list: (a.ids as string[] | undefined)?.includes("d1") ? [DRAFT] : [] }, c[2]],
    "Email/query": (_a, c) => ["Email/query", { ids: ["e2", "e1"], total: 3 }, c[2]],
    "Email/set": (_a, c) => ["Email/set", { created: { draft: { id: "new-draft" } }, updated: { m1: null } }, c[2]],
    "EmailSubmission/set": (_a, c) => [
      ["EmailSubmission/set", { created: { send: { id: "sub1" } } }, c[2]],
      ["Email/set", { updated: { d1: null } }, c[2]],
    ],
    "Identity/get": (_a, c) => ["Identity/get", { list: [{ email: "owner@example.com", id: "id1", name: "Owner" }] }, c[2]],
    "Mailbox/get": (_a, c) => ["Mailbox/get", { list: BOXES }, c[2]],
    "Thread/get": (_a, c) => ["Thread/get", { list: [{ emailIds: ["e1"], id: "t1" }] }, c[2]],
  };
  const deps = {
    createFile: async (path: string, data: Uint8Array) => {
      if (files.has(path)) {
        throw new Error("exists");
      }
      files.set(path, data);
    },
    env: { FASTMAIL_ACCESS_TOKEN: "synthetic-token" },
    fetch: async (url: string, init: RequestInit) => {
      const seen = { body: init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body ?? ""), headers: new Headers(init.headers), method: init.method ?? "GET", url: new URL(url) };
      calls.push(seen);
      if (seen.url.pathname === "/jmap/session") {
        return Response.json(SESSION);
      }
      if (seen.url.pathname.startsWith("/jmap/upload/")) {
        return Response.json({ blobId: `up-${calls.length}`, size: seen.body.length, type: seen.headers.get("content-type") });
      }
      if (seen.url.pathname.startsWith("/jmap/download/")) {
        return new Response(seen.url.pathname.includes("/blob-raw/") ? RAW : "attachment bytes");
      }
      const request = JSON.parse(seen.body) as { methodCalls: Call[] };
      if (overrides.lost && request.methodCalls.some(([n]) => n === "EmailSubmission/set")) {
        throw new TypeError("socket closed");
      }
      const responses = request.methodCalls.flatMap((c) => {
        const out = (methods[c[0]] ?? defaults[c[0]])?.(c[1], c) ?? ["error", { type: "unknownMethod" }, c[2]];
        return (Array.isArray(out[0]) ? out : [out]) as Call[];
      });
      return Response.json({ methodResponses: responses });
    },
    readFile: async (path: string) => new TextEncoder().encode(path === "big.bin" ? "x".repeat(10 * 1024 * 1024 + 1) : `text of ${path}`),
    sleep: async () => undefined,
  };
  const api = () => calls.filter((c) => c.url.pathname === "/jmap/api/").map((c) => JSON.parse(c.body) as { methodCalls: Call[]; using: string[] });
  return { api, calls, deps, files };
}

describe("reads", () => {
  test("list resolves the role, pages by position and never writes", async () => {
    const f = fake();
    const r = await run(["messages", "list", "--folder", "inbox", "--unread", "--limit", "2", "--json"], f.deps);
    expect(JSON.parse(r.stdout)).toMatchObject({ complete: false, cursor: "2", schemaVersion: 1, untrusted: true });
    const [, query] = f.api();
    expect(query?.methodCalls[0]?.[1]).toMatchObject({ filter: { inMailbox: "mb-in", notKeyword: "$seen" }, limit: 2, position: 0 });
    expect(query?.methodCalls[1]?.[1]["#ids"]).toEqual({ name: "Email/query", path: "/ids", resultOf: "q" });
    const last = await run(["messages", "list", "--folder", "inbox", "--limit", "2", "--cursor", "2", "--json"], f.deps);
    expect(JSON.parse(last.stdout)).toMatchObject({ complete: true, cursor: null });
    expect(f.api().flatMap((r) => r.methodCalls.map(([n]) => n)).some((n) => n.endsWith("/set"))).toBe(false);
  });
  test("read fetches body values without touching $seen", async () => {
    const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [{ ...DRAFT, id: "m1", keywords: {}, textBody: [{ partId: "1" }] }] }, c[2]] });
    const r = await run(["messages", "read", "--id", "m1"], f.deps);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("(untrusted)");
    const get = f.api()[0]?.methodCalls[0];
    expect(get?.[1]).toMatchObject({ fetchHTMLBodyValues: true, fetchTextBodyValues: true, ids: ["m1"] });
    expect(f.api().length).toBe(1);
  });
  test("threads read fetches HTML values, so an HTML-only message keeps its body", async () => {
    const f = fake({ "Email/get": (a, c) => ["Email/get", { list: [{ bodyValues: a.fetchHTMLBodyValues ? { h: { value: "<p>only html</p>" } } : {}, htmlBody: [{ partId: "h", type: "text/html" }], id: "e1", textBody: [] }] }, c[2]] });
    const r = await run(["threads", "read", "--id", "t1", "--json"], f.deps);
    expect(JSON.parse(r.stdout).messages[0].body).toBe("<p>only html</p>");
  });
  test("threads read chains Thread/get to Email/get", async () => {
    const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [{ id: "e1", subject: "s" }] }, c[2]] });
    const r = await run(["threads", "read", "--id", "t1", "--json"], f.deps);
    expect(JSON.parse(r.stdout).messages[0].id).toBe("e1");
    expect(f.api()[0]?.methodCalls[1]?.[1]["#ids"]).toMatchObject({ path: "/list/*/emailIds", resultOf: "t" });
  });
  test("reads retry 429 with Retry-After; writes do not", async () => {
    let n = 0;
    const f = fake();
    const fetch = f.deps.fetch;
    const deps = { ...f.deps, fetch: (url: string, init: RequestInit) => (url.endsWith("/api/") && n++ < 2 ? Promise.resolve(new Response("{}", { headers: { "retry-after": "0" }, status: 429 })) : fetch(url, init)) };
    expect((await run(["folders", "list"], deps)).exitCode).toBe(0);
    expect(n).toBe(3);
    n = 0;
    const trash = await run(["messages", "trash", "--id", "m1", "--json"], { ...deps, fetch: (url: string, init: RequestInit) => (url.endsWith("/api/") && JSON.parse(String(init.body)).methodCalls[0][0] === "Email/set" ? (n++, Promise.resolve(new Response("{}", { status: 429 }))) : fetch(url, init)) });
    expect(JSON.parse(trash.stderr).error.code).toBe("throttled");
    expect(n).toBe(1);
  });
});

describe("drafts", () => {
  test("create uploads attachments and creates one email in Drafts with $draft", async () => {
    const f = fake();
    const r = await run(["drafts", "create", "--to", "bob@example.org", "--subject", "s", "--body-file", "b.txt", "--attach", "notes.txt", "--json"], f.deps);
    expect(JSON.parse(r.stdout)).toMatchObject({ attachments: 1, draft: "new-draft" });
    const upload = f.calls.find((c) => c.url.pathname.startsWith("/jmap/upload/"));
    expect(upload?.url.pathname).toBe("/jmap/upload/u1/");
    const set = f.api().at(-1)?.methodCalls[0];
    const email = (set?.[1].create as Record<string, Record<string, unknown>>).draft;
    expect(email).toMatchObject({
      bodyValues: { text: { value: "text of b.txt" } },
      from: [{ email: "owner@example.com", name: "Owner" }],
      keywords: { $draft: true, $seen: true },
      mailboxIds: { "mb-dr": true },
      to: [{ email: "bob@example.org" }],
    });
    expect((email?.attachments as { name: string }[])[0]?.name).toBe("notes.txt");
    for (const bad of ["a@x.org,b@y.org", "Bob <bob@example.org>", "bob"]) {
      expect((await run(["drafts", "create", "--to", bad, "--subject", "s", "--body-file", "b.txt"], f.deps)).exitCode).toBe(2);
    }
    expect((await run(["drafts", "create", "--to", "a@x.org", "--subject", "s", "--body-file", "b.txt", "--attach", "big.bin"], f.deps)).exitCode).toBe(2);
  });
  test("reply targets Reply-To, threads by Message-ID and quotes the original", async () => {
    const original = {
      bodyValues: { "1": { value: "line one\nline two" } },
      cc: [{ email: "carol@example.org" }, { email: "OWNER@example.com" }],
      from: [{ email: "bob@example.org", name: "Bob" }],
      id: "m1",
      messageId: ["abc@example.org"],
      references: ["root@example.org"],
      replyTo: [{ email: "list@example.org" }],
      subject: "Plan",
      textBody: [{ partId: "1" }],
      to: [{ email: "owner@example.com" }, { email: "Carol@example.org" }],
    };
    const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [original] }, c[2]] });
    await run(["drafts", "reply", "--id", "m1", "--all", "--body-file", "b.txt"], f.deps);
    const email = (f.api().at(-1)?.methodCalls[0]?.[1].create as Record<string, Record<string, unknown>>).draft;
    expect(email).toMatchObject({
      cc: [{ email: "Carol@example.org" }],
      inReplyTo: ["abc@example.org"],
      references: ["root@example.org", "abc@example.org"],
      subject: "Re: Plan",
      to: [{ email: "list@example.org" }],
    });
    expect((email?.bodyValues as { text: { value: string } }).text.value).toContain("> line two");
  });
  test("a reply to the owner's own sent message goes to its To, without --all", () => {
    const sent = { cc: [{ email: "cc@example.org" }], from: [{ email: "me@example.com" }], to: [{ email: "you@example.org" }] };
    expect(replyRecipients(sent, false, ["me@example.com"])).toEqual({ cc: [], to: [{ email: "you@example.org" }] });
    expect(replyRecipients(sent, true, ["me@example.com"])).toEqual({ cc: [{ email: "cc@example.org" }], to: [{ email: "you@example.org" }] });
  });
  test("reply recipients fall back to From and drop the owner's addresses", () => {
    expect(replyRecipients({ from: [{ email: "bob@example.org" }] }, false, ["me@example.com"])).toEqual({ cc: [], to: [{ email: "bob@example.org" }] });
    expect(replyRecipients({ from: [{ email: "me@example.com" }], to: [{ email: "x@example.org" }, { email: "ME@example.com" }] }, true, ["ME@example.com"])).toEqual({
      cc: [],
      to: [{ email: "x@example.org" }],
    });
  });
});

describe("send", () => {
  test("[N1] without --user-confirmed previews every part and the blob digest, and submits nothing", async () => {
    const f = fake();
    const r = await run(["messages", "send", "--draft", "d1", "--json"], f.deps);
    expect(r.exitCode).toBe(3);
    const preview = JSON.parse(r.stdout).preview;
    expect(preview.digest).toBe(DIGEST);
    expect(preview.parts).toEqual([
      { cid: null, disposition: null, name: null, partId: "1", size: 5, type: "text/plain", value: "hello" },
      { cid: "img1", disposition: "inline", name: null, partId: "2", size: 70, type: "image/png" },
    ]);
    expect(JSON.parse(r.stderr).error.recovery).toBe(`fastmail-cli messages send --draft d1 --user-confirmed --expect ${DIGEST}`);
    expect(f.calls.some((c) => c.url.pathname === "/jmap/download/u1/blob-raw/message.eml")).toBe(true);
    expect(f.api().some((r) => r.methodCalls.some(([n]) => n === "EmailSubmission/set"))).toBe(false);
  });
  test("a truncated or undecodable text part refuses the preview", async () => {
    for (const value of [{ isTruncated: true, value: "hel" }, { isEncodingProblem: true, value: "h?llo" }, undefined]) {
      const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [{ ...DRAFT, bodyValues: value ? { "1": value } : {} }] }, c[2]] });
      const r = await run(["messages", "send", "--draft", "d1", "--json"], f.deps);
      expect(JSON.parse(r.stderr).error.code).toBe("preview_incomplete");
    }
  });
  test("leaves walks nested multiparts in order", () => {
    const tree = { subParts: [{ subParts: [{ partId: "a", type: "text/plain" }, { partId: "b", type: "text/html" }], type: "multipart/alternative" }, { partId: "c", type: "image/png" }], type: "multipart/mixed" };
    expect(leaves(tree).map((p) => p.partId)).toEqual(["a", "b", "c"]);
  });
  test("confirmed send submits once with the matching identity and the exact Sent move", async () => {
    const f = fake();
    const r = await run(["messages", "send", "--draft", "d1", "--user-confirmed", "--expect", DIGEST, "--json"], f.deps);
    expect(JSON.parse(r.stdout)).toMatchObject({ digest: DIGEST, sent: true, submission: "sub1" });
    const sub = f.api().find((r) => r.methodCalls[0]?.[0] === "EmailSubmission/set");
    expect(sub?.using).toContain("urn:ietf:params:jmap:submission");
    expect(sub?.methodCalls[0]?.[1]).toEqual({
      accountId: "u1",
      create: { send: { emailId: "d1", identityId: "id1" } },
      onSuccessUpdateEmail: { "#send": { "keywords/$draft": null, "mailboxIds/mb-dr": null, "mailboxIds/mb-se": true } },
    });
  });
  test("a changed digest refuses before submission", async () => {
    const f = fake();
    const r = await run(["messages", "send", "--draft", "d1", "--user-confirmed", "--expect", `sha256:${"0".repeat(64)}`, "--json"], f.deps);
    expect(JSON.parse(r.stderr).error.code).toBe("content_changed");
    expect(f.api().some((r) => r.methodCalls[0]?.[0] === "EmailSubmission/set")).toBe(false);
  });
  test("notCreated is rejected; a failed Sent move after created is sent with a warning", async () => {
    const rejected = fake({ "EmailSubmission/set": (_a, c) => ["EmailSubmission/set", { notCreated: { send: { type: "forbiddenFrom" } } }, c[2]] });
    const r = await run(["messages", "send", "--draft", "d1", "--user-confirmed", "--expect", DIGEST, "--json"], rejected.deps);
    expect(JSON.parse(r.stderr).error.code).toBe("send_rejected");
    const moved = fake({
      "EmailSubmission/set": (_a, c) => [
        ["EmailSubmission/set", { created: { send: { id: "sub1" } } }, c[2]],
        ["Email/set", { notUpdated: { d1: { type: "notFound" } } }, c[2]],
      ],
    });
    const w = await run(["messages", "send", "--draft", "d1", "--user-confirmed", "--expect", DIGEST, "--json"], moved.deps);
    expect(JSON.parse(w.stdout)).toMatchObject({ sent: true, warning: expect.stringContaining("Sent") });
  });
  test("a draft whose From has no identity is refused", async () => {
    const f = fake({ "Identity/get": (_a, c) => ["Identity/get", { list: [{ email: "other@example.com", id: "x" }] }, c[2]] });
    const r = await run(["messages", "send", "--draft", "d1", "--user-confirmed", "--expect", DIGEST, "--json"], f.deps);
    expect(JSON.parse(r.stderr).error.code).toBe("no_identity");
  });
  test("a lost submission response is outcome_unknown and is never retried", async () => {
    const f = fake({}, { lost: true });
    const r = await run(["messages", "send", "--draft", "d1", "--user-confirmed", "--expect", DIGEST, "--json"], f.deps);
    expect(JSON.parse(r.stderr).error).toMatchObject({ code: "outcome_unknown", dispatched: true });
    expect(f.calls.filter((c) => c.body.includes("EmailSubmission/set")).length).toBe(1);
  });
});

describe("trash, attachments and usage", () => {
  test("trash replaces mailboxIds with exactly Trash", async () => {
    const f = fake();
    expect((await run(["messages", "trash", "--id", "m1"], f.deps)).exitCode).toBe(0);
    expect(f.api().at(-1)?.methodCalls[0]?.[1]).toEqual({ accountId: "u1", update: { m1: { mailboxIds: { "mb-tr": true } } } });
  });
  test("downloads pick their own file names", async () => {
    const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [{ attachments: [{ blobId: "b9", name: "../../etc/passwd.txt", type: "text/plain" }], id: "m1" }] }, c[2]] });
    const out = JSON.parse((await run(["attachments", "download", "--message", "m1", "--json"], f.deps)).stdout);
    expect(out.downloaded[0].file).toMatch(/^fastmail-[0-9a-f]{12}\.txt$/);
    expect(new TextDecoder().decode(f.files.get(out.downloaded[0].file))).toBe("attachment bytes");
    expect(f.calls.at(-1)?.url.pathname).toBe("/jmap/download/u1/b9/..%2F..%2Fetc%2Fpasswd.txt");
  });
  test("unknown commands and options name the fix; a missing token fails", async () => {
    const f = fake();
    const r = await run(["messages", "delete", "--id", "x"], f.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("fastmail-cli --help");
    expect((await run(["messages", "read", "--id", "x", "--bogus", "1"], f.deps)).exitCode).toBe(2);
    expect((await run(["messages", "read", "--id", "a/b"], f.deps)).exitCode).toBe(2);
    const missing = await run(["folders", "list", "--json"], { ...f.deps, env: {} });
    expect(JSON.parse(missing.stderr).error.code).toBe("auth_missing");
    expect(f.calls.length).toBe(0);
  });
});
