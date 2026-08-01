import { ExternalIntegration, IntegrationStatus } from "./types.js";

export class GitHubIntegration implements ExternalIntegration {
  readonly name = "github";

  constructor(private readonly token?: string) {}

  status(): IntegrationStatus {
    return {
      name: this.name,
      configured: Boolean(this.token),
      enabled: Boolean(this.token),
      message: this.token ? "GitHub token configured." : "Set GITHUB_TOKEN to enable GitHub actions.",
    };
  }
}
