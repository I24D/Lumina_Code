import { ExternalIntegration, IntegrationStatus } from "./types.js";

export class SlackIntegration implements ExternalIntegration {
  readonly name = "slack";

  constructor(private readonly token?: string) {}

  status(): IntegrationStatus {
    return {
      name: this.name,
      configured: Boolean(this.token),
      enabled: Boolean(this.token),
      message: this.token ? "Slack token configured." : "Set SLACK_BOT_TOKEN to enable Slack actions.",
    };
  }
}
