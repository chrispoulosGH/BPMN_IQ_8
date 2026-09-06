import { useEffect, useRef, useState } from 'react';
import { Spin, Empty, Tag, Descriptions } from 'antd';
import Plot from 'react-plotly.js';
import { getDashboardBusinessFlowSecurityRiskApps } from '../api';
import type { BusinessFlowSecurityRiskApp } from '../api';

interface SecurityRiskAppChartProps {
  // Which business flow's applications to plot — null shows an empty-state
  // placeholder instead (nothing selected yet in the Top 20 Security
  // Vulnerability chart this is driven from).
  flow: string | null;
}

const SEVERITY_RANK: Record<string, number> = { Low: 1, Med: 2, High: 3 };
const SEVERITY_COLOR: Record<string, string> = { Low: '#52c41a', Med: '#faad14', High: '#f5222d' };

// Same TTL-based module-level cache pattern as Dashboard.tsx/
// FeatureCost3DChart.tsx/ServerLocationMap.tsx — keyed by flow name so
// re-selecting an already-seen flow (including after this component
// remounts, e.g. leaving Analytics and coming back) renders instantly.
const SECURITY_RISK_APPS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const securityRiskAppsCache = new Map<string, { applications: BusinessFlowSecurityRiskApp[]; fetchedAt: number }>();
function freshSecurityRiskAppsCache(flow: string): BusinessFlowSecurityRiskApp[] | null {
  const cached = securityRiskAppsCache.get(flow);
  return cached && Date.now() - cached.fetchedAt < SECURITY_RISK_APPS_CACHE_TTL_MS ? cached.applications : null;
}

function renderMultilineValue(value: string): React.ReactNode {
  if (!value) return '—';
  return <span style={{ wordBreak: 'break-word' }}>{value}</span>;
}

