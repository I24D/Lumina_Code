import { AgentAssignment, AgentCapability, AgentDefinition, AgentTask } from "./types.js";

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    this.agents.set(agent.name, agent);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  findByCapability(capability: AgentCapability): AgentDefinition[] {
    return this.list().filter((agent) => agent.capabilities.includes(capability));
  }

  assign(task: AgentTask): AgentAssignment | undefined {
    const agent = this.findByCapability(task.capability)[0];
    return agent
      ? {
          agent,
          reason: `${agent.name} handles ${task.capability}: ${task.goal}`,
        }
      : undefined;
  }
}
