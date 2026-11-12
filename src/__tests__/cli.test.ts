import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  for (const command of ["create", "reply", "forward"]) {
    for (const withHtml of [false, true]) {
      for (const originalHasHtml of command === "create" ? [false] : [false, true]) {
        test(`${command}: HTML=${withHtml}, original HTML=${originalHasHtml}`, async () => {
          const original = {
            from: [{ email: "bob@example.org", name: "Bob <B>" }],
            to: [{ email: "owner@example.com" }],
            subject: "A <plan>",
            textBody: [{ partId: "plain" }],
            htmlBody: originalHasHtml ? [{ partId: "rich" }] : [],
            bodyValues: { plain: { value: "original <text>\nsecond line" }, rich: { value: "<p>Original <b>HTML</b></p>" } },
            attachments: [{ blobId: "original-blob", name: "original.txt", type: "text/plain" }],
          };
          const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [original] }, c[2]] });
          const html = '<p style="font-family: sans-serif">Hello & welcome</p>';
          f.deps.readFile = async (path) => new TextEncoder().encode(path === "body.html" ? html : "Hello");
          const args = command === "create" ? ["--to", "bob@example.org", "--subject", "s"]
            : command === "reply" ? ["--id", "m1"] : ["--id", "m1", "--to", "carol@example.org"];
          const result = await run(["drafts", command, ...args, "--body-file", "body.txt", ...(withHtml ? ["--body-html-file", "body.html"] : [])], f.deps);
          expect(result.exitCode).toBe(0);
          const email = (f.api().at(-1)?.methodCalls[0]?.[1].create as Record<string, Record<string, unknown>>).draft!;
          const values = email.bodyValues as Record<string, { value: string }>;
          expect(email.textBody).toEqual([{ partId: "text", type: "text/plain" }]);
          expect(values.text?.value).toBe(command === "create" ? "Hello" : command === "reply"
            ? "Hello\n\nOn an earlier date, Bob <B> <bob@example.org> wrote:\n> original <text>\n> second line\n"
            : "Hello\n\n---------- Forwarded message ----------\nFrom: Bob <B> <bob@example.org>\nDate: \nSubject: A <plan>\nTo: owner@example.com\n\noriginal <text>\nsecond line\n");
          if (withHtml) {
            expect(email.htmlBody).toEqual([{ partId: "html", type: "text/html" }]);
            expect(values.html?.value.startsWith(html)).toBe(true);
            if (command !== "create") {
              expect(values.html?.value).toContain(`<blockquote>${originalHasHtml ? "<p>Original <b>HTML</b></p>" : "original &lt;text&gt;<br>\nsecond line"}</blockquote>`);
              expect(values.html?.value).toContain("Bob &lt;B&gt;");
            } else expect(values.html?.value).toBe(html);
          } else {
            expect(email.htmlBody).toBeUndefined();
            expect(values.html).toBeUndefined();
          }
          if (command === "forward") expect(email.attachments).toEqual([{ blobId: "original-blob", name: "original.txt", type: "text/plain", disposition: "attachment" }]);
        });
      }
    }
    test(`${command}: HTML file size boundary`, async () => {
      for (const size of [1024 * 1024, 1024 * 1024 + 1]) {
        const f = fake({ "Email/get": (_a, c) => ["Email/get", { list: [{ from: [{ email: "bob@example.org" }] }] }, c[2]] });
        f.deps.readFile = async () => new Uint8Array(size).fill(120);
        const args = command === "create" ? ["--to", "bob@example.org", "--subject", "s"]
          : command === "reply" ? ["--id", "m1"] : ["--id", "m1", "--to", "carol@example.org"];
        const result = await run(["drafts", command, ...args, "--body-file", "body.txt", "--body-html-file", "body.html"], f.deps);
        expect(result.exitCode).toBe(size === 1024 * 1024 ? 0 : 2);
        if (size > 1024 * 1024) expect(f.api().some((r) => r.methodCalls.some((c) => c[0] === "Email/set"))).toBe(false);
      }
    });
  }
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