export default function SecurityRiskAppChart({ flow }: SecurityRiskAppChartProps) {
  const [applications, setApplications] = useState<BusinessFlowSecurityRiskApp[]>(() => (flow ? freshSecurityRiskAppsCache(flow) || [] : []));
  const [loading, setLoading] = useState(() => Boolean(flow) && !freshSecurityRiskAppsCache(flow || ''));
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const lastLoadedFlowRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedAppId(null);
    if (!flow) {
      setApplications([]);
      return;
    }

    const cached = freshSecurityRiskAppsCache(flow);
    if (cached) {
      setApplications(cached);
      lastLoadedFlowRef.current = flow;
      return;
    }

    let cancelled = false;
    setLoading(true);
    getDashboardBusinessFlowSecurityRiskApps(flow)
      .then((result) => {
        if (cancelled) return;
        setApplications(result.applications);
        lastLoadedFlowRef.current = flow;
        securityRiskAppsCache.set(flow, { applications: result.applications, fetchedAt: Date.now() });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [flow]);

  if (!flow) {
    return <Empty description="Click a bar in the Top 20 Business Flows by Security Vulnerability chart to view its applications" style={{ marginTop: 48 }} />;
  }

  if (loading) {
    return <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>;
  }

  if (!applications.length) {
    return <Empty description={`No application security data found for "${flow}"`} style={{ marginTop: 48 }} />;
  }

  const selectedApp = applications.find((a) => a.appId === selectedAppId) || null;

  const customData = applications.map((app) => ({ appId: app.appId, name: app.name, probability: app.probability, severity: app.severity }));

  const trace: any = {
    type: 'scatter3d',
    mode: 'markers+text',
    x: applications.map((_, i) => i),
    y: applications.map((app) => SEVERITY_RANK[app.severity] || 1),
    z: applications.map((app) => app.probability),
    text: applications.map((app) => app.name.length > 18 ? app.name.slice(0, 16) + '…' : app.name),
    textposition: 'top center',
    textfont: { size: 9, color: '#334155' },
    customdata: customData,
    hovertemplate: applications.map((app) =>
      `<b>${app.name}</b><br>Probability: ${app.probability}%<br>Severity: ${app.severity}<br>` +
      `${app.serverCount} servers (${app.atRiskServerCount} at risk)<br>${app.softwareCount} software (${app.atRiskSoftwareCount} at risk)<extra></extra>`
    ),
    marker: {
      size: applications.map((app) => Math.max(8, Math.min(28, 8 + Math.sqrt(app.serverCount + app.softwareCount)))),
      color: applications.map((app) => (app.appId === selectedAppId ? '#1677ff' : SEVERITY_COLOR[app.severity] || '#94a3b8')),
      opacity: 0.9,
      line: { width: applications.map((app) => (app.appId === selectedAppId ? 3 : 0.5)), color: '#ffffff' },
    },
  };

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div style={{ flex: selectedApp ? '1 1 60%' : '1 1 100%', minWidth: 0, height: '100%' }}>
        <Plot
          data={[trace]}
          layout={{
            margin: { t: 10, b: 10, l: 10, r: 10 },
            scene: {
              xaxis: { title: 'Application', tickvals: applications.map((_, i) => i), ticktext: applications.map((app) => app.name.length > 14 ? app.name.slice(0, 12) + '…' : app.name), tickfont: { size: 8 } },
              yaxis: { title: 'Severity', tickvals: [1, 2, 3], ticktext: ['Low', 'Med', 'High'], range: [0.5, 3.5] },
              zaxis: { title: 'Probability %', range: [0, 100] },
              camera: { eye: { x: 1.6, y: -1.6, z: 0.9 } },
            },
          }}
          config={{ responsive: true, displaylogo: false }}
          style={{ width: '100%', height: '100%' }}
          onClick={(eventData: any) => {
            const appId = eventData?.points?.[0]?.customdata?.appId;
            if (appId) setSelectedAppId(appId);
          }}
        />
      </div>

      {selectedApp && (
        <div style={{ flex: '0 0 42%', minWidth: 200, maxWidth: 320, borderLeft: '1px solid #f0f0f0', overflowY: 'auto', padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{selectedApp.name}</div>
            <span style={{ cursor: 'pointer', color: '#999', fontSize: 14 }} onClick={() => setSelectedAppId(null)} title="Close">×</span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <Tag color={selectedApp.severity === 'High' ? 'red' : selectedApp.severity === 'Med' ? 'gold' : 'green'}>
              {selectedApp.probability}% probability &middot; {selectedApp.severity} severity
            </Tag>
          </div>
          <Descriptions column={1} size="small" bordered styles={{ label: { fontSize: 11, width: 110 }, content: { fontSize: 11 } }}>
            <Descriptions.Item label="Security Class">{renderMultilineValue(selectedApp.securityClassification)}</Descriptions.Item>
            <Descriptions.Item label="Data Class">{renderMultilineValue(selectedApp.dataClassification)}</Descriptions.Item>
            <Descriptions.Item label="Compliance">{renderMultilineValue(selectedApp.complianceRequirements)}</Descriptions.Item>
            <Descriptions.Item label="Internet Facing">{selectedApp.internetFacing || '—'}</Descriptions.Item>
            <Descriptions.Item label="Customer Facing">{selectedApp.customerFacing || '—'}</Descriptions.Item>
          </Descriptions>

          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: '#475569' }}>
            At-risk servers ({selectedApp.atRiskServerCount} of {selectedApp.serverCount})
          </div>
          {selectedApp.atRiskServers.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              {selectedApp.atRiskServers.map((server) => (
                <div key={server.name} style={{ border: '1px solid #f0f0f0', borderRadius: 4, padding: '4px 6px', fontSize: 10.5 }}>
                  <div style={{ fontWeight: 600 }}>{server.name}</div>
                  <div style={{ color: '#666' }}>
                    {server.osName}{server.osEol ? ' (EOL)' : ''} &middot; {server.criticalVulns} critical / {server.highVulns} high vulns
                  </div>
                  <div style={{ color: '#999' }}>Patching: {server.patchingStatus || '—'} &middot; Compliance: {server.complianceStatus || '—'}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>None</div>
          )}

          <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600, color: '#475569' }}>
            At-risk software ({selectedApp.atRiskSoftwareCount} of {selectedApp.softwareCount})
          </div>
          {selectedApp.atRiskSoftware.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              {selectedApp.atRiskSoftware.map((sw) => (
                <div key={sw.name} style={{ border: '1px solid #f0f0f0', borderRadius: 4, padding: '4px 6px', fontSize: 10.5 }}>
                  <div style={{ fontWeight: 600 }}>{sw.name}</div>
                  <div style={{ color: '#666' }}>{sw.knownSecurityIssues || (sw.endOfSupport ? 'Past end of support' : '—')}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>None</div>
          )}
        </div>
      )}
    </div>
  );
}
