/**
 * `pnpm ops consolidate …`: the group consolidation commands (FIN-GRP-01..04). Writes act as a member
 * (`--as <principal>`) and pass the same authorization as the API; register changes, runs and closes
 * are ops plans that a person commits (`ops consolidate commit`).
 *
 *   ops consolidate groups <tenant>
 *   ops consolidate define <tenant> <groupId> --name "…" --book <consolidation book> --parent <entity> --as p
 *   ops consolidate show <tenant> <groupId>
 *   ops consolidate <structure|ownership|ic-link|run|certify> <tenant> <groupId> --input '<json>' --as p   simulate (a plan)
 *   ops consolidate <tb|pnl|bs|ic|nci|perimeter> <tenant> <groupId> [--period-end d] --as p               reports (read ops)
 *   ops consolidate commit <tenant> <planId> --hash <hash> --as p
 *   ops consolidate dispute open <tenant> <groupId> --item <key> --period-end d --reason "…" --as p
 *   ops consolidate dispute position <tenant> <disputeId> --entity e --agreed <paise> --note "…" --as p
 *   ops consolidate dispute adjust <tenant> <disputeId> --accounts '{"ent":"ACCOUNT"}' [--date d] --as p
 *   ops consolidate closes <tenant> <groupId> | reproduce <tenant> <snapshotId>
 *   ops consolidate link list <tenant> | request <tenant> <groupId> --subsidiary t --entity e --as p
 *   ops consolidate link accept|revoke <tenant> <linkId> [--reason "…"] --as p
 *   ops consolidate link publish <tenant> <linkId> --book b --period-end d [--ic-parties '{"party":"entity"}'] --as p
 */
import type { Cell } from "./cell.ts";

const OPS: Record<string, string> = { structure: "group_structure", ownership: "group_ownership", "ic-link": "group_ic_link", run: "consolidate", certify: "certify_group",
  tb: "group_trial_balance", pnl: "group_pnl", bs: "group_balance_sheet", ic: "ic_mismatches", nci: "nci", perimeter: "group_perimeter" };

export const GROUP_CLI_USAGE = "usage: ops consolidate groups|define|show|structure|ownership|ic-link|run|certify|tb|pnl|bs|ic|nci|perimeter|commit|dispute|closes|reproduce|link …";

export async function groupCommand(cell: Cell, args: string[]): Promise<unknown> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
  const [sub, a1, a2, a3] = pos;
  const as = flag("--as");
  const needAs = () => { if (!as) throw new Error("this command acts as a member: --as <principal>"); return as; };
  const c = cell.consolidation;
  const bookOf = async (tenant: string, groupId: string) => { const g = await c.group(tenant, groupId); if (!g.exists) throw new Error(`no group ${groupId}`); return g.bookId; };
  const json = (name: string) => (flag(name) ? JSON.parse(flag(name)!) : {});
  if (sub && OPS[sub] && a1 && a2) {
    const input = sub in { tb: 1, pnl: 1, bs: 1, ic: 1, nci: 1 } ? { ...(flag("--period-end") ? { periodEnd: flag("--period-end") } : {}) }
      : sub === "perimeter" ? { ...(flag("--as-of") ? { asOf: flag("--as-of") } : {}) } : json("--input");
    return cell.ops.plan(a1, await bookOf(a1, a2), needAs(), OPS[sub]!, input);
  }
  switch (sub) {
    case "groups": if (a1) return c.groups(a1); break;
    case "define": if (a1 && a2) return c.defineGroup(a1, needAs(), { groupId: a2, name: flag("--name") ?? a2, bookId: flag("--book") ?? `${a2}-consolidation`, parentEntityId: flag("--parent") ?? "" }).then((g) => ({ groupId: g.groupId, bookId: g.bookId })); break;
    case "show": if (a1 && a2) { const g = await c.group(a1, a2); return { ...g, mapping: [...g.mapping], runs: await c.runs(a1, a2), closes: await c.closes(a1, a2) }; } break;
    case "commit": if (a1 && a2) return cell.ops.commit(a1, a2, needAs(), flag("--hash") ?? ""); break;
    case "closes": if (a1 && a2) return c.closes(a1, a2); break;
    case "reproduce": if (a1 && a2) return c.reproduce(a1, a2).then((r) => ({ snapshotId: r.snapshot.snapshotId, storedHash: r.snapshot.contentHash, recomputedHash: r.contentHash, matches: r.matches })); break;
    case "dispute":
      if (a1 === "open" && a2 && a3) return c.openDispute(a2, needAs(), a3, { itemKey: flag("--item") ?? "", periodEnd: flag("--period-end") ?? "", reason: flag("--reason") ?? "" });
      if (a1 === "position" && a2 && a3) return c.recordPosition(a2, needAs(), a3, { entityId: flag("--entity") ?? "", agreedPaise: BigInt(flag("--agreed") ?? "0"), note: flag("--note") ?? "" });
      if (a1 === "adjust" && a2 && a3) return c.proposeAdjustments(a2, needAs(), a3, json("--accounts"), flag("--date") ? { date: flag("--date") } : {});
      break;
    case "link":
      if (a1 === "list" && a2) return c.links.list(a2);
      if (a1 === "request" && a2 && a3) return c.links.request(a2, needAs(), { groupId: a3, subsidiaryTenant: flag("--subsidiary") ?? "", entityId: flag("--entity") ?? "" });
      if (a1 === "accept" && a2 && a3) return c.links.accept(a2, needAs(), a3);
      if (a1 === "revoke" && a2 && a3) return c.links.revoke(a2, needAs(), a3, flag("--reason") ?? "");
      if (a1 === "publish" && a2 && a3) return c.links.publish(a2, needAs(), a3, { bookId: flag("--book") ?? "", periodEnd: flag("--period-end") ?? "", icParties: json("--ic-parties") });
      break;
  }
  throw new Error(GROUP_CLI_USAGE);
}
