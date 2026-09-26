/**
 * Agent-governance permissions checked by action name (TAGOF TOL/PRM/AGT; implementation design 6.3,
 * System Owner role). The role model is being extended with a System Owner role and these actions:
 *
 *   agent.system       own the copilot's tool register, approve prompt / DSPy artifact / routing-policy
 *                      versions, halt or resume the copilot (AGT-09)
 *   agent.turns.read   read the agent's turn records (TOL-05, AGT-07) and monitoring signals
 *
 * Until those actions exist in ACTIONS, each falls back to the nearest existing actions, in order
 * (the first one the member holds wins). Once ACTIONS lists the name, only the name is checked, so
 * merging the roles change switches every caller over without touching them.
 */
import { ACTIONS, type Action } from "./roles.ts";

export const AGENT_GOVERNANCE_ACTIONS = ["agent.system", "agent.turns.read"] as const;
export type AgentGovernanceAction = (typeof AGENT_GOVERNANCE_ACTIONS)[number];

/** Existing actions that stand in for each governance action until the role model defines it. */
export const AGENT_ACTION_FALLBACKS: Record<AgentGovernanceAction, Action[]> = {
  "agent.system": ["autonomy.manage"],
  // access.review: owners and controllers; members.read: also auditors ("audit" access).
  "agent.turns.read": ["access.review", "members.read"],
};

/** The actions to try for `name`: the name itself when the role model defines it, else its fallbacks. */
export function actionsFor(name: AgentGovernanceAction | Action): Action[] {
  if ((ACTIONS as readonly string[]).includes(name)) return [name as Action];
  return AGENT_ACTION_FALLBACKS[name as AgentGovernanceAction] ?? [];
}

/**
 * Authorize by action name: `authorize` is the identity check for one concrete action (it throws
 * AccessDenied). Tries each action from actionsFor(name); rethrows the last denial.
 */
export async function authorizeNamed<M>(name: AgentGovernanceAction | Action, authorize: (a: Action) => Promise<M>): Promise<M> {
  const list = actionsFor(name);
  if (!list.length) throw new Error(`no action defined for ${name}`);
  let last: unknown;
  for (const a of list) {
    try { return await authorize(a); } catch (e) { last = e; }
  }
  throw last;
}
