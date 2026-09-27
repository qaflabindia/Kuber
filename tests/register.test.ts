/**
 * Requirements traceability register (requirements/register.md): the static checks of
 * scripts/check-register.ts run in CI, so a "verified" row that points at a missing, renamed,
 * skipped or failing test, or lacks evidence, fails the build. No database needed.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  checkRegister, COLUMNS, findTitles, parseRegister, parseTestIds, repoFs, STATUSES, type EvidenceFile, type Fs,
} from "../scripts/check-register.ts";

const root = resolve(import.meta.dirname, "..");

describe("requirements register (requirements/register.md)", () => {
  const fs = repoFs(root);
  const { rows, errors } = parseRegister(fs.read("requirements/register.md"));

  it("parses and passes every static check", () => {
    expect(errors).toEqual([]);
    expect(checkRegister(rows, fs)).toEqual([]);
  });

  it("has one row per G0 requirement and architecture finding", () => {
    const expected = [
      ...[1, 2, 3, 4, 5].map((n) => `FIN-MDM-0${n}`), ...[1, 2, 3, 4, 5].map((n) => `FIN-GL-0${n}`),
      ...[1, 2, 3].map((n) => `FIN-OPS-0${n}`), ...[1, 2, 3, 4].map((n) => `FIN-GRP-0${n}`), "UAT-COM",
      ...Array.from({ length: 18 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, i) => `ROLE-0${i + 1}`),                    // role model v2 (design 6.3)
      "FIN-RPT-01", "FIN-RPT-02",                                                     // G1 statements and KPIs (CFO §3.10)
    ];
    // Agent-governance controls (TAGOF TOL/AGT/PRM/GEN/CBJ/LOG) are listed too; every G0 id above must be present.
    const ids = rows.map((r) => r.id);
    for (const id of expected) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    const extra = ids.filter((id) => !expected.includes(id));
    // G1 controlled pilot books (CFO requirements §5): close, cash, reporting and migration requirements.
    for (const id of extra) expect(id).toMatch(/^(TOL|AGT|PRM|GEN|CBJ|LOG|MON|FIN-GRP|FIN-CLS|FIN-CASH|FIN-RPT|FIN-MIG|UAT)-\d\d$/);
  });

  it("has a row for each G1 close requirement (FIN-CLS-01..04)", () => {
    const ids = rows.map((r) => r.id);
    for (const n of [1, 2, 3, 4]) expect(ids).toContain(`FIN-CLS-0${n}`);
  });

  it("engineering has claimed nothing beyond verified, and nothing is signed off", () => {
    for (const r of rows) {
      expect(["proposed", "implemented", "verified", "blocked", "failed"]).toContain(r.status);
      expect(r.businessOwner).toMatch(/^Unassigned — /);
      expect(r.signOff).toBe("Pending");
    }
    expect(rows.find((r) => r.id === "FIN-OPS-01")!.status).toBe("implemented");  // drill never run end to end
  });
});

// ------------------------------------------------------------------------------------------ fixtures

const TEST_SRC = `
describe("ledger", () => {
  it("posts once", async () => {});
  it.skipIf(!existsSync(join("a", "b")))("posts over nats", async () => {});
  it.skip("posts later", () => {});
  it(\`\${name}: rebuilds\`, () => {});
  it('quotes "inside" titles', () => {});
});
`;

const evidence = (status: Record<string, string>): EvidenceFile => ({
  commit: "abc1234def5678abc1234def5678abc1234def56", dirty: false, ranAt: "2026-09-25T00:00:00Z", command: "vitest",
  summary: { passed: 0, failed: 0, skipped: 0 },
  results: Object.entries(status).map(([title, s]) => ({ file: "tests/x.test.ts", ancestors: ["ledger"], title, status: s })),
});

const memFs = (files: Record<string, string>): Fs => ({ exists: (p) => p in files, read: (p) => {
  if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]!;
} });

const fsWith = (ev: EvidenceFile = evidence({ "posts once": "passed", "posts over nats": "passed", 'quotes "inside" titles': "passed" })) =>
  memFs({ "tests/x.test.ts": TEST_SRC, "requirements/evidence/run.json": JSON.stringify(ev) });

const EV = "`requirements/evidence/run.json` at `abc1234`";
const row = (cells: Partial<Record<(typeof COLUMNS)[number], string>> = {}) => {
  const c = { "Requirement ID": "FIN-X-01", "Source section": "§1", "Business owner": "Unassigned — Controller", "Delivery owner": "Engineering",
    Gate: "G0", Status: "verified", "Code/config ref": "`modules/x.ts`", "UAT/test ID": "`tests/x.test.ts::posts once`",
    "Evidence artifact and tested commit": EV, "Finance sign-off": "Pending", "Deferral/expiry": "—", ...cells };
  return `| ${COLUMNS.map((k) => c[k]).join(" | ")} |`;
};
const table = (...rows: string[]) => `# R\n\n| ${COLUMNS.join(" | ")} |\n| ${COLUMNS.map(() => "---").join(" | ")} |\n${rows.join("\n")}\n`;
const check = (md: string, fs: Fs = fsWith()) => { const p = parseRegister(md); return [...p.errors, ...checkRegister(p.rows, fs)]; };

describe("register check on in-memory fixtures", () => {
  it("accepts a verified row with a resolving test and matching passed evidence", () => {
    expect(check(table(row(), row({ "Requirement ID": "FIN-X-02", "UAT/test ID": "`tests/x.test.ts::ledger`<br>`tests/x.test.ts::posts over nats`" }))))
      .toEqual([]);
    expect(check(table(row({ Status: "implemented", "UAT/test ID": "—", "Evidence artifact and tested commit": "—" })))).toEqual([]);
    expect(check(table(row({ Status: "proposed", "UAT/test ID": "—", "Evidence artifact and tested commit": "—" })))).toEqual([]);
  });

  it("rejects a verified row without a test ID", () => {
    expect(check(table(row({ "UAT/test ID": "—" })))).toEqual([expect.stringMatching(/"verified" needs a UAT\/test ID/)]);
  });

  it("rejects an operationally proven row without a test ID", () => {
    const e = check(table(row({ Status: "operationally proven", "Business owner": "A. Person (Controller)", "UAT/test ID": "" })));
    expect(e).toEqual([expect.stringMatching(/"operationally proven" needs a UAT\/test ID/)]);
  });

  it("rejects a test ID whose title is not in the named file", () => {
    expect(check(table(row({ "UAT/test ID": "`tests/x.test.ts::posts twice`" }))))
      .toContainEqual(expect.stringMatching(/no it\(\)\/describe\(\) titled "posts twice" in tests\/x.test.ts/));
  });

  it("rejects a test ID naming a file that does not exist", () => {
    expect(check(table(row({ "UAT/test ID": "`tests/y.test.ts::posts once`" }))))
      .toContainEqual(expect.stringMatching(/test file tests\/y.test.ts does not exist/));
  });

  it("rejects a test that is unconditionally skipped, and a malformed ID", () => {
    expect(check(table(row({ "UAT/test ID": "`tests/x.test.ts::posts later`" })))).toContainEqual(expect.stringMatching(/marked \.skip/));
    expect(check(table(row({ "UAT/test ID": "`tests/x.test.ts posts once`" })))).toContainEqual(expect.stringMatching(/malformed test ID/));
  });

  it("rejects a verified row without an evidence artifact or tested commit", () => {
    for (const ev of ["—", "`abc1234`", "`requirements/evidence/run.json`"])
      expect(check(table(row({ "Evidence artifact and tested commit": ev }))))
        .toContainEqual(expect.stringMatching(/"verified" needs an evidence artifact and the tested commit/));
    expect(check(table(row({ "Evidence artifact and tested commit": "`requirements/evidence/none.json` at `abc1234`" }))))
      .toContainEqual(expect.stringMatching(/evidence artifact requirements\/evidence\/none.json does not exist/));
  });

  it("rejects evidence for another commit, or where a cited test did not pass", () => {
    expect(check(table(row({ "Evidence artifact and tested commit": "`requirements/evidence/run.json` at `fff9999`" }))))
      .toContainEqual(expect.stringMatching(/is for commit abc1234.*cites fff9999/));
    expect(check(table(row({ "UAT/test ID": "`tests/x.test.ts::posts over nats`" })), fsWith(evidence({ "posts once": "passed", "posts over nats": "skipped" }))))
      .toContainEqual(expect.stringMatching(/records tests\/x.test.ts::posts over nats as skipped, not passed/));
    expect(check(table(row({ "UAT/test ID": "`tests/x.test.ts::ledger`" })), fsWith(evidence({ "posts once": "passed", "posts over nats": "failed" }))))
      .toContainEqual(expect.stringMatching(/::ledger as .*failed.*not passed/));
  });

  it("rejects finance-approved, operationally proven or signed off while the business owner is unassigned", () => {
    expect(check(table(row({ Status: "finance-approved" })))).toContainEqual(expect.stringMatching(/"finance-approved" while the business owner is unassigned/));
    expect(check(table(row({ Status: "operationally proven" })))).toContainEqual(expect.stringMatching(/"operationally proven" while the business owner is unassigned/));
    expect(check(table(row({ "Finance sign-off": "Signed 2026-09-25" })))).toContainEqual(expect.stringMatching(/finance sign-off "Signed 2026-09-25" while the business owner is unassigned/));
    expect(check(table(row({ "Business owner": "", "Finance sign-off": "Approved" })))).toContainEqual(expect.stringMatching(/business owner is unassigned \(empty\)/));
    // a named person may carry the decision
    expect(check(table(row({ "Business owner": "A. Person (Financial Controller)", Status: "finance-approved", "Finance sign-off": "A. Person 2026-09-25" })))).toEqual([]);
  });

  it("rejects a duplicated requirement ID", () => {
    expect(check(table(row(), row()))).toEqual([expect.stringMatching(/duplicate Requirement ID \(first on line 5\)/)]);
  });

  it("rejects a status that is not allowed", () => {
    for (const s of ["done", "Verified", "designed", ""])
      expect(check(table(row({ Status: s })))).toContainEqual(expect.stringMatching(/is not one of/));
    expect(STATUSES).toEqual(["proposed", "finance-approved", "implemented", "verified", "operationally proven", "blocked", "failed"]);
  });

  it("rejects a missing column or a row with the wrong number of cells", () => {
    expect(check(table(row()).replace("| Gate |", "| Stage |"))).toContainEqual(expect.stringMatching(/missing column\(s\): Gate/));
    expect(check(table(row() + " extra |"))).toContainEqual(expect.stringMatching(/12 cells, the header has 11/));
  });
});

describe("title resolution", () => {
  it("finds literal titles through .skipIf(...) and marks .skip; template titles are dynamic", () => {
    const t = findTitles(TEST_SRC);
    expect(t.map((x) => [x.kind, x.title, x.skipped, x.dynamic])).toEqual([
      ["describe", "ledger", false, false], ["it", "posts once", false, false], ["it", "posts over nats", false, false],
      ["it", "posts later", true, false], ["it", "${name}: rebuilds", false, true], ["it", 'quotes "inside" titles', false, false],
    ]);
  });

  it("reads several IDs from one cell, titles containing ';' included", () => {
    expect(parseTestIds("`tests/a.test.ts::one; two`<br>`tests/b.test.ts::three`").refs)
      .toEqual([{ file: "tests/a.test.ts", title: "one; two" }, { file: "tests/b.test.ts", title: "three" }]);
  });
});
