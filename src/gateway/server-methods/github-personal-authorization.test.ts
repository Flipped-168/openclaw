import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareGitHubPublicationOptionsRead } from "./github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  readSession:
    vi.fn<
      Awaited<
        ReturnType<
          typeof import("../github-publication-availability.js").prepareGitHubPublicationSession
        >
      >["current"]
    >(),
  roleScopes: undefined as string[] | undefined,
}));

vi.mock("../github-publication-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-publication-availability.js")>()),
  prepareGitHubPublicationSession: async () => ({
    initial: mocks.readSession(),
    current: mocks.readSession,
    release() {},
    [Symbol.dispose]() {},
  }),
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
// mock-isolation: Options disclosure uses synthetic profile authority without opening the host profile store.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRolePolicyAuthority: async (profileId: string) => ({
    profileId,
    isCurrent: () => true,
  }),
}));
// mock-isolation: Authorization policy fixtures do not open or hydrate the profile database.
vi.mock("../../state/user-profile-list.js", () => ({
  captureResidentUserProfileAccess: (profileId: string) => ({
    assertCurrent: () => ({ id: profileId, role: null }),
  }),
}));
vi.mock("../operator-role-policy.js", () => ({
  resolveOperatorRolePolicy: () => (mocks.roleScopes ? { scopes: mocks.roleScopes } : null),
  resolveOperatorRolePolicyForProfile: () =>
    mocks.roleScopes ? { scopes: mocks.roleScopes } : null,
  resolveOperatorRolePolicyForAssignment: () =>
    mocks.roleScopes ? { scopes: mocks.roleScopes } : null,
}));
vi.mock("../session-sharing.js", () => ({
  createSessionListEntryFilter: () => undefined,
  resolveSessionMutationAuthorization: () => ({}),
}));

function createRequest() {
  const client: GatewayClient = {
    connId: "github-cache-client",
    authenticatedUserProfile: {
      profileId: "profile-cache-test",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  const context = {
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(!filter || filter(client) ? ["github-cache-client"] : []),
  } as Partial<GatewayRequestContext> as GatewayRequestContext;
  return {
    client,
    context,
    req: { type: "req" as const, id: "github-read", method: "sessions.github.options" },
  };
}

function sessionRead(agentId = "main") {
  return {
    cfg: {},
    canonicalKey: `agent:${agentId}:main`,
    agentId,
    storePath: "/test/sessions.json",
    store: {},
    storeKeys: [`agent:${agentId}:main`],
    entry: { sessionId: "session-cache-test", updatedAt: 1 },
    legacyKey: undefined,
  };
}

describe("GitHub publication request discovery", () => {
  beforeEach(() => {
    mocks.roleScopes = undefined;
    mocks.readSession.mockReset();
    mocks.readSession.mockReturnValue(sessionRead());
  });

  it.each([
    ["operator.read", "operator.sessions.write"],
    ["operator.sessions.write", "operator.read"],
  ])("retains shared session-read permission for %s capped by %s", async (grant, ceiling) => {
    const request = createRequest();
    request.client.connect.scopes = [grant];
    mocks.roleScopes = [ceiling];

    using read = await prepareGitHubPublicationOptionsRead(request, { sessionKey: "main" });
    expect(read.currentSession()).toEqual(read.session);
    expect(read.personal.kind).toBe("ineligible");

    mocks.roleScopes = ["operator.approvals"];
    expect(() => read.currentSession()).toThrow(
      "GitHub requires current operator.sessions.read permission.",
    );
  });

  it.each([null, 123])(
    "keeps each response archive snapshot immutable from %s",
    async (archivedAt) => {
      const loaded = sessionRead();
      mocks.readSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: archivedAt ?? undefined },
      });
      using read = await prepareGitHubPublicationOptionsRead(createRequest(), {
        sessionKey: "main",
      });
      const initial = read.currentSession();
      const changedAt = archivedAt === null ? 123 : null;
      mocks.readSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: changedAt ?? undefined },
      });
      const changed = read.currentSession();
      expect(changed.archivedAt).toBe(changedAt);
      expect(() => read.assertSessionUnchanged(changed)).not.toThrow();
      expect(() => read.assertSessionUnchanged(initial)).toThrow("session access changed");

      mocks.readSession.mockReturnValue({
        ...loaded,
        entry: { ...loaded.entry, archivedAt: archivedAt ?? undefined },
      });
      const restored = read.currentSession();
      expect(restored.archivedAt).toBe(archivedAt);
      expect(() => read.assertSessionUnchanged(changed)).toThrow("session access changed");
      expect(() => read.assertSessionUnchanged(restored)).not.toThrow();
    },
  );
});
