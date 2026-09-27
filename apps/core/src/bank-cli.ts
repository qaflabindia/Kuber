/**
 * `pnpm ops bank …`: cash and bank commands (FIN-CASH-01..03). Writes act as a member (`--as <principal>`)
 * and pass the same authorization as the API; certification is an ops plan an independent person commits.
 *
 *   ops bank accounts <tenant> <book>
 *   ops bank register <tenant> <book> <bankAccountId> --gl BANK --number <digits> --ifsc <IFSC> --opening-date d [--name "…"] [--stale-days n] [--fee-tolerance paise] --as p
 *   ops bank import <tenant> <book> <bankAccountId> <file.csv> --number <digits> [--from d --to d] --as p
 *   ops bank statements|exceptions <tenant> <book>
 *   ops bank coverage <tenant> <book> <bankAccountId>
 *   ops bank reconcile <tenant> <book> <bankAccountId> --period-end d [--period-from d]
 *   ops bank prepare <tenant> <book> <bankAccountId> --period-end d --as p          (plan certify_bank_reconciliation)
 *   ops bank certify <tenant> <planId> --hash <hash> --as p                        (commit: the independent certifier)
 *   ops bank reconciliations <tenant> <book> | verify <tenant> <book> <reconciliationId>
 *   ops bank stale <tenant> <book> <bankAccountId> --as-of d --as p
 * (Over HTTP, certification is a passkey-signed command; this operator tool runs with the operator's own database access.)
 */
import { readFileSync } from "node:fs";
import type { Cell } from "./cell.ts";

export const BANK_CLI_USAGE = "usage: ops bank accounts|register|import|statements|exceptions|coverage|reconcile|prepare|certify|reconciliations|verify|stale …";

export async function bankCommand(cell: Cell, args: string[]): Promise<unknown> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
  const [sub, t, b, x, y] = pos;
  const as = () => { const p = flag("--as"); if (!p) throw new Error("this command acts as a member: --as <principal>"); return p; };
  const need = (name: string) => { const v = flag(name); if (!v) throw new Error(`${name} is required`); return v; };
  const bank = cell.bank;
  if (!t) throw new Error(BANK_CLI_USAGE);
  switch (sub) {
    case "accounts": if (b) return bank.accounts(t, b); break;
    case "register": if (b && x) return bank.registerAccount(t, b, as(), { bankAccountId: x, glAccountId: flag("--gl") ?? "BANK", bankName: flag("--name") ?? "Bank",
      accountNumber: need("--number"), ifsc: need("--ifsc"), openingDate: need("--opening-date"),
      ...(flag("--stale-days") ? { staleDays: Number(flag("--stale-days")) } : {}), ...(flag("--fee-tolerance") ? { feeTolerancePaise: flag("--fee-tolerance") } : {}) }); break;
    case "import": if (b && x && y) return bank.importStatement(t, b, as(), { bankAccountId: x, csv: readFileSync(y, "utf8"), statementAccount: { accountNumber: need("--number") },
      ...(flag("--from") ? { periodFrom: flag("--from") } : {}), ...(flag("--to") ? { periodTo: flag("--to") } : {}) }); break;
    case "statements": if (b) return bank.statements(t, b); break;
    case "exceptions": if (b) return bank.exceptions(t, b, { status: "open" }); break;
    case "coverage": if (b && x) return bank.coverage(t, b, x); break;
    case "reconcile": if (b && x) return bank.reconciliation(t, b, x, need("--period-end"), flag("--period-from")); break;
    case "prepare": if (b && x) return cell.ops.plan(t, b, as(), "certify_bank_reconciliation", { bankAccountId: x, periodEnd: need("--period-end") }); break;
    case "certify": if (b) return cell.ops.commit(t, b, as(), need("--hash")); break;
    case "reconciliations": if (b) return bank.reconciliations(t, b); break;
    case "verify": if (b && x) return bank.verifyCertification(t, b, x); break;
    case "stale": if (b && x) return bank.scanStale(t, b, x, need("--as-of"), as()); break;
  }
  throw new Error(BANK_CLI_USAGE);
}
