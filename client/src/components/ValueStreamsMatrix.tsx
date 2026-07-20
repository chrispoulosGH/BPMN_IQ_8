import { useEffect, useMemo, useState } from 'react';
import { Alert, Card, Empty, Spin, Typography } from 'antd';
import { getComponentHierarchies, getDashboardValueStreamRelationships, type ValueStreamRelationshipData } from '../api';
import type { HierarchyPath } from '../types';

const { Text } = Typography;

export interface ValueStreamCapabilitySelection {
  capabilityName: string;
  valueStreamName: string;
  relationshipCount: number;
  neighborhoodName: string;
  domain: string;
  subdomain: string;
}

export interface ValueStreamRollupSelection {
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  relationshipCount: number;
  valueStreamCount: number;
}

export interface ValueStreamFlowSelection {
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  valueStreamName: string;
  relationshipCount: number;
}

interface ValueStreamsMatrixProps {
  neighborhoodName: string;
  onCapabilitySelect?: (selection: ValueStreamCapabilitySelection) => void;
  onRollupSelect?: (selection: ValueStreamRollupSelection) => void;
  onValueStreamSelect?: (selection: ValueStreamFlowSelection) => void;
  selectedCapabilityName?: string | null;
  selectedValueStreamName?: string | null;
  selectedRollupKey?: string | null;
  selectedValueStreamKey?: string | null;
}

