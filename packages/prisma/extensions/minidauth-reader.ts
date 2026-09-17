/**
 * Per-user reader identity for minidauth field opening.
 *
 * The engine lives in the `minidauth-prisma` package; this file only re-exports the same symbols the
 * app already imports. A request handler wraps its work in `withMinidauthReader(userId, fn)` (see
 * middlewares/sessionMiddleware.ts), and the seal extension opens sealed fields as that user, gated by
 * minidauth's quorum grant. No reader in context means the field stays sealed.
 */
export {
  withMinidauthReader,
  currentReaderToken,
  mintReaderToken as mintCalReaderToken,
} from "minidauth-prisma";
