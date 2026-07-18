import { useEffect, useMemo, useState } from 'react';
import { Alert, Card, Empty, Spin, Typography } from 'antd';
import { getComponentHierarchies, getDashboardValueStreamRelationships, type ValueStreamRelationshipData } from '../api';
import type { HierarchyPath } from '../types';

const { Text } = Typography;

interface ValueStreamsMatrixProps {
  neighborhoodName: string;
}

export default function ValueStreamsMatrix({ neighborhoodName }: ValueStreamsMatrixProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ValueStreamRelationshipData | null>(null);
  const [hierarchyPaths, setHierarchyPaths] = useState<HierarchyPath[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setHierarchyPaths([]);

    Promise.all([
      getDashboardValueStreamRelationships(neighborhoodName),
      getComponentHierarchies(neighborhoodName, 'Value Stream', neighborhoodName),
    ])
      .then(([result, hierarchies]) => {
        if (!cancelled) {
          setData(result);
          setHierarchyPaths(hierarchies.paths || []);
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Failed to load value streams');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [neighborhoodName]);

  const valueStreams = data?.valueStreams || [];
  const capabilities = data?.capabilities || [];
  const links = data?.links || [];

  const cellMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const link of links) {
      map.set(`${link.capability}|||${link.valueStream}`, link.count);
    }
    return map;
  }, [links]);

  const labelMap = useMemo(() => {
    const map = new Map<string, { domain: string; subdomain: string }>();
    const normalize = (value: unknown) => String(value || '').trim().toLowerCase();

    for (const path of hierarchyPaths) {
      const valueStreamNode = path.nodes?.find((node) => normalize(node.componentName) === 'value stream');
      if (!valueStreamNode?.rowName) continue;

      const domainNode = path.nodes?.find((node) => normalize(node.componentName) === 'domain');
      const subdomainNode = path.nodes?.find((node) => normalize(node.componentName) === 'subdomain');

      map.set(valueStreamNode.rowName, {
        domain: domainNode?.rowName || '',
        subdomain: subdomainNode?.rowName || '',
      });
    }
    return map;
  }, [hierarchyPaths]);

  const sortedCapabilities = useMemo(() => {
    return [...capabilities].sort((left, right) => left.name.localeCompare(right.name));
  }, [capabilities]);

  if (loading) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>;
  }

  if (error) {
    return <Alert type="error" message={error} showIcon />;
  }

  if (!valueStreams.length) {
    return <Empty description={`No value streams found for ${neighborhoodName}`} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <Card size="small" title={`Value Streams for ${neighborhoodName}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {valueStreams.map((valueStream) => (
            <div key={valueStream.name} style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
              <div style={{ flex: '0 0 220px', paddingTop: 16 }}>
                <div style={{ fontWeight: 900, color: '#0f172a', fontSize: 16, marginBottom: 6 }}>
                  {labelMap.get(valueStream.name)?.domain || valueStream.rollupLabel.split(' | ')[0] || 'Unspecified Domain'}
                </div>
                <div style={{ fontWeight: 800, color: '#334155', fontSize: 14, marginBottom: 4 }}>
                  {labelMap.get(valueStream.name)?.subdomain || valueStream.rollupLabel.split(' | ')[1] || 'Unspecified Subdomain'}
                </div>
                <div style={{ color: '#64748b', fontSize: 12 }}>{valueStream.name}</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>{valueStream.count} diagram{valueStream.count === 1 ? '' : 's'}</div>
              </div>

              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ position: 'relative', height: 56, borderRadius: 999, background: 'linear-gradient(90deg, #dbeafe 0%, #bfdbfe 100%)', border: '4px solid #3b82f6', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', color: '#0f172a', fontWeight: 900 }}>
                    <span style={{ maxWidth: 'calc(100% - 50px)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {(labelMap.get(valueStream.name)?.domain || valueStream.rollupLabel.split(' | ')[0] || 'Unspecified Domain') + ' / ' + (labelMap.get(valueStream.name)?.subdomain || valueStream.rollupLabel.split(' | ')[1] || 'Unspecified Subdomain')}
                    </span>
                    <span style={{ fontSize: 22, lineHeight: 1 }}>→</span>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, sortedCapabilities.length)}, minmax(120px, 1fr))`, gap: 8 }}>
                  {sortedCapabilities.map((capability) => {
                    const count = cellMap.get(`${capability.name}|||${valueStream.name}`) || 0;
                    const active = count > 0;
                    return (
                      <div
                        key={`${valueStream.name}__${capability.name}`}
                        style={{
                          minHeight: 72,
                          borderRadius: 14,
                          border: `2px solid ${active ? '#0f766e' : '#dbe4ee'}`,
                          background: active ? 'linear-gradient(180deg, rgba(15, 118, 110, 0.18) 0%, rgba(15, 118, 110, 0.08) 100%)' : '#f8fafc',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          textAlign: 'center',
                          padding: '8px 10px',
                          color: active ? '#0f172a' : '#94a3b8',
                          fontWeight: active ? 800 : 600,
                          boxShadow: active ? '0 2px 8px rgba(15, 118, 110, 0.12)' : 'none',
                        }}
                        title={`${capability.name} intersects ${valueStream.name}: ${count}`}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                          <Text style={{ fontSize: 12, color: active ? '#0f172a' : '#64748b', fontWeight: 700, lineHeight: 1.2 }}>
                            {capability.name}
                          </Text>
                          <div style={{ fontSize: 16, fontWeight: 900 }}>{active ? count : '—'}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}