export default function ValueStreamsMatrix({
  neighborhoodName,
  onCapabilitySelect,
  onRollupSelect,
  onValueStreamSelect,
  selectedCapabilityName = null,
  selectedValueStreamName = null,
  selectedRollupKey = null,
  selectedValueStreamKey = null,
}: ValueStreamsMatrixProps) {
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

  const capabilitiesByValueStream = useMemo(() => {
    const map = new Map<string, Array<{ name: string; count: number }>>();
    for (const valueStream of valueStreams) {
      const supporting = capabilities
        .map((capability) => ({
          name: capability.name,
          count: links.find((link) => link.capability === capability.name && link.valueStreamKey === valueStream.key)?.count || 0,
        }))
        .filter((capability) => capability.count > 0)
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
      map.set(valueStream.key, supporting);
    }
    return map;
  }, [capabilities, links, valueStreams]);

  const groupedValueStreams = useMemo(() => {
    const groups = new Map<string, {
      key: string;
      domain: string;
      subdomain: string;
      totalCount: number;
      valueStreams: typeof valueStreams;
    }>();

    for (const valueStream of valueStreams) {
      const labels = labelMap.get(valueStream.name);
      const rollupParts = valueStream.rollupLabel.split(' | ');
      const domain = valueStream.domain || labels?.domain || rollupParts[0] || 'Unspecified Domain';
      const subdomain = valueStream.subdomain || labels?.subdomain || rollupParts[1] || 'Unspecified Subdomain';
      const groupKey = `${domain}|||${subdomain}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          key: groupKey,
          domain,
          subdomain,
          totalCount: 0,
          valueStreams: [],
        });
      }

      const group = groups.get(groupKey)!;
      group.totalCount += valueStream.count;
      group.valueStreams.push(valueStream);
    }

    return Array.from(groups.values());
  }, [labelMap, valueStreams]);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}>
      <Card size="small" title={`Value Streams for ${neighborhoodName}`} style={{ minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
          {groupedValueStreams.map((group) => (
            (() => {
              const isRollupSelected = selectedRollupKey === group.key;

              return (
            <div
              key={group.key}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'stretch',
                border: '1px solid #d7e3f3',
                borderRadius: 20,
                padding: 16,
                background: 'linear-gradient(180deg, #f8fbff 0%, #eef4fb 48%, #f9fbfe 100%)',
                boxShadow: '0 4px 12px rgba(71, 85, 105, 0.08)',
              }}
            >
              <div style={{ flex: '0 0 220px', paddingTop: 16 }}>
                <div
                  role="button"
                  tabIndex={0}
                  style={{
                    height: '100%',
                    minHeight: '100%',
                    borderRadius: 18,
                    padding: '14px 14px 12px',
                    background: isRollupSelected ? 'linear-gradient(180deg, #dfeafb 0%, #cfddf1 100%)' : 'linear-gradient(180deg, #edf4ff 0%, #dfeafb 100%)',
                    border: isRollupSelected ? '2px solid #5b7ea6' : '1px solid #c6d5ea',
                    boxShadow: isRollupSelected ? '0 0 0 3px rgba(147, 171, 201, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.45)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.45)',
                    display: 'flex',
                    flexDirection: 'column',
                    cursor: onRollupSelect ? 'pointer' : 'default',
                    transform: isRollupSelected ? 'translateY(-1px)' : 'none',
                  }}
                  onClick={() => onRollupSelect?.({
                    neighborhoodName,
                    domain: group.domain,
                    subdomain: group.subdomain,
                    relationshipCount: group.totalCount,
                    valueStreamCount: group.valueStreams.length,
                  })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onRollupSelect?.({
                        neighborhoodName,
                        domain: group.domain,
                        subdomain: group.subdomain,
                        relationshipCount: group.totalCount,
                        valueStreamCount: group.valueStreams.length,
                      });
                    }
                  }}
                >
                  <div style={{ color: '#64748b', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
                    Domain
                  </div>
                  <div style={{ fontWeight: 900, color: '#1d4ed8', fontSize: 16, marginBottom: 10 }}>
                    {group.domain}
                  </div>
                  <div style={{ color: '#64748b', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
                    Subdomain
                  </div>
                  <div style={{ fontWeight: 800, color: '#2563eb', fontSize: 14, marginBottom: 10 }}>
                    {group.subdomain}
                  </div>
                  <div style={{ color: '#64748b', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 4 }}>
                    Summary
                  </div>
                  <div style={{ color: '#1d4ed8', fontSize: 12, fontWeight: 700, marginBottom: 2 }}>
                    {group.valueStreams.length} value stream{group.valueStreams.length === 1 ? '' : 's'}
                  </div>
                  <div style={{ color: '#475569', fontSize: 12, marginTop: 'auto' }}>{group.totalCount} diagram{group.totalCount === 1 ? '' : 's'}</div>
                </div>
              </div>

              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {group.valueStreams.map((valueStream) => (
                  <div key={valueStream.key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ color: '#64748b', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                      Value Stream Flow
                    </div>
                    <div
                      role="button"
                      tabIndex={0}
                      style={{
                        position: 'relative',
                        height: 56,
                        borderRadius: 999,
                        background: selectedValueStreamKey === valueStream.key ? 'linear-gradient(90deg, #dfeafb 0%, #cfddf1 55%, #dce9f9 100%)' : 'linear-gradient(90deg, #e8f0fb 0%, #dce8f7 55%, #edf3fb 100%)',
                        border: selectedValueStreamKey === valueStream.key ? '2px solid #5b7ea6' : '2px solid #93abc9',
                        overflow: 'hidden',
                        boxShadow: selectedValueStreamKey === valueStream.key ? '0 0 0 3px rgba(147, 171, 201, 0.24), 0 4px 10px rgba(71, 85, 105, 0.10)' : '0 4px 10px rgba(71, 85, 105, 0.10)',
                        cursor: onValueStreamSelect ? 'pointer' : 'default',
                        transform: selectedValueStreamKey === valueStream.key ? 'translateY(-1px)' : 'none',
                      }}
                      onClick={() => onValueStreamSelect?.({
                        neighborhoodName,
                        domain: group.domain,
                        subdomain: group.subdomain,
                        valueStreamName: valueStream.name,
                        relationshipCount: valueStream.count,
                      })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onValueStreamSelect?.({
                            neighborhoodName,
                            domain: group.domain,
                            subdomain: group.subdomain,
                            valueStreamName: valueStream.name,
                            relationshipCount: valueStream.count,
                          });
                        }
                      }}
                    >
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', color: '#0f172a', fontWeight: 900 }}>
                        <span style={{ maxWidth: 'calc(100% - 50px)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#1d4ed8' }}>
                          {valueStream.name}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <span style={{ color: '#475569', fontSize: 12, fontWeight: 700 }}>
                            {valueStream.count} diagram{valueStream.count === 1 ? '' : 's'}
                          </span>
                          <span style={{ fontSize: 22, lineHeight: 1 }}>→</span>
                        </span>
                      </div>
                    </div>

                    <div style={{ color: '#64748b', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                      Business Capabilities
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
                      {(capabilitiesByValueStream.get(valueStream.key) || []).map((capability) => {
                        const isSelected = selectedCapabilityName === capability.name && selectedValueStreamName === valueStream.name;
                        return (
                        <div
                          key={`${valueStream.key}__${capability.name}`}
                          role="button"
                          tabIndex={0}
                          style={{
                            width: 150,
                            minHeight: 120,
                            borderRadius: 16,
                            border: isSelected ? '2px solid #5b7ea6' : '1px solid #c8d6e5',
                            background: isSelected ? 'linear-gradient(180deg, #dfeafb 0%, #cfddf1 100%)' : 'linear-gradient(180deg, #f4f7fb 0%, #e6edf6 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            textAlign: 'center',
                            padding: '12px 14px',
                            color: '#0f172a',
                            fontWeight: 800,
                            boxShadow: isSelected ? '0 0 0 3px rgba(147, 171, 201, 0.24), 0 6px 14px rgba(71, 85, 105, 0.14)' : '0 3px 8px rgba(71, 85, 105, 0.08)',
                            cursor: onCapabilitySelect ? 'pointer' : 'default',
                            transform: isSelected ? 'translateY(-1px)' : 'none',
                          }}
                          title={`${capability.name} supports ${valueStream.name}: ${capability.count}`}
                          onClick={() => onCapabilitySelect?.({
                            capabilityName: capability.name,
                            valueStreamName: valueStream.name,
                            relationshipCount: capability.count,
                            neighborhoodName,
                            domain: group.domain,
                            subdomain: group.subdomain,
                          })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onCapabilitySelect?.({
                                capabilityName: capability.name,
                                valueStreamName: valueStream.name,
                                relationshipCount: capability.count,
                                neighborhoodName,
                                domain: group.domain,
                                subdomain: group.subdomain,
                              });
                            }
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                            <Text style={{ fontSize: 12, color: isSelected ? '#2f4a67' : '#3f556f', fontWeight: 700, lineHeight: 1.25 }}>
                              {capability.name}
                            </Text>
                            <div style={{ fontSize: 18, fontWeight: 900 }}>{capability.count}</div>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                </div>
              </div>
              );
            })()
          ))}
        </div>
      </Card>
    </div>
  );
}