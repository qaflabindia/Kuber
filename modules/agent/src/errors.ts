export class AgentError extends Error { constructor(public code: string, msg: string) { super(msg); } }
