import { GitHubIntegration } from "./GitHubIntegration.js";
import { JiraIntegration } from "./JiraIntegration.js";
import { NotionIntegration } from "./NotionIntegration.js";
import { SlackIntegration } from "./SlackIntegration.js";
import { ExternalIntegration, IntegrationStatus } from "./types.js";

export class IntegrationManager {
  private readonly integrations = new Map<string, ExternalIntegration>();

  constructor(env: Record<string, string | undefined> = process.env) {
    this.register(new GitHubIntegration(env.GITHUB_TOKEN));
    this.register(new NotionIntegration(env.NOTION_TOKEN));
    this.register(new SlackIntegration(env.SLACK_BOT_TOKEN));
    this.register(new JiraIntegration(env.JIRA_TOKEN));
  }

  register(integration: ExternalIntegration): void {
    this.integrations.set(integration.name, integration);
  }

  status(): IntegrationStatus[] {
    return [...this.integrations.values()].map((integration) => integration.status());
  }

  get(name: string): ExternalIntegration | undefined {
    return this.integrations.get(name);
  }
}
