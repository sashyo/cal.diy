/**
 * minidauth field sealing for Cal.com (Prisma client extension).
 *
 * Seals selected personal fields (an attendee's name and phone, a booking's title and description)
 * with minidauth before they reach Postgres, and opens them again on the way out. The crypto runs in
 * the minidauth-seal sidecar, which talks to minidauth and the Tide ORK cohort: this app, and
 * Postgres, only ever hold ciphertext. The vendor key lives as threshold shares across the ORK
 * network and is never assembled here, so a stolen database or a leaked backup is unreadable, and a
 * quorum - not this app - decides whether records can be read at all (the sidecar's reader must hold
 * a quorum-granted role, or `open` returns nothing and the field stays sealed).
 *
 * Off by default. Set MINIDAUTH_SEAL_URL to point at the sidecar to turn it on; unset, every path
 * below is a no-op and Cal.com behaves exactly like upstream.
 *
 * Proof of concept. It batches: every sealed field in one operation (a booking plus its nested
 * attendees, or a whole page of results) opens in a single cohort fan-out, not one round trip per
 * field. The remaining limit is queryability - sealed columns hold ciphertext, so the database cannot
 * sort, filter, or search on them, which is why identity and lookup keys stay in the clear (see
 * SEALED). A production integration would protect one per-record data key with the cohort and AES the
 * payload under it locally (envelope encryption), one cohort op per record rather than per field.
 */
import { Prisma } from "../client";
import { currentReaderToken } from "./minidauth-reader";

const sealUrl = (): string | undefined => process.env.MINIDAUTH_SEAL_URL;
const enabled = (): boolean => Boolean(sealUrl());

// camelCase Prisma model -> the scalar string fields to seal. Seal the personal fields the database
// never sorts, filters, or searches on. Left deliberately in the clear:
//   - Attendee.email is an indexed lookup key (dedup, seats), so it must stay queryable.
//   - Booking.location is branched on by value ("integrations:zoom", a URL, an address), so sealing
//     it would break routing rather than just hide it.
const SEALED: Record<string, string[]> = {
  attendee: ["name", "phoneNumber"],
  booking: ["title", "description"],
};

// Relations to descend into, so a nested write (booking.create with attendees) and an included read
// (booking.findMany({ include: { attendees: true } })) both reach the child's sealed fields.
// model -> { relationKey: relatedModel }.
const RELATIONS: Record<string, Record<string, string>> = {
  booking: { attendees: "attendee" },
  attendee: { booking: "booking" },
};

const MARKER = "ms1:"; // a sealed string column is "ms1:<ciphertextB64>"
const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(MARKER);

async function sidecar(path: string, body: unknown, bearer?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`; // the reader's delegation token, on /open
  const r = await fetch(sealUrl() + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`minidauth-seal ${path} -> ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

// A leaf is one string value we can read and write in place, so the same code seals and opens it.
type Leaf = { get: () => unknown; set: (v: unknown) => void };
const leaf = (obj: any, key: string): Leaf => ({ get: () => obj[key], set: (v) => (obj[key] = v) });

// Write side: collect the plaintext leaves in a create/update `data` shape, descending into nested
// creates (create, createMany.data, connectOrCreate.create) so a booking's attendees seal with it.
function collectWriteLeaves(model: string, data: any, out: Leaf[]): void {
  if (!data || typeof data !== "object") return;
  for (const f of SEALED[model] || []) {
    // Collect every non-empty string, even one that already looks sealed. We do NOT skip an "ms1:"
    // value: a client can forge the prefix, and only the cohort can tell a genuine seal from a forgery
    // (via the VVK signature), so the sidecar seals everything and a forged prefix never lets plaintext
    // reach a sealed column. Callers pass plaintext here (reads open to plaintext), so this does not
    // double-seal in normal use.
    const v = data[f];
    if (typeof v === "string" && v.length > 0) out.push(leaf(data, f));
  }
  for (const [key, childModel] of Object.entries(RELATIONS[model] || {})) {
    const nested = data[key];
    if (!nested || typeof nested !== "object") continue;
    const creates = ([] as any[])
      .concat(nested.create ?? [])
      .concat(nested.createMany?.data ?? [])
      .concat((Array.isArray(nested.connectOrCreate) ? nested.connectOrCreate : [nested.connectOrCreate])
        .map((c: any) => c?.create)
        .filter(Boolean));
    for (const c of creates) collectWriteLeaves(childModel, c, out);
  }
}

// Read side: collect the sealed leaves in a returned record, descending into included relations.
function collectReadLeaves(model: string, node: any, out: Leaf[]): void {
  if (!node || typeof node !== "object") return;
  for (const f of SEALED[model] || []) if (isSealed(node[f])) out.push(leaf(node, f));
  for (const [key, childModel] of Object.entries(RELATIONS[model] || {})) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => collectReadLeaves(childModel, c, out));
    else if (child && typeof child === "object") collectReadLeaves(childModel, child, out);
  }
}

// Seal fails closed: if the sidecar is unreachable, the write throws rather than storing plaintext.
async function sealLeaves(leaves: Leaf[]): Promise<void> {
  if (leaves.length === 0) return;
  const fields: Record<string, string> = {};
  leaves.forEach((l, i) => (fields[String(i)] = l.get() as string));
  // The sidecar returns marker-included values (it decides what is genuine ciphertext), so store them
  // as-is; prepending the marker here would double it.
  const { sealed } = await sidecar("/seal", { fields });
  leaves.forEach((l, i) => l.set((sealed as Record<string, string>)[String(i)]));
}

