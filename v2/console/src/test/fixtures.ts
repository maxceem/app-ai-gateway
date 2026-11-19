/** An app as the management API answers with it, for the console's tests. */
export function testApp(overrides: Record<string, unknown> = {}) {
  return {
    id: "my-app",
    revision: 2,
    name: "My app",
    status: "active",
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-02T00:00:00.000Z",
    config: {
      authentication: {
        type: "api_key",
        end_user: { source: "header", header: "x-end-user-id" },
      },
      routing: { providers: { openai: { operations: ["openai.chat"] } } },
      limits: {
        per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_nano: null } },
        per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_nano: null } },
      },
    },
    ...overrides,
  };
}
