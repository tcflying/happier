import {
    detectSessionTurnActivity,
    detectSessionTurnActivityFromProjection,
    type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

type DetectLatestSessionTurnActivityParams = Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    afterSeqExclusive?: number;
    transcriptFetchTimeoutMs?: number;
}>;

export interface LatestSessionTurnActivitySnapshot {
    readonly activity: SessionTurnActivity;
    readonly sessionProjection: unknown;
}

export async function detectLatestSessionTurnActivitySnapshot(
    params: DetectLatestSessionTurnActivityParams,
): Promise<LatestSessionTurnActivitySnapshot> {
    let projectedActivity: SessionTurnActivity | null = null;
    let sessionProjection: unknown = null;
    try {
        const refreshedSession = await fetchSessionById({
            token: params.token,
            sessionId: params.sessionId,
        });
        sessionProjection = refreshedSession;
        projectedActivity = detectSessionTurnActivityFromProjection(refreshedSession);
        if (projectedActivity?.turnInFlight) {
            return { activity: projectedActivity, sessionProjection };
        }
    } catch {
        // Fall back to legacy transcript activity detection below.
    }

    const transcriptActivity = await detectSessionTurnActivity({
        token: params.token,
        sessionId: params.sessionId,
        encryptionMode: params.encryptionMode,
        encryptionKey: params.encryptionKey,
        encryptionVariant: params.encryptionVariant,
        ...(typeof params.afterSeqExclusive === 'number' ? { afterSeqExclusive: params.afterSeqExclusive } : {}),
        ...(typeof params.transcriptFetchTimeoutMs === 'number'
            ? { transcriptFetchTimeoutMs: params.transcriptFetchTimeoutMs }
            : {}),
    });

    if (transcriptActivity.turnInFlight) {
        return { activity: transcriptActivity, sessionProjection };
    }

    return {
        activity: projectedActivity ?? transcriptActivity,
        sessionProjection,
    };
}

export async function detectLatestSessionTurnActivity(
    params: DetectLatestSessionTurnActivityParams,
): Promise<SessionTurnActivity> {
    return (await detectLatestSessionTurnActivitySnapshot(params)).activity;
}
