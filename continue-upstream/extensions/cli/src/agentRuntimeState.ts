let agentId: string | undefined;

export function setAgentId(id: string | undefined) {
  agentId = id;
}

export function getAgentId(): string | undefined {
  return agentId;
}
