/**
 * minidauth field sealing for Cal.com (Prisma client extension).
 *
 * Seals selected personal fields (an attendee's name and phone, a booking's title and description)
 * with minidauth before they reach Postgres, and opens them again on the way out. The engine lives in
 * the `minidauth-prisma` package; this file only supplies Cal's field map and re-exports the same
 * symbols the rest of the app already imports, so nothing else changes.
 *
 * Off by default. Set MINIDAUTH_SEAL_URL to point at the sidecar to turn it on; unset, every path is a
 * no-op and Cal.com behaves exactly like upstream. See the package README for how it works, the
 * fail-closed/fail-safe behaviour, and the queryability limit.
 */
import { createMinidauthSeal } from "minidauth-prisma";

import { Prisma } from "../client";

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

const seal = createMinidauthSeal({ Prisma, sealed: SEALED, relations: RELATIONS });

/**
 * Open sealed fields on records that did NOT come through the Prisma client extension. Cal builds some
 * booking reads with Kysely raw SQL (see bookings/get.handler.ts), which bypasses the extension, so
 * call this on those results before returning them.
 */
export const openSealedRecords = seal.openSealedRecords;

/**
 * Wrap the Prisma client so the models in SEALED seal on write and open on read. Append it last in the
 * `.$extends(...)` chain so it is the outermost layer.
 */
export function minidauthSealExtension() {
  return seal.extension;
}
