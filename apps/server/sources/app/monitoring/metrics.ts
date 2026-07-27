import { timingSafeEqual } from 'node:crypto';
import fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@/storage/db';
import { register } from '@/app/monitoring/metrics2';
import { log } from '@/utils/logging/log';
import { createHealthyMonitoringResponse, sendDatabaseReadinessResponse } from './readiness';

type MetricsSurface = 'health' | 'ready' | 'metrics';

export interface MetricsServerConfig {
    enabled: boolean;
    host: string;
    port: number;
    bearerToken: string | null;
    publicSurfaces: Readonly<Record<MetricsSurface, boolean>>;
}

function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return value.trim().toLowerCase() === 'true';
}

export function resolveMetricsServerConfig(
    env: Readonly<Record<string, string | undefined>> = process.env,
): MetricsServerConfig {
    const enabled = env.METRICS_ENABLED !== 'false';
    const host = env.METRICS_HOST?.trim() || '127.0.0.1';
    const parsedPort = env.METRICS_PORT ? Number.parseInt(env.METRICS_PORT, 10) : 9090;
    if (!Number.isSafeInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65_535) {
        throw new Error('METRICS_PORT must be an integer between 1 and 65535');
    }

    const loopback = isLoopbackHost(host);
    const lanEnabled = parseBoolean(env.METRICS_LAN_ENABLED, false);
    if (!loopback && !lanEnabled) {
        throw new Error('Non-loopback metrics require METRICS_LAN_ENABLED=true');
    }

    const bearerToken = env.METRICS_BEARER_TOKEN?.trim() || null;
    const publicSurfaces = {
        health: parseBoolean(env.METRICS_HEALTH_PUBLIC, loopback),
        ready: parseBoolean(env.METRICS_READY_PUBLIC, loopback),
        metrics: parseBoolean(env.METRICS_SCRAPE_PUBLIC, loopback),
    } satisfies Record<MetricsSurface, boolean>;

    /*
     * Happier metrics can contain operational and usage metadata. A LAN bind is
     * never an authentication boundary, so every surface remains private when
     * exposed beyond loopback. Loopback surfaces retain independently
     * configurable public policies for local probes and scrapers.
     */
    if (!loopback && Object.values(publicSurfaces).some(Boolean)) {
        throw new Error('Non-loopback metrics surfaces cannot be public');
    }
    if (Object.values(publicSurfaces).some((isPublic) => !isPublic) && !bearerToken) {
        throw new Error('Private metrics surfaces require METRICS_BEARER_TOKEN');
    }

    return {
        enabled,
        host,
        port: parsedPort,
        bearerToken,
        publicSurfaces,
    };
}

function safeTokenMatch(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
        && timingSafeEqual(actualBuffer, expectedBuffer);
}

function authorizeMetricsSurface(
    surface: MetricsSurface,
    config: MetricsServerConfig,
    request: FastifyRequest,
    reply: FastifyReply,
): void | FastifyReply {
    if (config.publicSurfaces[surface]) return;
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : '';
    if (config.bearerToken && safeTokenMatch(supplied, config.bearerToken)) return;
    return reply
        .header('WWW-Authenticate', 'Bearer')
        .code(401)
        .send({ error: 'Unauthorized' });
}

export async function createMetricsServer(
    config: MetricsServerConfig = resolveMetricsServerConfig(),
) {
    const app = fastify({
        logger: false // Disable logging for metrics server
    });

    app.get('/metrics', {
        preHandler: async (request, reply) => authorizeMetricsSurface('metrics', config, request, reply),
    }, async (_request, reply) => {
        try {
            // Get Prisma metrics in Prometheus format
            const prismaMetrics = await db.$metrics.prometheus();
            
            // Get custom application metrics
            const appMetrics = await register.metrics();
            
            // Combine both metrics
            const combinedMetrics = prismaMetrics + '\n' + appMetrics;
            
            reply.type('text/plain; version=0.0.4; charset=utf-8');
            reply.send(combinedMetrics);
        } catch (error) {
            log({ module: 'metrics', level: 'error' }, `Error generating metrics: ${error}`);
            reply.code(500).send('Internal Server Error');
        }
    });

    app.get('/health', {
        preHandler: async (request, reply) => authorizeMetricsSurface('health', config, request, reply),
    }, async (_request, reply) => {
        reply.send(createHealthyMonitoringResponse());
    });

    app.get('/ready', {
        preHandler: async (request, reply) => authorizeMetricsSurface('ready', config, request, reply),
    }, async (_request, reply) => {
        await sendDatabaseReadinessResponse(reply);
    });

    return app;
}

export async function startMetricsServer(): Promise<void> {
    const config = resolveMetricsServerConfig();
    if (!config.enabled) {
        log({ module: 'metrics' }, 'Metrics server disabled');
        return;
    }

    const app = await createMetricsServer(config);
    
    try {
        await app.listen({ port: config.port, host: config.host });
        log({ module: 'metrics' }, `Metrics server listening on ${config.host}:${config.port}`);
    } catch (error) {
        log({ module: 'metrics', level: 'error' }, `Failed to start metrics server: ${error}`);
        throw error;
    }
}