let openWarned = false;
// Open is best-effort and gated on the reader's verified identity: decryption runs as the end user
// named in a token this request carries (withMinidauthReader), and only if minidauth's quorum grant
// says that user holds the reading role. No reader in context, an ungranted reader, or a sidecar that
// is down all leave the field sealed rather than crashing the read - ciphertext is the safe failure,
// and there is no standing reader for an unauthenticated caller to borrow.
async function openLeaves(leaves: Leaf[]): Promise<void> {
  if (leaves.length === 0) return;
  const readerToken = currentReaderToken();
  if (!readerToken) {
    if (!openWarned) {
      openWarned = true;
      // eslint-disable-next-line no-console
      console.warn("[minidauth-seal] no reader identity in context; leaving records sealed");
    }
    return;
  }
  try {
    const fields: Record<string, string> = {};
    leaves.forEach((l, i) => (fields[String(i)] = (l.get() as string).slice(MARKER.length)));
    // Forward the reader's own token so the sidecar decrypts as that verified user, gated by the grant.
    const { fields: opened } = await sidecar("/open", { fields }, readerToken); // one cohort fan-out
    leaves.forEach((l, i) => l.set((opened as Record<string, string>)[String(i)]));
  } catch (e) {
    if (!openWarned) {
      openWarned = true;
      // eslint-disable-next-line no-console
      console.warn("[minidauth-seal] leaving records sealed:", (e as Error).message);
    }
  }
}

async function openResult(model: string, result: any): Promise<void> {
  const leaves: Leaf[] = [];
  if (Array.isArray(result)) result.forEach((r) => collectReadLeaves(model, r, leaves));
  else collectReadLeaves(model, result, leaves);
  await openLeaves(leaves);
}

/**
 * Open sealed fields on records that did NOT come through the Prisma client extension - the bookings
 * list, for one, is built with Kysely raw SQL, which bypasses the `query` hooks below entirely, so
 * its `Booking.title`/`description` (and any nested sealed attendee fields) arrive as ciphertext.
 * Call this on such results before returning them to the client. Same reader-gated sidecar `/open`,
 * same one-fan-out batching, and the same fail-safe: with no reader in context, an ungranted reader,
 * or the sidecar down, the fields stay sealed rather than the read crashing. A no-op when sealing is
 * off, and it descends into the SEALED relations (a booking's attendees) exactly like a Prisma read.
 */
export async function openSealedRecords(model: string, records: any): Promise<void> {
  if (!enabled() || !records) return;
  await openResult(model, records);
}

/**
 * Wrap the Prisma client so the models in SEALED seal on write and open on read. Append it last in
 * the `.$extends(...)` chain so it is the outermost layer: it seals inbound `data` before the query
 * reaches Postgres, and opens the records on the way back out.
 */
export function minidauthSealExtension() {
  const query: Record<string, any> = {};
  for (const model of Object.keys(SEALED)) {
    query[model] = {
      // Writes: seal inbound data (including nested creates), then open the returned row so the API
      // response is plaintext, exactly as a read would be.
      async create({ args, query }: any) {
        if (!enabled()) return query(args);
        const leaves: Leaf[] = [];
        collectWriteLeaves(model, args.data, leaves);
        await sealLeaves(leaves);
        const res = await query(args);
        await openResult(model, res);
        return res;
      },
      async update({ args, query }: any) {
        if (!enabled()) return query(args);
        const leaves: Leaf[] = [];
        collectWriteLeaves(model, args.data, leaves);
        await sealLeaves(leaves);
        const res = await query(args);
        await openResult(model, res);
        return res;
      },
      async upsert({ args, query }: any) {
        if (!enabled()) return query(args);
        const leaves: Leaf[] = [];
        collectWriteLeaves(model, args.create, leaves);
        collectWriteLeaves(model, args.update, leaves);
        await sealLeaves(leaves);
        const res = await query(args);
        await openResult(model, res);
        return res;
      },
      async createMany({ args, query }: any) {
        if (!enabled()) return query(args);
        const leaves: Leaf[] = [];
        const rows = Array.isArray(args.data) ? args.data : [args.data];
        rows.forEach((d: any) => collectWriteLeaves(model, d, leaves));
        await sealLeaves(leaves);
        return query(args); // createMany returns a count, nothing to open
      },
      async updateMany({ args, query }: any) {
        if (!enabled()) return query(args);
        const leaves: Leaf[] = [];
        collectWriteLeaves(model, args.data, leaves);
        await sealLeaves(leaves);
        return query(args);
      },
      // Reads: open the returned records, batched into one fan-out.
      async findUnique({ args, query }: any) {
        const res = await query(args);
        if (enabled()) await openResult(model, res);
        return res;
      },
      async findUniqueOrThrow({ args, query }: any) {
        const res = await query(args);
        if (enabled()) await openResult(model, res);
        return res;
      },
      async findFirst({ args, query }: any) {
        const res = await query(args);
        if (enabled()) await openResult(model, res);
        return res;
      },
      async findFirstOrThrow({ args, query }: any) {
        const res = await query(args);
        if (enabled()) await openResult(model, res);
        return res;
      },
      async findMany({ args, query }: any) {
        const res = await query(args);
        if (enabled()) await openResult(model, res);
        return res;
      },
    };
  }
  // The query object is built dynamically from SEALED, so its keys are not statically known to
  // Prisma's generated types; the per-model handler shapes are correct at runtime. Cast to the
  // expected argument type (the individual handlers are already `any`-typed, as in the other dynamic
  // extensions in this folder).
  return Prisma.defineExtension({ query } as Parameters<typeof Prisma.defineExtension>[0]);
}
