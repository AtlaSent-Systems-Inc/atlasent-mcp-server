import { createServer } from "../server";

// Helper to call a tool on the server via the internal registered tools map
async function callTool(
  server: ReturnType<typeof createServer>,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Access registered tools via the internal _registeredTools object
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registeredTools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  >;
  const tool = registeredTools[toolName];
  if (!tool) {
    throw new Error(`Tool '${toolName}' not registered`);
  }
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
  }>;
}

describe("createServer", () => {
  describe("evaluate tool", () => {
    it("returns deny when fetch fails (fail-closed)", async () => {
      // Override global fetch to simulate a network error
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      try {
        const server = createServer();
        const result = await callTool(server, "evaluate", {
          action_type: "deploy",
          actor_id: "user-1",
          environment: "production",
        });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.decision).toBe("deny");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("returns deny when API returns non-OK status (fail-closed)", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      try {
        const server = createServer();
        const result = await callTool(server, "evaluate", {
          action_type: "deploy",
          actor_id: "user-1",
          environment: "production",
        });

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.decision).toBe("deny");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("returns decision and permit_token on success", async () => {
      const originalFetch = global.fetch;
      const mockResponse = { decision: "allow", permit_token: "tok-abc123" };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse),
      });

      try {
        const server = createServer();
        const result = await callTool(server, "evaluate", {
          action_type: "deploy",
          actor_id: "user-1",
          environment: "production",
          approvals: ["manager-1"],
          change_window: "cw-2024-01",
        });

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.decision).toBe("allow");
        expect(parsed.permit_token).toBe("tok-abc123");

        // Verify the correct endpoint and body were used
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/v1-evaluate"),
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining('"action_type":"deploy"'),
          })
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("includes approvals and change_window in request body when provided", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ decision: "allow" }),
      });

      try {
        const server = createServer();
        await callTool(server, "evaluate", {
          action_type: "restart",
          actor_id: "user-2",
          environment: "staging",
          approvals: ["lead-1", "lead-2"],
          change_window: "cw-weekend",
        });

        const callArgs = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(callArgs[1].body as string);
        expect(body.approvals).toEqual(["lead-1", "lead-2"]);
        expect(body.change_window).toBe("cw-weekend");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("omits optional fields from request body when not provided", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ decision: "allow" }),
      });

      try {
        const server = createServer();
        await callTool(server, "evaluate", {
          action_type: "read",
          actor_id: "user-3",
          environment: "dev",
        });

        const callArgs = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(callArgs[1].body as string);
        expect(body).not.toHaveProperty("approvals");
        expect(body).not.toHaveProperty("change_window");
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe("verify_permit tool", () => {
    it("returns deny/invalid when fetch fails (fail-closed)", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      try {
        const server = createServer();
        const result = await callTool(server, "verify_permit", {
          permit_token: "tok-abc123",
          action_type: "deploy",
          actor_id: "user-1",
          environment: "production",
        });

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.outcome).toBe("deny");
        expect(parsed.valid).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("returns deny/invalid when API returns non-OK status (fail-closed)", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      try {
        const server = createServer();
        const result = await callTool(server, "verify_permit", {
          permit_token: "tok-abc123",
          action_type: "deploy",
          actor_id: "user-1",
          environment: "production",
        });

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.outcome).toBe("deny");
        expect(parsed.valid).toBe(false);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("returns outcome and valid on success", async () => {
      const originalFetch = global.fetch;
      const mockResponse = { outcome: "allowed", valid: true };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse),
      });

      try {
        const server = createServer();
        const result = await callTool(server, "verify_permit", {
          permit_token: "tok-abc123",
          action_type: "deploy",
          actor_id: "user-1",
          environment: "production",
        });

        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.outcome).toBe("allowed");
        expect(parsed.valid).toBe(true);

        // Verify the correct endpoint was used
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("/v1-verify-permit"),
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining('"permit_token":"tok-abc123"'),
          })
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("uses env vars for API key and base URL", async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ outcome: "allowed", valid: true }),
      });

      const originalApiKey = process.env.ATLASENT_API_KEY;
      const originalAnonKey = process.env.ATLASENT_ANON_KEY;
      const originalBaseUrl = process.env.ATLASENT_BASE_URL;

      try {
        process.env.ATLASENT_API_KEY = "test-api-key";
        process.env.ATLASENT_ANON_KEY = "test-anon-key";
        process.env.ATLASENT_BASE_URL = "https://custom.example.com";

        const server = createServer();
        await callTool(server, "verify_permit", {
          permit_token: "tok-test",
          action_type: "test",
          actor_id: "user-test",
          environment: "test",
        });

        const callArgs = (global.fetch as jest.Mock).mock.calls[0];
        expect(callArgs[0]).toBe(
          "https://custom.example.com/v1-verify-permit"
        );
        expect(callArgs[1].headers).toMatchObject({
          Authorization: "Bearer test-api-key",
          apikey: "test-anon-key",
        });
      } finally {
        global.fetch = originalFetch;
        if (originalApiKey === undefined) {
          delete process.env.ATLASENT_API_KEY;
        } else {
          process.env.ATLASENT_API_KEY = originalApiKey;
        }
        if (originalAnonKey === undefined) {
          delete process.env.ATLASENT_ANON_KEY;
        } else {
          process.env.ATLASENT_ANON_KEY = originalAnonKey;
        }
        if (originalBaseUrl === undefined) {
          delete process.env.ATLASENT_BASE_URL;
        } else {
          process.env.ATLASENT_BASE_URL = originalBaseUrl;
        }
      }
    });
  });
});
