import {
  loadAgentHarnessMcpConfig,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MuseMcpServer } from "./runtime.js";

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("Muse MCP environment and headers must contain resolved strings.");
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

export async function loadMuseMcpServers(params: AgentHarnessAttemptParamsV2) {
  const servers: Record<string, MuseMcpServer> = {};
  if (!params.config?.mcp?.servers) {
    return servers;
  }
  const loaded = await loadAgentHarnessMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolOverrides: params.toolOverrides,
  });
  params.hostCapabilities.assertActive();
  if (loaded.requesterScopedServerNames.length) {
    throw new Error(
      "Muse does not support requester-scoped MCP credentials. Use the openclaw runtime.",
    );
  }
  if (Object.keys(loaded.prepareDataDirsByServer).length) {
    throw new Error("Muse cannot prepare bundled MCP data directories. Use the openclaw runtime.");
  }
  for (const [name, server] of Object.entries(loaded.config.mcpServers)) {
    if (!isRecord(server)) {
      throw new Error(`Invalid Muse MCP server ${name}`);
    }
    if (typeof server.command === "string") {
      if (server.cwd) {
        throw new Error(`Muse cannot preserve an MCP-specific working directory (${name}).`);
      }
      const args = server.args;
      if (
        args !== undefined &&
        (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
      ) {
        throw new Error(`Invalid Muse MCP arguments (${name}).`);
      }
      servers[name] = {
        transport: "stdio",
        command: server.command,
        ...(args ? { args: args.map(String) } : {}),
        env: stringMap(server.env),
      };
    } else if (
      typeof server.url === "string" &&
      server.transport !== "sse" &&
      server.type !== "sse"
    ) {
      servers[name] = {
        transport: "streamableHttp",
        url: server.url,
        headers: stringMap(server.headers),
      };
    } else {
      throw new Error(`Muse supports only stdio and streamable HTTP MCP servers (${name}).`);
    }
  }
  return servers;
}
