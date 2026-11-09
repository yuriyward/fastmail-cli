import { usage } from "./errors.ts";

const BOOLEAN = new Set(["unread", "all", "json", "user-confirmed", "help"]);
const REPEATED = new Set(["to", "cc", "bcc", "attach"]);
export interface Parsed {
  words: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}
export function parseArgs(argv: string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-h") {
      bools.add("help");
      continue;
    }
    if (!arg.startsWith("--")) {
      if (flags.size || bools.size > (bools.has("json") ? 1 : 0)) {
        throw usage(`Unexpected argument ${JSON.stringify(arg)}`);
      }
      words.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) {
      bools.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("--") && value !== "-")) {
      throw usage(`--${name} needs a value`);
    }
    i += 1;
    const existing = flags.get(name);
    if (existing && !REPEATED.has(name)) {
      throw usage(`--${name} given twice`);
    }
    flags.set(name, [...(existing ?? []), value]);
  }
  return { bools, flags, words };
}
export function one(parsed: Parsed, name: string, required: true): string;
export function one(parsed: Parsed, name: string, required?: false): string | undefined;
export function one(parsed: Parsed, name: string, required = false) {
  const value = parsed.flags.get(name)?.[0];
  if (required && value === undefined) {
    throw usage(`--${name} is required`, `fastmail-cli ${parsed.words.join(" ")} --help`);
  }
  return value;
}
export function allowOnly(parsed: Parsed, names: string[]) {
  for (const name of [...parsed.flags.keys(), ...parsed.bools]) {
    if (!["json", "help", ...names].includes(name)) {
      throw usage(`Unknown option --${name} for ${parsed.words.join(" ")}`, `fastmail-cli ${parsed.words.join(" ")} --help`);
    }
  }
}
/** JMAP ids are 1-255 characters of the URL-safe base64 alphabet (RFC 8620 §1.2). */
const ID = /^[A-Za-z0-9_-]{1,255}$/;
export function id(value: string, what: string) {
  if (!ID.test(value)) {
    throw usage(`${what} must be a JMAP id (letters, digits, -, _)`);
  }
  return value;
}
/** N3: one exact addr-spec per flag, never a list or a display name. */
export function address(value: string) {
  if (!/^[A-Za-z0-9.!#$&*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) || value.length > 254) {
    throw usage(`${JSON.stringify(value)} is not one exact email address; pass one address per --to/--cc/--bcc`);
  }
  return value;
}
export function limit(parsed: Parsed) {
  const raw = one(parsed, "limit") ?? "25";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw usage("--limit must be an integer from 1 to 100");
  }
  return n;
}
/** A `--cursor` is the position a previous page returned. */
export function cursor(parsed: Parsed) {
  const raw = one(parsed, "cursor") ?? "0";
  if (!/^(?:0|[1-9][0-9]{0,8})$/.test(raw)) {
    throw usage("--cursor must be the `cursor` a previous page returned");
  }
  return Number(raw);
}
