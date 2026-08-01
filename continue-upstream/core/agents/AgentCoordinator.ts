import { AgentRegistry } from "./AgentRegistry.js";
import { codeAgent } from "./CodeAgent.js";
import { deploymentAgent } from "./DeploymentAgent.js";
import { docsAgent } from "./DocsAgent.js";
import { testingAgent } from "./TestingAgent.js";
import { AgentAssignment, AgentTask } from "./types.js";

export class AgentCoordinator {
  readonly registry = new AgentRegistry();

  constructor() {
    this.registry.register(codeAgent);
    this.registry.register(docsAgent);
    this.registry.register(testingAgent);
    this.registry.register(deploymentAgent);
  }

  assign(task: AgentTask): AgentAssignment {
    const assignment = this.registry.assign(task);
    if (!assignment) {
      throw new Error(`No Lumina subagent can handle capability: ${task.capability}`);
    }

    return assignment;
  }
}
