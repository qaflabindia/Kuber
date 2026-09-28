/**
 * Standing business rules stated in chat (context integrity: "never captured").
 *
 * When a person tells the copilot a rule that should hold from now on ("always book Swiggy to staff
 * welfare", "from now on payments above 50,000 need my approval"), the copilot must not keep it as
 * conversation: the server keeps no conversation, and a rule remembered only in a chat transcript
 * would govern nothing and be audited by no one. It becomes a governed proposal instead:
 *
 *   propose_rule           a classification rule (pattern → account) for the agent's classifier.
 *                          Committing applies it through the agent module's rules (rules.manage).
 *   propose_policy_change  a POL-900 policy change note. The policy registry is files, so the plan
 *                          carries the draft note; committing records PolicyChangeNoteRecorded
 *                          (authority.manage) and the policy file changes only through POL-900.
 *
 * Both are write operations gated "human": a person always approves, never an agent.
 */
import { z } from "zod";
import { principalRole, sha256 } from "@kuber/contracts";
import type { Check, OpDef, Section } from "@kuber/ops";

const AccountId = z.string().min(1).transform((s) => s.trim().toUpperCase());

const RuleInput = z.object({
  pattern: z.string().trim().min(2).max(100).describe("text in a narration or counterparty name that identifies the transactions, e.g. Swiggy"),
  account: AccountId.describe("the account they always go to, e.g. STAFFWELF"),
  statedAs: z.string().max(500).optional().describe("the person's words, verbatim"),
});

export const proposeRule: OpDef<z.infer<typeof RuleInput>> = {
  name: "propose_rule", title: "Propose a classification rule", kind: "write", gate: "human",
  description: "Turn a standing instruction such as \"always book Swiggy to staff welfare\" into a classification rule proposal (pattern → account). Nothing changes until a person with rules.manage approves it; the copilot never remembers such rules as conversation.",
  input: RuleInput,
  async plan(ctx, i) {
    const s = ctx.state, acc = s.accounts.get(i.account);
    const checks: Check[] = [
      { label: `Account ${i.account} exists`, ok: !!acc, blocking: true, detail: acc ? acc.name : `No account ${i.account} in this book` },
      { label: "Not a money or suspense account", ok: !!acc && !acc.isCashLike && i.account !== "SUSPENSE", blocking: true },
      { label: "Not a closed account", ok: !s.closed.has(i.account), blocking: true },
      { label: "Pattern specific enough (at least 3 letters)", ok: (i.pattern.match(/[a-z]/gi) ?? []).length >= 3, blocking: true },
    ];
    const name = acc?.name ?? i.account;
    const sections: Section[] = [{ title: "Proposed rule", kind: "kv", rows: [["When a narration or counterparty mentions", i.pattern], ["Classify as", `${i.account} (${name})`],
      ["Applies to", "transactions classified after approval; nothing already posted changes"], ["Approved by", "a person with rules.manage"],
      ...(i.statedAs ? [["Stated as", i.statedAs] as [string, string]] : [])] }];
    return {
      title: `Rule proposal: "${i.pattern}" → ${name}`,
      summary: `Proposal: classify future transactions mentioning "${i.pattern}" as ${name} (${i.account}). It is waiting for a person to approve it; nothing changes until then.`,
      actions: [{ type: "ext", module: "agent", kind: "rule", payload: { pattern: i.pattern, accountId: i.account } }],
      checks, sections, data: { standingRule: { kind: "classification", pattern: i.pattern, accountId: i.account } },
      notes: ["Stated in chat and captured as a governed proposal (context integrity): the copilot does not remember rules as conversation."],
    };
  },
};

const PolicyInput = z.object({
  statement: z.string().trim().min(3).max(1000).describe("the rule as the person stated it"),
  event: z.string().regex(/^EVT-[A-Z0-9-]+$/).optional().describe("the policy event it governs, when known (e.g. EVT-TXN-INGESTED)"),
  title: z.string().trim().min(3).max(120).optional(),
});

/** A POL-900 draft note (the policy template's shape, status draft, id to be assigned by the policy owner). */
export function policyNote(i: { statement: string; event?: string; title?: string }, by: string, today: string): string {
  const title = i.title ?? (i.statement.length > 60 ? `${i.statement.slice(0, 57)}...` : i.statement);
  return [
    "---", "policy_id: POL-nnn (to be assigned)", `title: ${title}`, `event: ${i.event ?? "to be named by the policy owner"}`, "class: control", "subtype: governance",
    "autonomy: to be decided (stricter autonomy wins where policies overlap)", "approver: Admin", "owner: Owner", "status: draft", "version: 1",
    `effective_from: after approval`, "---", "", `# POL-nnn — ${title}`, "", "## Intent", "", i.statement, "", "## Trigger", "", i.event ? `${i.event}.` : "To be named by the policy owner.",
    "", "## Notes for the agent", "", "- Proposal only (POL-900): it drives nothing until an admin approves a new policy version.", "", "## Change log", "",
    `- draft · ${today} · Stated in chat by ${by}; captured by the copilot as a POL-900 proposal.`,
  ].join("\n");
}

export const proposePolicyChange: OpDef<z.infer<typeof PolicyInput>> = {
  name: "propose_policy_change", title: "Propose a policy change (POL-900 note)", kind: "write", gate: "human",
  description: "Turn a standing business rule stated in chat (\"from now on payments above 50,000 need my approval\") into a POL-900 policy change note. The note is a proposal: the policy files change only through POL-900, and nothing the agent does changes until a new policy version is approved.",
  input: PolicyInput,
  async plan(ctx, i) {
    const by = ctx.onBehalfOf ?? ctx.principal;
    const note = policyNote(i, by, ctx.today);
    const noteId = `pcn-${sha256(`${ctx.tenant}/${ctx.book}/${i.statement}`).slice(0, 20)}`;
    const checks: Check[] = [
      { label: "Proposal names the change and the reason (POL-900)", ok: i.statement.length >= 10, blocking: true },
      { label: "Proposal names the event it governs (POL-900)", ok: !!i.event, blocking: false, detail: i.event ? i.event : "the policy owner names the event when drafting" },
      { label: "The agent drafts proposals but never approves them (POL-900)", ok: principalRole(ctx.principal) !== "agent" || !!ctx.onBehalfOf, blocking: true },
    ];
    return {
      title: `Policy change proposal: ${i.title ?? (i.statement.length > 50 ? `${i.statement.slice(0, 47)}...` : i.statement)}`,
      summary: `Proposal under POL-900: "${i.statement}". It is waiting for approval; until a new policy version is approved, the current policies still decide.`,
      actions: [{ type: "ext", module: "agent", kind: "policy_note", payload: { noteId, statement: i.statement, event: i.event ?? null, note, requestedBy: ctx.onBehalfOf ?? null } }],
      checks,
      sections: [{ title: "Draft policy change note (POL-900)", kind: "kv", rows: [["Note", noteId], ["Statement", i.statement], ["Event", i.event ?? "to be named"],
        ["Status", "draft: awaiting POL-900 review"], ["Approver", "Admin (POL-900); recorded by a person with authority.manage"]] }],
      data: { standingRule: { kind: "policy", noteId, statement: i.statement, event: i.event ?? null }, note },
      notes: [note, "Stated in chat and captured as a governed proposal (context integrity): the copilot does not remember rules as conversation."],
    };
  },
};

export const STANDING_RULE_OPERATIONS: OpDef<any>[] = [proposeRule, proposePolicyChange];
