import { afterEach, describe, expect, it, vi } from 'vitest';

import * as catalog from '@/agents/catalog/catalog';
import { buildResumeSessionBaseOptionsFromSession } from './resumeSessionBase';

let storageState: any = {
    sessions: {},
    machines: {},
    getProjectForSession: () => null,
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => storageState,
    },
});
});

afterEach(() => {
    vi.restoreAllMocks();
    storageState = {
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
    };
});

function setCanonicalSessionTarget(machineId: string, path: string): void {
    storageState = {
        sessions: {
            s1: {
                active: false,
                updatedAt: 10,
                metadata: { machineId, path, homeDir: '/Users/test', host: 'host.local' },
            },
        },
        machines: {
            [machineId]: {
                id: machineId,
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local' },
            },
        },
        getProjectForSession: (sessionId: string) =>
            sessionId === 's1'
                ? {
                    key: {
                        machineId,
                        path,
                    },
                }
                : null,
    };
}

describe('buildResumeSessionBaseOptionsFromSession', () => {
    it('returns null when session metadata is missing', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: null } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });

    it('returns null when vendor resume is not allowed', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } }, // codex not enabled
        })).toBeNull();
    });

    it('returns base options when vendor resume is allowed and present', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
        });
    });

    it('builds fresh-spawn continuation options for a session whose provider never started (no vendor resume id, QA A-F5)', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        const base = buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { seq: 0, metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' } } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        });
        expect(base).toMatchObject({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent' },
        });
        expect(base).not.toHaveProperty('resume');
    });

    it('fails closed for historical Codex, Claude, and OpenCode threads when the native resume id is missing', () => {
        setCanonicalSessionTarget('m1', '/tmp');

        for (const fixture of [
            {
                flavor: 'openai',
                resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' as const } },
            },
            {
                flavor: 'claude',
                resumeCapabilityOptions: { accountSettings: {} },
            },
            {
                flavor: 'opencode',
                resumeCapabilityOptions: { accountSettings: {} },
            },
        ]) {
            expect(buildResumeSessionBaseOptionsFromSession({
                sessionId: 's1',
                session: {
                    seq: 12,
                    metadata: {
                        machineId: 'm1',
                        path: '/tmp',
                        flavor: fixture.flavor,
                    },
                } as any,
                resumeCapabilityOptions: fixture.resumeCapabilityOptions,
            })).toBeNull();
        }
    });

    it('does not use raw metadata as a live resume target when canonical reachability is unavailable', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toBeNull();
    });

    it('prefers a resolved resume target override over stale session metadata', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
            resumeTargetOverride: {
                machineId: 'm-target',
                directory: '/tmp/target',
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
        });
    });

    it('uses the canonical reachable target when no explicit override is provided', () => {
        storageState = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 10,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/tmp/stale',
                        homeDir: '/Users/test',
                        host: 'stale.local',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 5,
                    metadata: { host: 'stale.local' },
                    replacedByMachineId: 'm-target',
                    replacedAt: 15,
                },
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'target.local' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-target',
                            path: '/tmp/target',
                        },
                    }
                    : null,
        };

        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
        });
    });

    it('prefers persisted codex backend mode over account settings when resuming codex sessions', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'openai',
                    codexSessionId: 'x1',
                    codexBackendMode: 'appServer',
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
        });
    });

    it('carries agentRuntimeDescriptorV1 through resume base options when present', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'openai',
                    codexSessionId: 'x1',
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            vendorSessionId: 'x1',
                        },
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'x1',
                },
            },
        });
    });

    it('passes through permission mode overrides', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' } } as any,
            resumeCapabilityOptions: { accountSettings: {} },
            permissionOverride: { permissionMode: 'plan', permissionModeUpdatedAt: 123 },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
            permissionMode: 'plan',
            permissionModeUpdatedAt: 123,
        });
    });

    it('carries persisted connected-service bindings and freshness into resume options', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        const connectedServices = {
            v: 1 as const,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected' as const,
                    selection: 'group' as const,
                    groupId: 'claude-group',
                    profileId: 'profile-2',
                },
            },
        };

        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'claude',
                    claudeSessionId: 'c1',
                    connectedServices,
                    connectedServicesUpdatedAt: 2468,
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
            connectedServices,
            connectedServicesUpdatedAt: 2468,
        });
    });

    it('resolves configured ACP sessions to configured backend targets', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: 'custom-backend',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
        });
    });

    it('infers configured ACP backend id from the flavor when metadata backend id is missing', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        });
    });

    it('infers configured ACP backend id from the flavor when metadata backend id is blank', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: '   ',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        });
    });

    it('resumes configured ACP sessions even when built-in agent resolution is unavailable', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        const actualResolveAgentIdFromFlavor = catalog.resolveAgentIdFromFlavor;
        vi.spyOn(catalog, 'resolveAgentIdFromFlavor').mockImplementation(flavor =>
            flavor === 'acp:custom-kiro' ? null : actualResolveAgentIdFromFlavor(flavor),
        );

        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: 'custom-backend',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
        });
    });

    it('fails closed for ACP flavors when the preset id cannot be derived', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:',
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });
});
