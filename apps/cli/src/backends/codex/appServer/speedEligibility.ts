const LEGACY_FAST_MODEL_IDS = new Set([
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.6',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
]);

export function isCodexAppServerFastModelEligible(modelId: string | null | undefined): boolean {
    return typeof modelId === 'string' && LEGACY_FAST_MODEL_IDS.has(modelId.trim().toLowerCase());
}

function readServiceTierId(value: unknown): string | null {
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized || null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return readServiceTierId(record.id)
        ?? readServiceTierId(record.value)
        ?? readServiceTierId(record.serviceTier)
        ?? readServiceTierId(record.service_tier);
}

function advertisesFastServiceTier(value: unknown): boolean {
    return Array.isArray(value) && value.some((entry) => {
        if (readServiceTierId(entry) === 'fast') return true;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;

        // Current Codex app-server builds advertise the user-facing Fast tier as
        // `{ id: "priority", name: "Fast" }`.  The stable tier id is provider-owned,
        // so use the advertised display name instead of assuming the id is `fast`.
        const record = entry as Record<string, unknown>;
        return readServiceTierId(record.name) === 'fast'
            || readServiceTierId(record.label) === 'fast';
    });
}

export function isCodexAppServerSpeedEligible(params: Readonly<{
    authMethod?: string | null;
    currentModelId: string | null;
    serviceTiers?: unknown;
    additionalSpeedTiers?: unknown;
}>): boolean {
    if (params.authMethod !== 'oauth_cli' && params.authMethod !== 'credentials_file') return false;

    if (params.serviceTiers !== undefined) {
        return advertisesFastServiceTier(params.serviceTiers);
    }
    if (params.additionalSpeedTiers !== undefined) {
        return advertisesFastServiceTier(params.additionalSpeedTiers);
    }
    return isCodexAppServerFastModelEligible(params.currentModelId);
}
