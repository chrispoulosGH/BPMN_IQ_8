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

type ColorScheme = 'current' | 'att';

type ValueStreamsTheme = {
  sectionLabel: string;
  controlBorder: string;
  controlBackground: string;
  controlBackgroundSelected: string;
  controlText: string;
  controlTextSelected: string;
  panelBorder: string;
  panelBackground: string;
  panelShadow: string;
  domainLabel: string;
  domainValue: string;
  summaryText: string;
  countText: string;
  subdomainBorder: string;
  subdomainBackground: string;
  subdomainShadow: string;
  subdomainHeader: string;
  subdomainValue: string;
  flowBorder: string;
  flowBackground: string;
  flowBackgroundSelected: string;
  flowBorderSelected: string;
  flowName: string;
  flowCount: string;
  connectorStroke: string;
  connectorArrow: string;
  capabilityBorder: string;
  capabilityBackground: string;
  capabilityBackgroundSelected: string;
  capabilityText: string;
  capabilityTextMuted: string;
  capabilityCount: string;
};

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
  const capabilityTileWidth = 150;
  const capabilityTileGap = 10;
  const capabilityRowWidth = 520;
  const flowBarHeight = 56;
  const connectorHeight = 54;
  const [colorScheme, setColorScheme] = useState<ColorScheme>('current');

  const currentTheme: ValueStreamsTheme = {
    sectionLabel: '#64748b',
    controlBorder: '#c6d5ea',
    controlBackground: 'linear-gradient(180deg, #f4f7fb 0%, #e6edf6 100%)',
    controlBackgroundSelected: 'linear-gradient(180deg, #dfeafb 0%, #cfddf1 100%)',
    controlText: '#475569',
    controlTextSelected: '#1d4ed8',
    panelBorder: '#d7e3f3',
    panelBackground: 'linear-gradient(180deg, #161616 0%, #0f1114 48%, #1a1a1a 100%)',
    panelShadow: '0 4px 12px rgba(71, 85, 105, 0.08)',
    domainLabel: '#64748b',
    domainValue: '#1d4ed8',
    summaryText: '#475569',
    countText: '#475569',
    subdomainBorder: '#c6d5ea',
    subdomainBackground: 'rgba(255, 255, 255, 0.58)',
    subdomainShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.45)',
    subdomainHeader: '#64748b',
    subdomainValue: '#1d4ed8',
    flowBorder: '#c6d5ea',
    flowBackground: 'rgba(255, 255, 255, 0.5)',
    flowBackgroundSelected: 'linear-gradient(90deg, #dfeafb 0%, #cfddf1 55%, #dce9f9 100%)',
    flowBorderSelected: '#5b7ea6',
    flowName: '#1d4ed8',
    flowCount: '#475569',
    connectorStroke: '#7e9ab8',
    connectorArrow: '#5b7ea6',
    capabilityBorder: '#c8d6e5',
    capabilityBackground: 'linear-gradient(180deg, #f4f7fb 0%, #e6edf6 100%)',
    capabilityBackgroundSelected: 'linear-gradient(180deg, #dfeafb 0%, #cfddf1 100%)',
    capabilityText: '#0f172a',
    capabilityTextMuted: '#3f556f',
    capabilityCount: '#0f172a',
  };

  const attTheme: ValueStreamsTheme = {
    sectionLabel: '#d7f7ff',
    controlBorder: 'rgba(125, 225, 255, 0.36)',
    controlBackground: 'linear-gradient(180deg, rgba(10, 30, 50, 0.94) 0%, rgba(18, 52, 82, 0.94) 100%)',
    controlBackgroundSelected: 'linear-gradient(180deg, rgba(0, 110, 200, 0.98) 0%, rgba(66, 192, 245, 0.98) 100%)',
    controlText: '#effcff',
    controlTextSelected: '#ffffff',
    panelBorder: 'rgba(125, 225, 255, 0.34)',
    panelBackground: 'linear-gradient(180deg, rgba(9, 12, 16, 0.98) 0%, rgba(14, 19, 25, 0.98) 52%, rgba(23, 28, 34, 0.98) 100%)',
    panelShadow: '0 16px 34px rgba(0, 18, 36, 0.30)',
    domainLabel: '#effcff',
    domainValue: '#b5f0ff',
    summaryText: '#f2fdff',
    countText: '#f2fdff',
    subdomainBorder: 'rgba(125, 225, 255, 0.34)',
    subdomainBackground: 'linear-gradient(180deg, rgba(25, 52, 82, 0.96) 0%, rgba(36, 75, 114, 0.96) 100%)',
    subdomainShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)',
    subdomainHeader: '#effcff',
    subdomainValue: '#ffffff',
    flowBorder: 'rgba(125, 225, 255, 0.30)',
    flowBackground: 'linear-gradient(180deg, rgba(33, 66, 100, 0.98) 0%, rgba(47, 94, 137, 0.98) 100%)',
    flowBackgroundSelected: 'linear-gradient(90deg, rgba(0, 126, 217, 0.98) 0%, rgba(56, 205, 255, 0.98) 58%, rgba(180, 245, 255, 0.98) 100%)',
    flowBorderSelected: '#9aeaff',
    flowName: '#f7feff',
    flowCount: '#f4feff',
    connectorStroke: '#b7f3ff',
    connectorArrow: '#9aeaff',
    capabilityBorder: 'rgba(125, 225, 255, 0.28)',
    capabilityBackground: 'linear-gradient(180deg, rgba(42, 74, 109, 0.98) 0%, rgba(58, 100, 143, 0.98) 100%)',
    capabilityBackgroundSelected: 'linear-gradient(180deg, rgba(0, 126, 217, 0.98) 0%, rgba(56, 205, 255, 0.98) 100%)',
    capabilityText: '#f8fdff',
    capabilityTextMuted: '#f1feff',
    capabilityCount: '#ffffff',
  };

  const theme = colorScheme === 'att' ? attTheme : currentTheme;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ValueStreamRelationshipData | null>(null);
  const [hierarchyPaths, setHierarchyPaths] = useState<HierarchyPath[]>([]);
  const [visibleDomains, setVisibleDomains] = useState<string[]>([]);

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

  const groupedDomains = useMemo(() => {
    type SubdomainGroup = {
      key: string;
      subdomain: string;
      totalCount: number;
      valueStreams: typeof valueStreams;
    };

    type DomainGroup = {
      key: string;
      domain: string;
      totalCount: number;
      subdomains: Map<string, SubdomainGroup>;
    };

    const domainMap = new Map<string, DomainGroup>();

    for (const valueStream of valueStreams) {
      const labels = labelMap.get(valueStream.name);
      const rollupParts = valueStream.rollupLabel.split(' | ');
      const domain = valueStream.domain || labels?.domain || rollupParts[0] || 'Unspecified Domain';
      const subdomain = valueStream.subdomain || labels?.subdomain || rollupParts[1] || 'Unspecified Subdomain';
      const domainKey = domain;
      const subdomainKey = `${domain}|||${subdomain}`;

      if (!domainMap.has(domainKey)) {
        domainMap.set(domainKey, {
          key: domainKey,
          domain,
          totalCount: 0,
          subdomains: new Map(),
        });
      }

      const domainGroup = domainMap.get(domainKey)!;
      domainGroup.totalCount += valueStream.count;

      if (!domainGroup.subdomains.has(subdomainKey)) {
        domainGroup.subdomains.set(subdomainKey, {
          key: subdomainKey,
          subdomain,
          totalCount: 0,
          valueStreams: [],
        });
      }

      const subdomainGroup = domainGroup.subdomains.get(subdomainKey)!;
      subdomainGroup.totalCount += valueStream.count;
      subdomainGroup.valueStreams.push(valueStream);
    }

    return Array.from(domainMap.values()).map((domainGroup) => ({
      ...domainGroup,
      subdomains: Array.from(domainGroup.subdomains.values()),
    }));
  }, [labelMap, valueStreams]);

  useEffect(() => {
    setVisibleDomains(groupedDomains.map((domainGroup) => domainGroup.key));
  }, [groupedDomains]);

  const visibleGroupedDomains = useMemo(
    () => groupedDomains.filter((domainGroup) => visibleDomains.includes(domainGroup.key)),
    [groupedDomains, visibleDomains],
  );

  if (loading) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>;
  }

  if (error) {
    return <Alert type="error" message={error} showIcon />;
  }

  if (!valueStreams.length) {
    return <Empty description={`No value streams found for ${neighborhoodName}`} />;
  }

  const toggleDomainVisibility = (domainKey: string) => {
    setVisibleDomains((current) => (
      current.includes(domainKey)
        ? current.filter((key) => key !== domainKey)
        : [...current, domainKey]
    ));
  };

  const schemeButtons = [
    { key: 'current' as const, label: 'Current Colors' },
    { key: 'att' as const, label: 'AT&T Colors' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Color Scheme
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {schemeButtons.map((button) => {
            const isSelected = colorScheme === button.key;

            return (
              <button
                key={button.key}
                type="button"
                onClick={() => setColorScheme(button.key)}
                style={{
                  border: `1px solid ${isSelected ? theme.toggleBorderActive : theme.controlBorder}`,
                  borderRadius: 999,
                  padding: '10px 16px',
                  background: isSelected ? theme.controlBackgroundSelected : theme.controlBackground,
                  color: isSelected ? theme.controlTextSelected : theme.controlText,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                  boxShadow: isSelected ? '0 0 0 3px rgba(147, 171, 201, 0.18)' : '0 2px 6px rgba(71, 85, 105, 0.08)',
                }}
              >
                {button.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Domains
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          {groupedDomains.map((domainGroup) => {
            const isVisible = visibleDomains.includes(domainGroup.key);

            return (
              <button
                key={domainGroup.key}
                type="button"
                aria-pressed={isVisible}
                onClick={() => toggleDomainVisibility(domainGroup.key)}
                style={{
                  border: isVisible ? `2px solid ${theme.toggleBorderActive}` : `1px solid ${theme.controlBorder}`,
                  borderRadius: 999,
                  padding: '10px 16px',
                  background: isVisible ? theme.controlBackgroundSelected : theme.controlBackground,
                  color: isVisible ? theme.controlTextSelected : theme.controlText,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                  boxShadow: isVisible ? '0 0 0 3px rgba(147, 171, 201, 0.20)' : '0 2px 6px rgba(71, 85, 105, 0.08)',
                }}
              >
                {domainGroup.domain}
              </button>
            );
          })}
        </div>
      </div>
      <Card size="small" title={`Value Streams for ${neighborhoodName}`} style={{ minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 60, minHeight: 0 }}>
          {visibleGroupedDomains.length ? (
            visibleGroupedDomains.map((domainGroup) => (
              <div
                key={domainGroup.key}
                style={{
                  border: `1px solid ${theme.panelBorder}`,
                  borderRadius: 22,
                  padding: 16,
                  background: theme.panelBackground,
                  boxShadow: theme.panelShadow,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
                    <div style={{ fontWeight: 900, color: theme.domainValue, fontSize: 43, lineHeight: 1 }}>
                      {domainGroup.domain}
                    </div>
                    <div style={{ color: theme.sectionLabel, fontSize: 26, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 16, lineHeight: 1 }}>
                      Domain
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: theme.summaryText, fontSize: 24, fontWeight: 700, lineHeight: 1 }}>
                      {domainGroup.subdomains.length} subdomain{domainGroup.subdomains.length === 1 ? '' : 's'}
                    </div>
                    <div style={{ color: theme.countText, fontSize: 24, lineHeight: 1 }}>
                      {domainGroup.totalCount} Business Flow{domainGroup.totalCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))', gap: 16, alignItems: 'start' }}>
                  {domainGroup.subdomains.map((subdomainGroup) => {
                    const isRollupSelected = selectedRollupKey === subdomainGroup.key;

                    return (
                      <div
                        key={subdomainGroup.key}
                        style={{
                          border: `1px solid ${theme.subdomainBorder}`,
                          borderRadius: 18,
                          padding: 14,
                          background: theme.subdomainBackground,
                          boxShadow: isRollupSelected ? '0 0 0 3px rgba(147, 171, 201, 0.20), 0 6px 16px rgba(71, 85, 105, 0.10)' : theme.subdomainShadow,
                        }}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            cursor: onRollupSelect ? 'pointer' : 'default',
                            transform: isRollupSelected ? 'translateY(-1px)' : 'none',
                            marginBottom: 14,
                          }}
                          onClick={() => onRollupSelect?.({
                            neighborhoodName,
                            domain: domainGroup.domain,
                            subdomain: subdomainGroup.subdomain,
                            relationshipCount: subdomainGroup.totalCount,
                            valueStreamCount: subdomainGroup.valueStreams.length,
                          })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onRollupSelect?.({
                                neighborhoodName,
                                domain: domainGroup.domain,
                                subdomain: subdomainGroup.subdomain,
                                relationshipCount: subdomainGroup.totalCount,
                                valueStreamCount: subdomainGroup.valueStreams.length,
                              });
                            }
                          }}
                        >
                          <div style={{ fontWeight: 900, color: theme.subdomainValue, fontSize: 32, marginBottom: 10, lineHeight: 1, textAlign: 'center' }}>
                            {subdomainGroup.subdomain}
                          </div>
                          <div style={{ color: theme.sectionLabel, fontSize: 22, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 8, marginBottom: 4, lineHeight: 1, textAlign: 'center' }}>
                            Subdomain
                          </div>
                          <div style={{ color: theme.subdomainValue, fontSize: 24, fontWeight: 700, marginBottom: 2, lineHeight: 1, textAlign: 'center' }}>
                            {subdomainGroup.valueStreams.length} value stream{subdomainGroup.valueStreams.length === 1 ? '' : 's'}
                          </div>
                          <div style={{ color: theme.summaryText, fontSize: 20, marginTop: 'auto', textAlign: 'center' }}>{subdomainGroup.totalCount} Business Flow{subdomainGroup.totalCount === 1 ? '' : 's'}</div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', alignItems: 'center' }}>
                          {subdomainGroup.valueStreams.map((valueStream) => (
                            <div
                              key={valueStream.key}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                width: 'fit-content',
                                maxWidth: '100%',
                                gap: 10,
                                border: `1px solid ${theme.flowBorder}`,
                                borderRadius: 16,
                                padding: 14,
                                background: theme.flowBackground,
                              }}
                            >
                              <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                                Value Stream Flow
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                                <div
                                  role="button"
                                  tabIndex={0}
                                  style={{
                                    position: 'relative',
                                    width: '100%',
                                    minWidth: capabilityRowWidth,
                                    height: flowBarHeight,
                                    borderRadius: 999,
                                    background: selectedValueStreamKey === valueStream.key ? theme.flowBackgroundSelected : theme.flowBackground,
                                    border: selectedValueStreamKey === valueStream.key ? `2px solid ${theme.flowBorderSelected}` : `2px solid ${theme.flowBorder}`,
                                    overflow: 'hidden',
                                    boxShadow: selectedValueStreamKey === valueStream.key ? '0 0 0 3px rgba(147, 171, 201, 0.24), 0 4px 10px rgba(71, 85, 105, 0.10)' : '0 4px 10px rgba(71, 85, 105, 0.10)',
                                    cursor: onValueStreamSelect ? 'pointer' : 'default',
                                    transform: selectedValueStreamKey === valueStream.key ? 'translateY(-1px)' : 'none',
                                  }}
                                  onClick={() => onValueStreamSelect?.({
                                    neighborhoodName,
                                    domain: domainGroup.domain,
                                    subdomain: subdomainGroup.subdomain,
                                    valueStreamName: valueStream.name,
                                    relationshipCount: valueStream.count,
                                  })}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault();
                                      onValueStreamSelect?.({
                                        neighborhoodName,
                                        domain: domainGroup.domain,
                                        subdomain: subdomainGroup.subdomain,
                                        valueStreamName: valueStream.name,
                                        relationshipCount: valueStream.count,
                                      });
                                    }
                                  }}
                                >
                                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', color: theme.flowName, fontWeight: 900 }}>
                                    <span style={{ maxWidth: 'calc(100% - 50px)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: theme.flowName }}>
                                      {valueStream.name}
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                      <span style={{ color: theme.flowCount, fontSize: 12, fontWeight: 700 }}>
                                        {valueStream.count} Business Flow{valueStream.count === 1 ? '' : 's'}
                                      </span>
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div style={{ position: 'relative', width: '100%', maxWidth: '100%', marginTop: 8, paddingTop: connectorHeight }}>
                                <svg
                                  aria-hidden="true"
                                  width="100%"
                                  height={connectorHeight}
                                  viewBox={`0 0 ${capabilityRowWidth} ${connectorHeight}`}
                                  preserveAspectRatio="none"
                                  style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
                                >
                                  <defs>
                                    <marker
                                      id="value-stream-connector-arrow"
                                      markerWidth="8"
                                      markerHeight="8"
                                      refX="0"
                                      refY="4"
                                      orient="auto"
                                      markerUnits="strokeWidth"
                                    >
                                      <path d="M 0 0 L 8 4 L 0 8 z" fill={theme.connectorArrow} />
                                    </marker>
                                  </defs>
                                  {(capabilitiesByValueStream.get(valueStream.key) || []).map((capability, index, list) => {
                                    const totalWidth = list.length * capabilityTileWidth + Math.max(list.length - 1, 0) * capabilityTileGap;
                                    const startX = (capabilityRowWidth - totalWidth) / 2;
                                    const tileCenterX = startX + index * (capabilityTileWidth + capabilityTileGap) + capabilityTileWidth / 2;
                                    const flowCenterX = capabilityRowWidth / 2;
                                    const curveLift = 8 + Math.min(Math.abs(tileCenterX - flowCenterX) * 0.12, 24);
                                    return (
                                      <g key={`${valueStream.key}__${capability.name}__connector`}>
                                        <path
                                          d={`M ${tileCenterX} ${connectorHeight - 2} C ${tileCenterX} ${curveLift}, ${flowCenterX} ${curveLift}, ${flowCenterX} 0`}
                                          fill="none"
                                          stroke={theme.connectorStroke}
                                          strokeWidth="3"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          markerEnd="url(#value-stream-connector-arrow)"
                                        />
                                      </g>
                                    );
                                  })}
                                  <text
                                    x={capabilityRowWidth / 2}
                                    y={28}
                                    textAnchor="middle"
                                    fill={theme.connectorArrow}
                                    fontSize="10"
                                    fontWeight="700"
                                    style={{ letterSpacing: '0.4px', textTransform: 'uppercase' }}
                                  >
                                    enables
                                  </text>
                                </svg>

                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: capabilityTileGap, alignItems: 'stretch', justifyContent: 'center', width: '100%', maxWidth: '100%' }}>
                                  {(capabilitiesByValueStream.get(valueStream.key) || []).map((capability) => {
                                    const isSelected = selectedCapabilityName === capability.name && selectedValueStreamName === valueStream.name;
                                    return (
                                      <div
                                        key={`${valueStream.key}__${capability.name}`}
                                        role="button"
                                        tabIndex={0}
                                        style={{
                                          width: capabilityTileWidth,
                                          minHeight: 120,
                                          borderRadius: 16,
                                          border: isSelected ? `2px solid ${theme.flowBorderSelected}` : `1px solid ${theme.capabilityBorder}`,
                                          background: isSelected ? theme.capabilityBackgroundSelected : theme.capabilityBackground,
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          textAlign: 'center',
                                          padding: '12px 14px',
                                          color: theme.capabilityText,
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
                                          domain: domainGroup.domain,
                                          subdomain: subdomainGroup.subdomain,
                                        })}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            onCapabilitySelect?.({
                                              capabilityName: capability.name,
                                              valueStreamName: valueStream.name,
                                              relationshipCount: capability.count,
                                              neighborhoodName,
                                              domain: domainGroup.domain,
                                              subdomain: subdomainGroup.subdomain,
                                            });
                                          }
                                        }}
                                      >
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                                          <Text style={{ fontSize: 12, color: isSelected ? theme.capabilityTextMuted : theme.capabilityTextMuted, fontWeight: 700, lineHeight: 1.25 }}>
                                            {capability.name}
                                          </Text>
                                          <div style={{ fontSize: 18, fontWeight: 900, color: theme.capabilityCount }}>{capability.count}</div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                                Business Capabilities
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <Empty description="No visible domains selected" />
          )}
        </div>
      </Card>
    </div>
  );
}