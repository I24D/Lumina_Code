import { ExternalIntegration, IntegrationStatus } from "./types.js";

export class NotionIntegration implements ExternalIntegration {
  readonly name = "notion";

  constructor(private readonly token?: string) {}

  status(): IntegrationStatus {
    return {
      name: this.name,
      configured: Boolean(this.token),
      enabled: Boolean(this.token),
      message: this.token ? "Notion token configured." : "Set NOTION_TOKEN to enable Notion actions.",
    };
  }
}
