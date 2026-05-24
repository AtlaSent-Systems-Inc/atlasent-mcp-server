/**
 * Compliance MCP tools — SCIM provisioning, SIEM delivery, and evidence exports.
 *
 *   SCIM ×6:     atlasent_list_scim_users, atlasent_get_scim_user,
 *                atlasent_create_scim_user, atlasent_patch_scim_user,
 *                atlasent_delete_scim_user, atlasent_list_scim_groups
 *
 *   SIEM ×3:     atlasent_get_siem_config, atlasent_upsert_siem_config,
 *                atlasent_test_siem_delivery
 *
 *   Evidence ×3: atlasent_list_evidence_exports, atlasent_get_evidence_export,
 *                atlasent_create_evidence_export
 *
 * Mutating tools (create/patch/delete SCIM users, upsert SIEM config, create
 * evidence export) are skipped when ATLASENT_MCP_READONLY=1.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "./decision.js";
import {
  listScimUsers,
  getScimUser,
  createScimUser,
  patchScimUser,
  deleteScimUser,
  listScimGroups,
  getSiemConfig,
  upsertSiemConfig,
  testSiemDelivery,
  listEvidenceExports,
  getEvidenceExport,
  createEvidenceExport,
} from "./engine.js";

const MAX_FIELD_LEN = 256;

function toolError(e: unknown) {
  return toolResult({
    error: e instanceof Error ? e.message : String(e),
  });
}

function logAudit(toolName: string): void {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "mcp.request",
      transport: "mcp-tool",
      tool_name: toolName,
    }) + "\n",
  );
}

function isReadOnly(): boolean {
  return (
    process.env.ATLASENT_MCP_READONLY === "1" ||
    process.env.ATLASENT_MCP_READONLY === "true"
  );
}

export function registerComplianceTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // SCIM: atlasent_list_scim_users
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_scim_users",
    {
      title: "AtlaSent — List SCIM Users",
      description:
        "List provisioned users via SCIM 2.0 (RFC 7643) for an organization. " +
        "Supports filter expressions (e.g. 'userName eq \"alice\"') and " +
        "startIndex/count pagination.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        filter: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("SCIM filter expression (e.g. 'userName eq \"alice\"')."),
        startIndex: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based result offset for pagination (default 1)."),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max results per page (default 20, max 200)."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_list_scim_users");
      try {
        return toolResult(
          (await listScimUsers(
            args.org_id,
            args.filter,
            args.startIndex,
            args.count,
          )) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // SCIM: atlasent_get_scim_user
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_get_scim_user",
    {
      title: "AtlaSent — Get SCIM User",
      description: "Retrieve a single provisioned SCIM user by ID.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        user_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("SCIM user ID returned by list_scim_users or create_scim_user."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_get_scim_user");
      try {
        return toolResult(
          (await getScimUser(args.org_id, args.user_id)) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // SCIM: atlasent_create_scim_user (mutating)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_create_scim_user",
      {
        title: "AtlaSent — Create SCIM User",
        description:
          "Provision a new user via SCIM 2.0. Adds the user to the AtlaSent " +
          "directory and makes them available for policy evaluation.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID."),
          userName: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("SCIM userName — typically the user's email address."),
          displayName: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("Human-readable display name."),
          emails: z
            .array(
              z.object({
                value: z.string().max(MAX_FIELD_LEN),
                primary: z.boolean().optional(),
              }),
            )
            .optional()
            .describe("Email addresses."),
          active: z
            .boolean()
            .optional()
            .describe("Whether the account is active (default true)."),
          externalId: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("External IdP identifier for correlation."),
          groups: z
            .array(z.string().max(MAX_FIELD_LEN))
            .optional()
            .describe("Group IDs to assign the user to."),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logAudit("atlasent_create_scim_user");
        try {
          const { org_id, ...attrs } = args;
          return toolResult(
            (await createScimUser(org_id, attrs as Record<string, unknown>)) as Record<
              string,
              unknown
            >,
          );
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // SCIM: atlasent_patch_scim_user (mutating)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_patch_scim_user",
      {
        title: "AtlaSent — Patch SCIM User",
        description:
          "Update a provisioned user using RFC 7644 SCIM PatchOp operations. " +
          "Each operation has op (add/remove/replace), an optional path, and a value.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID."),
          user_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("SCIM user ID to update."),
          operations: z
            .array(
              z.object({
                op: z.enum(["add", "remove", "replace"]),
                path: z.string().max(MAX_FIELD_LEN).optional(),
                value: z.unknown().optional(),
              }),
            )
            .min(1)
            .describe(
              "PatchOp operations per RFC 7644 §3.5.2 (e.g. { op: 'replace', path: 'active', value: false }).",
            ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logAudit("atlasent_patch_scim_user");
        try {
          return toolResult(
            (await patchScimUser(
              args.org_id,
              args.user_id,
              args.operations,
            )) as Record<string, unknown>,
          );
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // SCIM: atlasent_delete_scim_user (mutating)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_delete_scim_user",
      {
        title: "AtlaSent — Delete SCIM User",
        description:
          "Deprovision a SCIM user. Removes them from the AtlaSent directory. " +
          "This is irreversible — prefer disabling (patch active=false) over deleting.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID."),
          user_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("SCIM user ID to deprovision."),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        logAudit("atlasent_delete_scim_user");
        try {
          return toolResult(
            (await deleteScimUser(args.org_id, args.user_id)) as Record<string, unknown>,
          );
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // SCIM: atlasent_list_scim_groups
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_scim_groups",
    {
      title: "AtlaSent — List SCIM Groups",
      description: "List provisioned groups via SCIM 2.0 for an organization.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        filter: z
          .string()
          .max(MAX_FIELD_LEN)
          .optional()
          .describe("SCIM filter expression (e.g. 'displayName eq \"engineers\"')."),
        startIndex: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based result offset."),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max results per page."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_list_scim_groups");
      try {
        return toolResult(
          (await listScimGroups(
            args.org_id,
            args.filter,
            args.startIndex,
            args.count,
          )) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // SIEM: atlasent_get_siem_config
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_get_siem_config",
    {
      title: "AtlaSent — Get SIEM Config",
      description:
        "Retrieve the SIEM export configuration for an organization. " +
        "Enterprise plan required. The credential field is never returned.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_get_siem_config");
      try {
        return toolResult(
          (await getSiemConfig(args.org_id)) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // SIEM: atlasent_upsert_siem_config (mutating)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_upsert_siem_config",
      {
        title: "AtlaSent — Upsert SIEM Config",
        description:
          "Create or update the SIEM export configuration for an organization. " +
          "Enterprise plan required. destinationUrl must be HTTPS. " +
          "The credential field is stored securely and never returned by GET.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID."),
          destinationUrl: z
            .string()
            .url()
            .describe("HTTPS URL of the SIEM endpoint to deliver events to."),
          format: z
            .enum(["splunk_hec", "elastic_ecs", "qradar_cef", "json"])
            .describe(
              "Payload format: splunk_hec (HEC wrapper), elastic_ecs (ECS envelope), " +
              "qradar_cef (CEF text), json (raw JSON).",
            ),
          enabled: z
            .boolean()
            .optional()
            .describe("Whether delivery is active (default true)."),
          authType: z
            .enum(["bearer", "basic", "api_key", "none"])
            .optional()
            .describe(
              "Auth method: bearer (Authorization: Bearer), basic (Authorization: Basic), " +
              "api_key (X-API-Key), none. Default: bearer.",
            ),
          credential: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe(
              "Auth credential. Stored securely; omit to keep the existing credential.",
            ),
          includedEventTypes: z
            .array(z.string())
            .optional()
            .describe(
              "Event types to include (default: permit, deny, override, governance).",
            ),
          batchSize: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe("Events per batch (default 100)."),
          retryCount: z
            .number()
            .int()
            .min(0)
            .max(10)
            .optional()
            .describe("Retry attempts on delivery failure (default 3)."),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (args) => {
        logAudit("atlasent_upsert_siem_config");
        try {
          const { org_id, ...config } = args;
          return toolResult(
            (await upsertSiemConfig(org_id, config as Record<string, unknown>)) as Record<
              string,
              unknown
            >,
          );
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // SIEM: atlasent_test_siem_delivery
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_test_siem_delivery",
    {
      title: "AtlaSent — Test SIEM Delivery",
      description:
        "Send a test event to the configured SIEM destination and report the result. " +
        "Returns { success, statusCode, durationMs, error? }. " +
        "Returns 409 if SIEM is not configured or is disabled.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      logAudit("atlasent_test_siem_delivery");
      try {
        return toolResult(
          (await testSiemDelivery(args.org_id)) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Evidence: atlasent_list_evidence_exports
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_list_evidence_exports",
    {
      title: "AtlaSent — List Evidence Exports",
      description:
        "List compliance evidence bundles for an organization. " +
        "Enterprise plan required. Each record includes status and SHA-256 hash.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        regime: z
          .enum(["soc2_type_ii", "hipaa", "gdpr"])
          .optional()
          .describe("Filter by compliance regime."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_list_evidence_exports");
      try {
        return toolResult(
          (await listEvidenceExports(args.org_id, args.regime)) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Evidence: atlasent_get_evidence_export
  // -------------------------------------------------------------------------
  server.registerTool(
    "atlasent_get_evidence_export",
    {
      title: "AtlaSent — Get Evidence Export",
      description:
        "Retrieve a specific compliance evidence bundle by ID. " +
        "Includes status, SHA-256 hash for tamper verification, and download URL when complete.",
      inputSchema: z.object({
        org_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Organization ID."),
        export_id: z
          .string()
          .min(1)
          .max(MAX_FIELD_LEN)
          .describe("Evidence export ID from list_evidence_exports or create_evidence_export."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      logAudit("atlasent_get_evidence_export");
      try {
        return toolResult(
          (await getEvidenceExport(args.org_id, args.export_id)) as Record<string, unknown>,
        );
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Evidence: atlasent_create_evidence_export (mutating)
  // -------------------------------------------------------------------------
  if (!isReadOnly()) {
    server.registerTool(
      "atlasent_create_evidence_export",
      {
        title: "AtlaSent — Create Evidence Export",
        description:
          "Generate a compliance evidence bundle for audit regimes (SOC 2 Type II, " +
          "HIPAA, GDPR). Enterprise plan required. Returns SHA-256 for tamper verification. " +
          "Default window is the past 90 days; use date_from/date_to to narrow it.",
        inputSchema: z.object({
          org_id: z
            .string()
            .min(1)
            .max(MAX_FIELD_LEN)
            .describe("Organization ID."),
          regime: z
            .enum(["soc2_type_ii", "hipaa", "gdpr"])
            .describe(
              "Compliance regime: soc2_type_ii (SOC 2 Type II), hipaa (HIPAA), gdpr (GDPR).",
            ),
          date_from: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("ISO-8601 or YYYY-MM-DD start of the evidence window."),
          date_to: z
            .string()
            .max(MAX_FIELD_LEN)
            .optional()
            .describe("ISO-8601 or YYYY-MM-DD end of the evidence window."),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logAudit("atlasent_create_evidence_export");
        try {
          const { org_id, ...payload } = args;
          return toolResult(
            (await createEvidenceExport(org_id, payload)) as Record<string, unknown>,
          );
        } catch (e) {
          return toolError(e);
        }
      },
    );
  }
}
