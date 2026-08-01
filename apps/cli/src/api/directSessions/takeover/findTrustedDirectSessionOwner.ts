import type { DirectSessionsProviderId } from '@happier-dev/protocol';

import type { DaemonSessionMarker } from '@/daemon/sessionRegistry';

function extractVendorSessionIdFromMarkerMetadata(params: Readonly<{
  providerId: DirectSessionsProviderId;
  metadata: unknown;
}>): string | null {
  if (!params.metadata || typeof params.metadata !== 'object' || Array.isArray(params.metadata)) return null;
  const rec = params.metadata as Record<string, unknown>;
  const expectedFlavor = typeof rec.flavor === 'string' ? rec.flavor.trim() : '';
  if (expectedFlavor && expectedFlavor !== params.providerId) return null;

      const raw = (() => {
        switch (params.providerId) {
          case 'codex':
            return rec.codexSessionId;
          case 'claude':
            return rec.claudeSessionId;
          case 'opencode':
            return rec.opencodeSessionId;
          default:
            return null;
        }
      })();

  const normalized = typeof raw === 'string' ? raw.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function markerMatchesProvider(params: Readonly<{
  marker: DaemonSessionMarker;
  providerId: DirectSessionsProviderId;
}>): boolean {
  const topLevelFlavor = typeof params.marker.flavor === 'string' ? params.marker.flavor.trim() : '';
  if (topLevelFlavor) return topLevelFlavor === params.providerId;

  const metadata = params.marker.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const metadataFlavor = (metadata as Record<string, unknown>).flavor;
  return typeof metadataFlavor === 'string' && metadataFlavor.trim() === params.providerId;
}

export function findTrustedDirectSessionOwner(params: Readonly<{
  markers: readonly DaemonSessionMarker[];
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  isPidAlive?: (pid: number) => boolean;
}>): DaemonSessionMarker | null {
  const isPidAlive = params.isPidAlive ?? (() => true);
  const remoteSessionId = String(params.remoteSessionId ?? '').trim();
  if (!remoteSessionId) return null;

  const candidates = params.markers
    .filter((marker) => Number.isFinite(marker.pid) && marker.pid > 0 && isPidAlive(marker.pid))
    // Real daemon marker files created by older/current session runners keep
    // the provider under metadata.flavor and may omit the optional top-level
    // flavor field. Accept both shapes, while still rejecting cross-provider
    // markers before comparing provider session ids.
    .filter((marker) => markerMatchesProvider({ marker, providerId: params.providerId }))
    .filter(
      (marker) =>
        extractVendorSessionIdFromMarkerMetadata({
          providerId: params.providerId,
          metadata: marker.metadata,
        }) === remoteSessionId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || b.pid - a.pid);

  return candidates[0] ?? null;
}
