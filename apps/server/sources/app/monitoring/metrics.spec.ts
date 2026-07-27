import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrismaMetrics = vi.fn();
const mockQueryRaw = vi.fn();
const mockRegisterMetrics = vi.fn();
const mockDbReadinessChecksInc = vi.fn();
const mockDbReadinessDurationObserve = vi.fn();
const mockLog = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        $metrics: { prometheus: mockPrismaMetrics },
        $queryRaw: mockQueryRaw,
    },
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    register: { metrics: mockRegisterMetrics },
    dbReadinessChecksCounter: { inc: mockDbReadinessChecksInc },
    dbReadinessDurationHistogram: { observe: mockDbReadinessDurationObserve },
}));

vi.mock("@/utils/logging/log", () => ({
    log: mockLog,
}));

describe("metrics server", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrismaMetrics.mockResolvedValue("# prisma");
        mockRegisterMetrics.mockResolvedValue("# happier");
    });

    it("binds loopback by default and keeps each local surface independently public", async () => {
        const { resolveMetricsServerConfig } = await import("./metrics");

        expect(resolveMetricsServerConfig({})).toEqual({
            enabled: true,
            host: "127.0.0.1",
            port: 9090,
            bearerToken: null,
            publicSurfaces: {
                health: true,
                ready: true,
                metrics: true,
            },
        });
    });

    it("requires explicit LAN opt-in, bearer auth, and private endpoint policies", async () => {
        const { resolveMetricsServerConfig } = await import("./metrics");

        expect(() => resolveMetricsServerConfig({
            METRICS_HOST: "0.0.0.0",
        })).toThrow("METRICS_LAN_ENABLED=true");
        expect(() => resolveMetricsServerConfig({
            METRICS_HOST: "0.0.0.0",
            METRICS_LAN_ENABLED: "true",
        })).toThrow("METRICS_BEARER_TOKEN");
        expect(() => resolveMetricsServerConfig({
            METRICS_HOST: "0.0.0.0",
            METRICS_LAN_ENABLED: "true",
            METRICS_BEARER_TOKEN: "secret",
            METRICS_HEALTH_PUBLIC: "true",
        })).toThrow("cannot be public");

        expect(resolveMetricsServerConfig({
            METRICS_HOST: "0.0.0.0",
            METRICS_LAN_ENABLED: "true",
            METRICS_BEARER_TOKEN: "secret",
        })).toMatchObject({
            host: "0.0.0.0",
            bearerToken: "secret",
            publicSurfaces: {
                health: false,
                ready: false,
                metrics: false,
            },
        });
    });

    it("returns 401 for unauthenticated LAN probes and accepts the configured bearer", async () => {
        const { createMetricsServer, resolveMetricsServerConfig } = await import("./metrics");
        const config = resolveMetricsServerConfig({
            METRICS_HOST: "0.0.0.0",
            METRICS_LAN_ENABLED: "true",
            METRICS_BEARER_TOKEN: "metrics-test-token",
        });
        const app = await createMetricsServer(config);

        try {
            await app.ready();
            const unauthorized = await app.inject({ method: "GET", url: "/metrics" });
            const authorized = await app.inject({
                method: "GET",
                url: "/metrics",
                headers: { authorization: "Bearer metrics-test-token" },
            });

            expect(unauthorized.statusCode).toBe(401);
            expect(unauthorized.headers["www-authenticate"]).toBe("Bearer");
            expect(authorized.statusCode).toBe(200);
            expect(authorized.body).toContain("# prisma");
            expect(authorized.body).toContain("# happier");
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("can protect readiness without changing the local health policy", async () => {
        const { createMetricsServer, resolveMetricsServerConfig } = await import("./metrics");
        mockQueryRaw.mockResolvedValue([{ one: 1 }]);
        const config = resolveMetricsServerConfig({
            METRICS_BEARER_TOKEN: "local-probe-token",
            METRICS_HEALTH_PUBLIC: "true",
            METRICS_READY_PUBLIC: "false",
            METRICS_SCRAPE_PUBLIC: "true",
        });
        const app = await createMetricsServer(config);

        try {
            await app.ready();
            expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(401);
            expect((await app.inject({
                method: "GET",
                url: "/ready",
                headers: { authorization: "Bearer local-probe-token" },
            })).statusCode).toBe(200);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it("exposes database readiness on /ready for worker probes", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { createMetricsServer } = await import("./metrics");
        const app = await createMetricsServer();

        try {
            await app.ready();

            const res = await app.inject({ method: "GET", url: "/ready" });

            expect(res.statusCode).toBe(200);
            expect(mockQueryRaw).toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: "ok", reason: "none" });
        } finally {
            await app.close().catch(() => {});
        }
    });
});
