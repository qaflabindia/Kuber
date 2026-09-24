/**
 * Authorization at module boundaries (defence in depth for finding F02).
 *
 * The HTTP and tool surfaces authorize every request, but modules are also called in-process
 * (the copilot, scripts, other modules). Modules whose commands change the books or feed them
 * (agent decisions, channel submissions) therefore check the principal again through this
 * interface; the identity module implements it with the same role, book-scope and membership
 * rules as the HTTP boundary. Without a guard, nothing passes.
 */
import type { TransactionSql } from "postgres";

export interface GuardScope { book?: string; allBooks?: boolean }

export interface ModuleGuard {
  /**
   * Throws (403) unless `principal` may perform `action` in `tenant` within `scope`. `tx`, when
   * given, is the caller's tenant transaction: the check reads memberships in it.
   */
  permit(tenant: string, principal: string, action: string, scope?: GuardScope, tx?: TransactionSql): Promise<void>;
  /** FIN-OPS-03: is autonomous action halted (kill switch) for this tenant's book? Absent: never. */
  autonomyHalted?(tenant: string, book: string, tx?: TransactionSql): Promise<boolean>;
}

export class GuardDenied extends Error {
  readonly statusCode = 403;
  readonly code = "forbidden";
}

/** Deny by default: a module built without a guard refuses every guarded command. */
export const DENY_ALL_GUARD: ModuleGuard = {
  permit: async (_t, principal, action) => { throw new GuardDenied(`${principal} may not ${action}: no authorization service configured`); },
};