describe("split batches", () => {
  const batch = "01234567-89ab-4cde-8fab-0123456789ab";
  const keyword = `$ward-split-${batch}`;
  const cc = [{email: "carol@example.org"}];
  const bcc = [{email: "blind@example.org"}];
  function splitFake(mode: "ok" | "partial" | "none" | "unknown" | "lost" | "move-fails" = "ok", mutate?: (draft: Record<string, unknown>) => void) {
    const make = (id: string, marker: string, self = false): Record<string, unknown> => ({
      ...DRAFT, id, blobId: `raw-${id}`, cc, ...(self ? {bcc} : {}),
      sender: [{email: "owner@example.com"}], replyTo: [{email: "reply@example.com"}],
      messageId: ["shared@example.com"],
      keywords: {$draft: true, [keyword]: true, [marker]: true},
    });
    const drafts = [make("self", "$ward-split-self", true), ...[0,1,2].map(i => make(`r${i}`, `$ward-split-recipient-${i}`))];
    if (mutate) mutate(drafts[1]!);
    return fake({
      "Email/query": (_a,c) => ["Email/query", {ids: drafts.map(d => d.id)}, c[2]],
      "Email/get": (a,c) => ["Email/get", {list: drafts.filter(d => (a.ids as string[]).includes(String(d.id)))}, c[2]],
      "EmailSubmission/set": (_a,c) => ["EmailSubmission/set", {
        created: mode === "none" ? {} : {r0: {id: "s0"}, ...(mode === "partial" || mode === "unknown" ? {} : {r1: {id: "s1"}, r2: {id: "s2"}})},
        notCreated: mode === "none" ? {r0: {type: "forbidden"}, r1: {type: "forbidden"}, r2: {type: "forbidden"}} : mode === "partial" ? {r1: {type: "forbidden"}, r2: {type: "forbidden"}} : {},
      }, c[2]],
      "Email/set": (_a,c) => ["Email/set", mode === "move-fails" ? {notUpdated: {self: {type: "forbidden"}}} : {updated: {self: null}}, c[2]],
    }, {lost: mode === "lost"});
  }
  const args = ["messages", "send-split", "--batch", batch, "--json"];
  const writes = (f: ReturnType<typeof fake>) => f.api().flatMap(a => a.methodCalls).filter(c => c[0].endsWith("/set"));
  async function approve(f: ReturnType<typeof fake>) {
    const p = await run(args, f.deps);
    expect(p.exitCode).toBe(3);
    return JSON.parse(p.stdout).preview.digest as string;
  }
  test("preview shows self in full, recipients, sender, reply-to, attachment and count without writes", async () => {
    const f = splitFake();
    const p = await run(args, f.deps);
    expect(p.exitCode).toBe(3);
    expect(JSON.parse(p.stdout).preview).toMatchObject({copies: 3, bcc, cc, sender: [{email: "owner@example.com"}], replyTo: [{email: "reply@example.com"}], parts: [{value: "hello"}, {type: "image/png"}]});
    expect(writes(f)).toEqual([]);
  });
  test("confirmed envelopes and cleanup references are exact, self move is a separate request", async () => {
    const f = splitFake();
    const digest = await approve(f);
    const r = await run([...args, "--user-confirmed", "--expect", digest], f.deps);
    expect(r.exitCode).toBe(0);
    const [send,move] = writes(f);
    expect(send?.[1]).toEqual({accountId: "u1", create: Object.fromEntries(["bob@example.org", "carol@example.org", "blind@example.org"].map((email,i) => [`r${i}`, {emailId: `r${i}`, identityId: "id1", envelope: {mailFrom: {email: "owner@example.com", parameters: null}, rcptTo: [{email, parameters: null}]}}])), onSuccessDestroyEmail: ["#r0", "#r1", "#r2"]});
    expect(move?.[1]).toEqual({accountId: "u1", update: {self: {"mailboxIds/mb-dr": null, "mailboxIds/mb-se": true, "keywords/$draft": null}}});
    expect(f.api().filter(a => a.methodCalls.some(c => c[0].endsWith("/set"))).every(a => a.methodCalls.length === 1)).toBe(true);
  });
  for (const mode of ["partial", "none", "unknown", "lost", "move-fails"] as const) test(`submission outcomes: ${mode}`, async () => {
    const f = splitFake(mode);
    const digest = await approve(f);
    const r = await run([...args, "--user-confirmed", "--expect", digest], f.deps);
    const writeCalls = writes(f);
    expect(writeCalls.filter(c => c[0] === "EmailSubmission/set")).toHaveLength(1);
    if (mode === "partial") {
      expect(JSON.parse(r.stdout)).toMatchObject({accepted: 1, outcomes: [{outcome: "accepted"}, {outcome: "rejected"}, {outcome: "rejected"}]});
      expect(writeCalls[1]?.[1]).toMatchObject({update: {self: {"keywords/$ward-partial": true}}});
    } else if (mode === "move-fails") expect(JSON.parse(r.stdout).warning).toContain("not moved");
    else {
      expect(writeCalls).toHaveLength(1);
      expect(JSON.parse(r.stderr).error.code).toBe(mode === "none" ? "send_rejected" : "outcome_unknown");
    }
  });
  test("changed digest, mismatched headers, duplicate routing and recipient Bcc refuse", async () => {
    const f = splitFake();
    const r = await run([...args, "--user-confirmed", "--expect", "sha256:wrong"], f.deps);
    expect(JSON.parse(r.stderr).error.code).toBe("content_changed");
    expect(writes(f)).toEqual([]);
    for (const mutate of [
      (d: Record<string, unknown>) => {d.replyTo = [{email: "other@example.org"}];},
      (d: Record<string, unknown>) => {d.sentAt = "2026-11-12T00:00:00Z";},
      (d: Record<string, unknown>) => {d.bcc = bcc;},
      (d: Record<string, unknown>) => {d.keywords = {$draft: true, [keyword]: true, "$ward-split-recipient-1": true};},
    ]) {
      const bad = splitFake("ok", mutate);
      expect(JSON.parse((await run(args, bad.deps)).stderr).error.code).toBe("invalid_batch");
      expect(writes(bad)).toEqual([]);
    }
  });
  test("incomplete recipient text refuses preview and malformed write responses stay unknown", async () => {
    const f = splitFake("ok", d => {d.bodyValues = {"1": {value: "cut", isTruncated: true}};});
    expect(JSON.parse((await run(args, f.deps)).stderr).error.code).toBe("preview_incomplete");
    expect(writes(f)).toEqual([]);
    for (const body of [{methodResponses: []}, {unexpected: true}]) {
      const g = splitFake();
      const digest = await approve(g);
      let submissions = 0;
      const deps = {...g.deps, fetch: async (url: string, init: RequestInit) => {
        const calls = init.method === "POST" && typeof init.body === "string" ? JSON.parse(init.body).methodCalls as Call[] : [];
        if (calls.some(c => c[0] === "EmailSubmission/set")) {submissions++; return Response.json(body);}
        return g.deps.fetch(url, init);
      }};
      const r = await run([...args, "--user-confirmed", "--expect", digest], deps);
      expect(JSON.parse(r.stderr).error.code).toBe("outcome_unknown");
      expect(submissions).toBe(1);
      expect(writes(g)).toEqual([]);
    }
  });
  test("ordinary send refuses stranded split drafts", async () => {
    const f = splitFake();
    const r = await run(["messages", "send", "--draft", "r0", "--json"], f.deps);
    expect(JSON.parse(r.stderr).error.code).toBe("refused");
    expect(writes(f)).toEqual([]);
  });
  for (const layout of ["nested", "flat"] as const) test(`create-split consumes actual compose output in ${layout} layout and fixes common headers, including Date`, async () => {
    const dir = join(import.meta.dir, "fixtures", "compose-per-recipient");
    const receipt = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
    expect(receipt.recipients).toBeUndefined();
    expect(receipt.items).toHaveLength(3);
    let submitted: Record<string, Record<string, unknown>> = {};
    const f = fake({"Email/set": (a,c) => {
      submitted = a.create as typeof submitted;
      return ["Email/set", {created: Object.fromEntries(Object.keys(submitted).map(k => [k, {id: `new-${k}`}]))}, c[2]];
    }});
    // Flatten the producer's real bytes without changing receipt indices or bodies.
    const flatFiles = new Map<string, Uint8Array>([["receipt.json", await readFile(join(dir, "receipt.json"))]]);
    for (const [name, source] of [["self", "self"], ...receipt.items.map((item: {i: number}) => [`recipient-${item.i}`, `recipients/${item.i}`])]) {
      for (const ext of ["txt", "html"]) flatFiles.set(`${name}.body.${ext}`, await readFile(join(dir, source, `body.${ext}`)));
    }
    const inputRead = layout === "nested" ? readFile : async (path: string) => {
      // Model ward-access's input namespace: no nested paths are available at all.
      expect(path).not.toContain("/");
      const value = flatFiles.get(path);
      if (!value) throw Object.assign(new Error(`missing ${path}`), {code: "ENOENT"});
      return value;
    };
    const before = Date.now() - 1000;
    const r = await run(["drafts", "create-split", "--dir", layout === "flat" ? "." : dir, "--to", ...receipt.to, "--cc", ...receipt.cc, "--bcc", ...receipt.bcc, "--subject", receipt.subject, "--attach", layout === "flat" ? "self.body.txt" : join(dir, "self", "body.txt"), "--json"], {...f.deps, readFile: inputRead});
    expect(r.exitCode).toBe(0);
    const batch = JSON.parse(r.stdout).batch;
    const self = submitted.self!;
    expect(Object.keys(submitted)).toHaveLength(4);
    expect(self.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(String(self.sentAt))).toBeGreaterThanOrEqual(before);
    expect(Date.parse(String(self.sentAt))).toBeLessThanOrEqual(Date.now());
    const common = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([key]) => !["bcc", "keywords", "bodyValues"].includes(key)));
    for (const d of Object.values(submitted)) expect(common(d)).toEqual(common(self));
    expect(self.keywords).toMatchObject({"$ward-split-self": true, [`$ward-split-${batch}`]: true});
    expect(self.bcc).toEqual([{email: "blind@example.org"}]);
    expect(self.bodyValues).toEqual({text: {value: await readFile(join(dir, "self", "body.txt"), "utf8")}, html: {value: await readFile(join(dir, "self", "body.html"), "utf8")}});
    for (const item of receipt.items) {
      const copy = submitted[`r${item.i}`]!;
      expect(copy.bcc).toBeUndefined();
      expect(copy.keywords).toMatchObject({[`$ward-split-recipient-${item.i}`]: true, [`$ward-split-${batch}`]: true});
      const html = await readFile(join(dir, "recipients", String(item.i), "body.html"), "utf8");
      expect(html).toContain(item.imageToken);
      expect(html).toContain(item.linkTokens[0]);
      expect(copy.bodyValues).toEqual({text: {value: await readFile(join(dir, "recipients", String(item.i), "body.txt"), "utf8")}, html: {value: html}});
    }
    expect(f.calls.filter(c => c.url.pathname.startsWith("/jmap/upload/"))).toHaveLength(1);
  });
  test("flat layout failures never fall back to nested files or perform writes", async () => {
    for (const [missing, code] of [["self.body.txt", "EACCES"], ["self.body.html", "ENOENT"], ["recipient-0.body.txt", "ENOENT"]]) {
      const f = fake();
      const reads: string[] = [];
      const r = await run(["drafts", "create-split", "--dir", ".", "--to", "bob@example.org", "--subject", "Hi", "--json"], {
        ...f.deps,
        readFile: async (path: string) => {
          reads.push(path);
          if (path === missing) throw Object.assign(new Error(`cannot read ${path}`), {code});
          return new TextEncoder().encode(path === "receipt.json" ? JSON.stringify({items: [{i: 0, address: "bob@example.org"}]}) : "body");
        },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain(`cannot read ${missing}`);
      expect(reads.every(path => !path.includes("/"))).toBe(true);
      expect(f.calls).toHaveLength(0);
    }
  });
  test("create-split refuses missing items, invalid indices and duplicate mappings before writes", async () => {
    for (const receipt of [
      {recipients: {"0": "bob@example.org"}},
      {items: [null]},
      {items: [{i: "0", address: "bob@example.org"}]},
      {items: [{i: -1, address: "bob@example.org"}]},
      {items: [{i: 0.5, address: "bob@example.org"}]},
      {items: [{i: "../self", address: "bob@example.org"}]},
      {items: [{i: 0, address: "bob@example.org"}, {i: 0, address: "carol@example.org"}]},
      {items: [{i: 0, address: "bob@example.org"}, {i: 1, address: "BOB@example.org"}]},
    ]) {
      const f = fake();
      const deps = {...f.deps, readFile: async () => new TextEncoder().encode(JSON.stringify(receipt))};
      const r = await run(["drafts", "create-split", "--dir", "compose", "--to", "bob@example.org", "--subject", "Hi", "--json"], deps);
      expect(r.exitCode).toBe(2);
      expect(f.calls).toHaveLength(0);
    }
  });
  test("create reads receipt mapping, shares headers and attachment uploads, omits recipient Bcc", async () => {
    let submitted: Record<string, Record<string, unknown>> = {};
    const f = fake({"Email/set": (a,c) => {
      submitted = a.create as typeof submitted;
      return ["Email/set", {created: Object.fromEntries(Object.keys(submitted).map(k => [k, {id: `new-${k}`}]))}, c[2]];
    }});
    const inputs = new Map(Object.entries({
      "compose/receipt.json": JSON.stringify({items: [{i: 4, address: "BLIND@example.org"}, {i: 2, address: "bob@example.org"}]}),
      "compose/recipients/4/body.txt": "blind text", "compose/recipients/4/body.html": "<p>blind</p>",
      "compose/recipients/2/body.txt": "bob text", "compose/recipients/2/body.html": "<p>bob</p>",
      "compose/self/body.txt": "self text", "compose/self/body.html": "<p>self</p>", "file.txt": "attached",
    }));
    const deps = {...f.deps, readFile: async (p: string) => {const v = inputs.get(p); if (v === undefined) throw Object.assign(new Error(`missing ${p}`), {code: "ENOENT"}); return new TextEncoder().encode(v);}};
    const r = await run(["drafts", "create-split", "--dir", "compose", "--to", "bob@example.org", "--bcc", "blind@example.org", "--subject", "Hello", "--attach", "file.txt", "--json"], deps);
    expect(r.exitCode).toBe(0);
    const createdBatch = JSON.parse(r.stdout).batch;
    expect(Object.keys(submitted)).toHaveLength(3);
    expect(submitted.r0?.bcc).toBeUndefined();
    expect(submitted.r1?.bcc).toBeUndefined();
    expect(submitted.self?.bcc).toEqual([{email: "blind@example.org"}]);
    for (const d of Object.values(submitted)) {
      for (const field of ["from", "sender", "replyTo", "to", "cc", "subject", "messageId", "sentAt", "inReplyTo", "references", "attachments"]) expect(d[field]).toEqual(submitted.self?.[field]);
      expect(d.keywords).toMatchObject({[`$ward-split-${createdBatch}`]: true});
      expect(Object.keys(d).some(k => k.toLowerCase().includes("x-ward"))).toBe(false);
    }
    expect(submitted.r0?.bodyValues).toMatchObject({text: {value: "bob text"}});
    expect(f.calls.filter(c => c.url.pathname.startsWith("/jmap/upload/"))).toHaveLength(1);
    inputs.set("compose/receipt.json", JSON.stringify({items: [{i: 0, address: "extra@example.org"}]}));
    const before = writes(f).length;
    const bad = await run(["drafts", "create-split", "--dir", "compose", "--to", "bob@example.org", "--subject", "Hi", "--json"], deps);
    expect(bad.exitCode).toBe(2);
    expect(writes(f)).toHaveLength(before);
  });
});

