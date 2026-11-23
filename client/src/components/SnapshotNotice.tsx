import { Alert, Tooltip } from 'antd';
import type { TelemetrySnapshotInfo } from '../types';

const ago = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/**
 * Shown when a telemetry view was served from its last saved snapshot because
 * Prometheus / Tempo couldn't be reached (server/services/telemetrySnapshots.js).
 */
export default function SnapshotNotice({ snapshot, className = 'mb-3' }: { snapshot?: TelemetrySnapshotInfo | null; className?: string }) {
  if (!snapshot) return null;
  const when = new Date(snapshot.capturedAt);
  const what = snapshot.source === 'tempo' ? 'trace data (Tempo)' : 'metrics (Prometheus)';
  return (
    <Alert
      type="info"
      showIcon
      className={className}
      message={
        <span>
          Saved snapshot from{' '}
          <Tooltip title={snapshot.reason}>
            <strong>{when.toLocaleString()}</strong>
          </Tooltip>{' '}
          ({ago(snapshot.capturedAt)})
        </span>
      }
      description={`Live ${what} isn't reachable, so this view shows its last captured state and isn't updating. It goes live again on its own once the mock production stack is running.`}
    />
  );
}
