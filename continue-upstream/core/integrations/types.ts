export type IntegrationStatus = {
  name: string;
  configured: boolean;
  enabled: boolean;
  message?: string;
};

export interface ExternalIntegration {
  readonly name: string;
  status(): IntegrationStatus;
}