test("batch digest uses the versioned JCS contract and binds every manifest field", async () => {
  const {batchDigest, jcs} = await import("../split.ts");
  const manifest = {v: 1 as const, account: "a", identity: "i", mailFrom: "owner@example.com", self: {id: "s", blob: "abc"}, items: [{id: "z", blob: "def", rcptTo: "b@example.org"}, {id: "b", blob: "123", rcptTo: "c@example.org"}]};
  const canonical = '{"account":"a","identity":"i","items":[{"blob":"123","id":"b","rcptTo":"c@example.org"},{"blob":"def","id":"z","rcptTo":"b@example.org"}],"mailFrom":"owner@example.com","self":{"blob":"abc","id":"s"},"v":1}';
  const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  expect(batchDigest(manifest)).toBe(digest);
  expect(batchDigest({...manifest, items: [...manifest.items].reverse()})).toBe(digest);
  for (const change of [{account: "other"}, {identity: "other"}, {mailFrom: "other@example.com"}, {self: {id: "other", blob: "abc"}}, {self: {id: "s", blob: "other"}}, {items: [{id: "z", blob: "changed", rcptTo: "b@example.org"}]}]) expect(batchDigest({...manifest, ...change})).not.toBe(digest);
  expect(jcs({"\u20ac": "€", a: "\n\"", n: 1e-7})).toBe('{"a":"\\n\\\"","n":1e-7,"€":"€"}');
});
