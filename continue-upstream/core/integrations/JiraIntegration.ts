import { ExternalIntegration, IntegrationStatus } from "./types.js";

export class JiraIntegration implements ExternalIntegration {
  readonly name = "jira";

  constructor(private readonly token?: string) {}

  status(): IntegrationStatus {
    return {
      name: this.name,
      configured: Boolean(this.token),
      enabled: Boolean(this.token),
      message: this.token ? "Jira token configured." : "Set JIRA_TOKEN to enable Jira actions.",
    };
  }
}
