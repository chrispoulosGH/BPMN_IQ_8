import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Alert, Card, Empty, Spin, Tooltip, Typography } from 'antd';
import { getComponentHierarchies, getDashboardFlowRelationships, type FlowMatrixMode, type ValueStreamRelationshipData } from '../api';
import type { HierarchyPath } from '../types';

const { Text } = Typography;

export interface ValueStreamCapabilitySelection {
  capabilityName: string;
  valueStreamName: string;
  relationshipCount: number;
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  // The business flows behind this tile (a capability group's are its
  // members' combined), so the Diagrams tab can show exactly those diagrams.
  businessFlows: string[];
  isGroup?: boolean;
}

export interface BusinessFlowSelection {
  neighborhoodName: string;
  businessFlowName: string;
}

export interface ValueStreamRollupSelection {
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  relationshipCount: number;
  valueStreamCount: number;
}

export interface DomainSelection {
  neighborhoodName: string;
  domain: string;
  relationshipCount: number;
  subdomainCount: number;
  businessFlows: string[];
}

export interface SubdomainSelection {
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  relationshipCount: number;
  businessFlowCount: number;
  businessFlows: string[];
}

export interface ValueStreamFlowSelection {
  neighborhoodName: string;
  domain: string;
  subdomain: string;
  valueStreamName: string;
  relationshipCount: number;
  businessFlows: string[];
}

interface ValueStreamsMatrixProps {
  neighborhoodName: string;
  mode?: FlowMatrixMode;
  onModeChange?: (mode: FlowMatrixMode) => void;
  onDomainSelect?: (selection: DomainSelection) => void;
  onSubdomainSelect?: (selection: SubdomainSelection) => void;
  onCapabilitySelect?: (selection: ValueStreamCapabilitySelection) => void;
  onRollupSelect?: (selection: ValueStreamRollupSelection) => void;
  onValueStreamSelect?: (selection: ValueStreamFlowSelection) => void;
  onBusinessFlowSelect?: (selection: BusinessFlowSelection) => void;
  selectedCapabilityName?: string | null;
  selectedValueStreamName?: string | null;
  selectedRollupKey?: string | null;
  selectedValueStreamKey?: string | null;
}

type ColorScheme = 'current' | 'att';

// A middle-layer tile: either one capability, or (grouped view) a capability
// group with its member capabilities and their combined business flows.
type MatrixCapability = {
  name: string;
  count: number;
  businessFlows: string[];
  isGroup: boolean;
  area?: string;
  members?: string[];
};
type ValueStreamsTheme = {
  sectionLabel: string;
  controlBorder: string;
  controlBackground: string;
  controlBackgroundSelected: string;
  controlText: string;
  controlTextSelected: string;
  toggleBorderActive: string;
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
  flowLabel: string;
  flowContainerBorder: string;
  flowContainerBackground: string;
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
  businessFlowBorder: string;
  businessFlowBackground: string;
  businessFlowText: string;
  tileCaption: string;
};

export default function ValueStreamsMatrix({
  neighborhoodName,
  mode = 'valueStream',
  onModeChange,
  onDomainSelect,
  onSubdomainSelect,
  onCapabilitySelect,
  onRollupSelect,
  onValueStreamSelect,
  onBusinessFlowSelect,
  selectedCapabilityName = null,
  selectedValueStreamName = null,
  selectedRollupKey = null,
  selectedValueStreamKey = null,
}: ValueStreamsMatrixProps) {
  const capabilityTileWidth = 150;
  const capabilityTileGap = 10;
  const capabilityRowWidth = 520;
  const flowBarHeight = 64;
  const connectorHeight = 54;
  const supportsConnectorHeight = 34;
  const businessFlowTileWidth = 140;
  const businessFlowTileGap = 8;
  // A capability column fits its business-flow children side by side.
  const capabilityColumnWidth = (flowCount: number) => Math.max(
    capabilityTileWidth,
    flowCount * businessFlowTileWidth + Math.max(flowCount - 1, 0) * businessFlowTileGap,
  );

  // Light, low-contrast palette matching the app's tab ribbon: white and
  // slate surfaces, slate text, blue only for selection and counts.
  const lightTheme: ValueStreamsTheme = {
    sectionLabel: '#64748b',
    controlBorder: '#e2e8f0',
    controlBackground: '#ffffff',
    controlBackgroundSelected: '#eff6ff',
    controlText: '#475569',
    controlTextSelected: '#1d4ed8',
    toggleBorderActive: '#93c5fd',
    panelBorder: '#e2e8f0',
    panelBackground: '#ffffff',
    panelShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
    domainLabel: '#0f172a',
    domainValue: '#0f172a',
    summaryText: '#334155',
    countText: '#64748b',
    // Each nesting level is one tan step darker: domain (white) →
    // subdomain → value stream area → value stream bar → capability tiles.
    subdomainBorder: '#ece3d4',
    subdomainBackground: '#faf6ef',
    subdomainShadow: 'none',
    subdomainHeader: '#3b2f22',
    subdomainValue: '#3b2f22',
    flowLabel: '#6b5638',
    flowContainerBorder: '#e2d4bd',
    flowContainerBackground: '#f3eadb',
    flowBorder: '#cdb894',
    flowBackground: '#e8dac2',
    flowBackgroundSelected: '#dbeafe',
    flowBorderSelected: '#2563eb',
    flowName: '#2e2418',
    flowCount: '#5c4a32',
    connectorStroke: '#a8916d',
    connectorArrow: '#8a7452',
    capabilityBorder: '#c2a87e',
    capabilityBackground: '#dcc7a3',
    capabilityBackgroundSelected: '#bfdbfe',
    capabilityText: '#2e2418',
    capabilityTextMuted: '#2e2418',
    capabilityCount: '#2e2418',
    // Bottom layer, one tan step darker than the capability above it.
    businessFlowBorder: '#b39769',
    businessFlowBackground: '#cfb68d',
    businessFlowText: '#2e2418',
    tileCaption: '#7d6a4c',
  };

  const theme = lightTheme;

  // Small type caption at the top centre of the value stream bar,
  // capability tiles and business-flow tiles.
  const tileCaptionStyle: CSSProperties = {
    fontSize: 9,
    fontWeight: 500,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: theme.tileCaption,
    lineHeight: 1.2,
    textAlign: 'center',
    marginBottom: 4,
  };

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ValueStreamRelationshipData | null>(null);
  const [hierarchyPaths, setHierarchyPaths] = useState<HierarchyPath[]>([]);
  const [visibleDomains, setVisibleDomains] = useState<string[]>([]);
  // 'grouped' = capability groups (L2) from capabilitygroupings; 'detailed' = today's capabilities.
  const [capabilityLevel, setCapabilityLevel] = useState<'grouped' | 'detailed'>('grouped');
  const isJourneyMode = mode === 'journey';
  const flowEntityLabel = isJourneyMode ? 'Journey' : 'Value Stream';
  const flowPluralLabel = isJourneyMode ? 'Journeys' : 'Value Streams';
  const flowCountLabel = 'Business Flow';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setHierarchyPaths([]);

    Promise.all([
      getDashboardFlowRelationships(neighborhoodName, mode),
      getComponentHierarchies(neighborhoodName, isJourneyMode ? 'Journey' : 'Value Stream', neighborhoodName),
    ])
      .then(([result, hierarchies]) => {
        if (!cancelled) {
          setData(result);
          setHierarchyPaths(hierarchies.paths || []);
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || `Failed to load ${flowPluralLabel.toLowerCase()}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [flowPluralLabel, isJourneyMode, mode, neighborhoodName]);

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
    const targetNodeName = isJourneyMode ? 'journey' : 'value stream';

    for (const path of hierarchyPaths) {
      const flowNode = path.nodes?.find((node) => normalize(node.componentName) === targetNodeName);
      if (!flowNode?.rowName) continue;

      const domainNode = path.nodes?.find((node) => normalize(node.componentName) === 'domain');
      const subdomainNode = path.nodes?.find((node) => normalize(node.componentName) === 'subdomain');

      map.set(flowNode.rowName, {
        domain: domainNode?.rowName || '',
        subdomain: subdomainNode?.rowName || '',
      });
    }
    return map;
  }, [hierarchyPaths, isJourneyMode]);

  const capabilitiesByValueStream = useMemo(() => {
    const map = new Map<string, MatrixCapability[]>();
    for (const valueStream of valueStreams) {
      const supporting = capabilities
        .map((capability) => {
          const link = links.find((candidate) => candidate.capability === capability.name && candidate.valueStreamKey === valueStream.key);
          return { name: capability.name, count: link?.count || 0, businessFlows: link?.businessFlows || [], isGroup: false };
        })
        .filter((capability) => capability.count > 0)
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
      map.set(valueStream.key, supporting);
    }
    return map;
  }, [capabilities, links, valueStreams]);

  // Same links rolled up to capability group (L2): one tile per group, with
  // the union of its member capabilities' business flows beneath it.
  const capabilityGroupsByValueStream = useMemo(() => {
    const map = new Map<string, MatrixCapability[]>();
    for (const valueStream of valueStreams) {
      const byGroup = new Map<string, { area: string; members: Set<string>; flows: Set<string> }>();
      for (const link of links) {
        if (link.valueStreamKey !== valueStream.key || !link.count) continue;
        const groupName = link.capabilityGroup || link.capability;
        const entry = byGroup.get(groupName) || { area: link.capabilityArea || 'Ungrouped', members: new Set<string>(), flows: new Set<string>() };
        entry.members.add(link.capability);
        (link.businessFlows || []).forEach((flow) => entry.flows.add(flow));
        byGroup.set(groupName, entry);
      }
      map.set(valueStream.key, [...byGroup.entries()]
        .map(([name, entry]) => ({
          name,
          count: entry.flows.size,
          businessFlows: [...entry.flows].sort((a, b) => a.localeCompare(b)),
          isGroup: true,
          area: entry.area,
          members: [...entry.members].sort((a, b) => a.localeCompare(b)),
        }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)));
    }
    return map;
  }, [links, valueStreams]);

  const activeCapabilitiesByValueStream = capabilityLevel === 'grouped' ? capabilityGroupsByValueStream : capabilitiesByValueStream;

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
      sortSequence: number;
    };

    const domainMap = new Map<string, DomainGroup>();

    const getSequenceQualifier = (valueStream: typeof valueStreams[number]) => {
      const candidateValues = [
        valueStream.domainSequence,
        (valueStream as any).l0_sequence_qualifier,
        (valueStream as any)['L0 sequence Qualifier'],
        (valueStream as any).sequence_qualifier,
        (valueStream as any)['sequence Qualifier'],
        (valueStream as any).sequence,
      ];

      for (const candidate of candidateValues) {
        if (candidate === null || candidate === undefined || candidate === '') continue;
        const parsed = Number(candidate);
        if (Number.isFinite(parsed)) return parsed;
      }

      return Number.MAX_SAFE_INTEGER;
    };

    for (const valueStream of valueStreams) {
      const labels = labelMap.get(valueStream.name);
      const rollupParts = valueStream.rollupLabel.split(' | ');
      const domain = valueStream.domain || labels?.domain || rollupParts[0] || 'Unspecified Domain';
      const subdomain = valueStream.subdomain || labels?.subdomain || rollupParts[1] || 'Unspecified Subdomain';
      const domainKey = domain;
      const subdomainKey = `${domain}|||${subdomain}`;
      const sequenceQualifier = getSequenceQualifier(valueStream);

      if (!domainMap.has(domainKey)) {
        domainMap.set(domainKey, {
          key: domainKey,
          domain,
          totalCount: 0,
          subdomains: new Map(),
          sortSequence: sequenceQualifier,
        });
      }

      const domainGroup = domainMap.get(domainKey)!;
      domainGroup.totalCount += valueStream.count;
      domainGroup.sortSequence = Math.min(domainGroup.sortSequence, sequenceQualifier);

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

    return Array.from(domainMap.values())
      .sort((left, right) => {
        if (left.sortSequence !== right.sortSequence) return left.sortSequence - right.sortSequence;
        return left.domain.localeCompare(right.domain);
      })
      .map((domainGroup) => ({
      ...domainGroup,
      subdomains: Array.from(domainGroup.subdomains.values()),
    }));
  }, [labelMap, valueStreams]);

  useEffect(() => {
    setVisibleDomains(groupedDomains.length ? [groupedDomains[0].key] : []);
  }, [groupedDomains]);

  // Every business flow in a domain: the union of its value streams' flows.
  const domainFlows = (domainGroup: { subdomains: Array<{ valueStreams: typeof valueStreams }> }) => (
    [...new Set(domainGroup.subdomains.flatMap((sub) => sub.valueStreams.flatMap((vs) => vs.businessFlows || [])))].sort((a, b) => a.localeCompare(b))
  );

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
    return <Empty description={`No ${flowPluralLabel.toLowerCase()} found for ${neighborhoodName}`} />;
  }

  const toggleDomainVisibility = (domainKey: string) => {
    setVisibleDomains([domainKey]);
  };

  const modeButtons = [
    { key: 'valueStream' as const, label: 'Value Stream View' },
    { key: 'journey' as const, label: 'Journey View' },
  ];
  const connectorLabel = isJourneyMode ? 'Consumed by' : 'enables';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 12px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          View Mode
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {modeButtons.map((button) => {
            const isSelected = mode === button.key;

            return (
              <button
                key={button.key}
                type="button"
                onClick={() => onModeChange?.(button.key)}
                style={{
                  border: `1px solid ${isSelected ? theme.toggleBorderActive : theme.controlBorder}`,
                  borderRadius: 6,
                  padding: '6px 12px',
                  background: isSelected ? theme.controlBackgroundSelected : theme.controlBackground,
                  color: isSelected ? theme.controlTextSelected : theme.controlText,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  boxShadow: 'none',
                }}
              >
                {button.label}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          Capabilities
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {([
            { key: 'grouped' as const, label: 'Grouped', hint: 'One tile per capability group, with every business flow of its member capabilities beneath it' },
            { key: 'detailed' as const, label: 'Detailed', hint: 'One tile per individual business capability' },
          ]).map((option) => {
            const isSelected = capabilityLevel === option.key;
            return (
              <Tooltip key={option.key} title={option.hint}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setCapabilityLevel(option.key)}
                  style={{
                    border: `1px solid ${isSelected ? theme.toggleBorderActive : theme.controlBorder}`,
                    borderRadius: 6,
                    padding: '6px 12px',
                    background: isSelected ? theme.controlBackgroundSelected : theme.controlBackground,
                    color: isSelected ? theme.controlTextSelected : theme.controlText,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                    boxShadow: 'none',
                  }}
                >
                  {option.label}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}>
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
                  border: `1px solid ${isVisible ? theme.toggleBorderActive : theme.controlBorder}`,
                  borderRadius: 6,
                  padding: '6px 12px',
                  background: isVisible ? theme.controlBackgroundSelected : theme.controlBackground,
                  color: isVisible ? theme.controlTextSelected : theme.controlText,
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  boxShadow: 'none',
                }}
              >
                {domainGroup.domain}
              </button>
            );
          })}
        </div>
      </div>
      <Card size="small" title={`${flowPluralLabel} for ${neighborhoodName}`} style={{ minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 60, minHeight: 0 }}>
          {visibleGroupedDomains.length ? (
            visibleGroupedDomains.map((domainGroup) => (
              <div
                key={domainGroup.key}
                style={{
                  border: `1px solid ${theme.panelBorder}`,
                  borderRadius: 12,
                  padding: 16,
                  background: theme.panelBackground,
                  boxShadow: theme.panelShadow,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onDomainSelect?.({
                        neighborhoodName,
                        domain: domainGroup.domain,
                        relationshipCount: domainGroup.totalCount,
                        subdomainCount: domainGroup.subdomains.length,
                        businessFlows: domainFlows(domainGroup),
                      })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onDomainSelect?.({
                            neighborhoodName,
                            domain: domainGroup.domain,
                            relationshipCount: domainGroup.totalCount,
                            subdomainCount: domainGroup.subdomains.length,
                        businessFlows: domainFlows(domainGroup),
                          });
                        }
                      }}
                      style={{
                        fontWeight: 600,
                        color: theme.domainValue,
                        fontSize: 24,
                        lineHeight: 1,
                        cursor: onDomainSelect ? 'pointer' : 'default',
                        textDecoration: onDomainSelect ? 'underline' : 'none',
                        textUnderlineOffset: '4px',
                        textDecorationColor: '#cbd5e1',
                      }}
                    >
                      {domainGroup.domain}
                    </div>
                    <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 8, lineHeight: 1 }}>
                      Domain
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: theme.summaryText, fontSize: 14, fontWeight: 600, lineHeight: 1.4 }}>
                      {domainGroup.subdomains.length} subdomain{domainGroup.subdomains.length === 1 ? '' : 's'}
                    </div>
                    <div style={{ color: theme.countText, fontSize: 13, lineHeight: 1.4 }}>
                      {domainGroup.totalCount} Business Flow{domainGroup.totalCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))', gap: 16, alignItems: 'start' }}>
                  {domainGroup.subdomains.map((subdomainGroup) => {
                    const isRollupSelected = !isJourneyMode && selectedRollupKey === subdomainGroup.key;
                    const subdomainFlows = [...new Set(subdomainGroup.valueStreams.flatMap((vs) => vs.businessFlows || []))].sort((a, b) => a.localeCompare(b));

                    return (
                      <div
                        key={subdomainGroup.key}
                        style={{
                          border: `1px solid ${theme.subdomainBorder}`,
                          borderRadius: 10,
                          padding: 14,
                          background: theme.subdomainBackground,
                          boxShadow: isRollupSelected ? '0 0 0 3px rgba(59, 130, 246, 0.12)' : theme.subdomainShadow,
                        }}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            cursor: onSubdomainSelect ? 'pointer' : (!isJourneyMode && onRollupSelect ? 'pointer' : 'default'),
                            transform: isRollupSelected ? 'translateY(-1px)' : 'none',
                            marginBottom: 14,
                          }}
                          onClick={() => {
                            if (onSubdomainSelect) {
                              onSubdomainSelect({
                                neighborhoodName,
                                domain: domainGroup.domain,
                                subdomain: subdomainGroup.subdomain,
                                relationshipCount: subdomainGroup.totalCount,
                                businessFlowCount: subdomainGroup.totalCount,
                                businessFlows: subdomainFlows,
                              });
                              return;
                            }
                            if (isJourneyMode) return;
                            onRollupSelect?.({
                              neighborhoodName,
                              domain: domainGroup.domain,
                              subdomain: subdomainGroup.subdomain,
                              relationshipCount: subdomainGroup.totalCount,
                              valueStreamCount: subdomainGroup.valueStreams.length,
                            });
                          }}
                          onKeyDown={(event) => {
                            if (onSubdomainSelect) {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onSubdomainSelect?.({
                                  neighborhoodName,
                                  domain: domainGroup.domain,
                                  subdomain: subdomainGroup.subdomain,
                                  relationshipCount: subdomainGroup.totalCount,
                                  businessFlowCount: subdomainGroup.totalCount,
                                businessFlows: subdomainFlows,
                                });
                              }
                              return;
                            }
                            if (isJourneyMode) return;
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
                          <div style={{ fontWeight: 600, color: theme.subdomainValue, fontSize: 18, marginBottom: 4, lineHeight: 1, textAlign: 'center' }}>
                            {subdomainGroup.subdomain}
                          </div>
                          <div style={{ color: theme.sectionLabel, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 4, marginBottom: 2, lineHeight: 1, textAlign: 'center' }}>
                            Subdomain
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', alignItems: 'safe center', overflowX: 'auto', paddingBottom: 2 }}>
                          {subdomainGroup.valueStreams.map((valueStream) => {
                            const connectorMarkerId = valueStream.key.replace(/[^a-zA-Z0-9_-]/g, '-');
                            const journeyActors = isJourneyMode ? (valueStream.actors || []) : [];
                            const hasJourneyActors = journeyActors.length > 0;
                            const actorsText = journeyActors.length > 3
                              ? `${journeyActors.slice(0, 3).join(', ')} +${journeyActors.length - 3} more`
                              : journeyActors.join(', ');
                            const itemFlowBarHeight = hasJourneyActors ? flowBarHeight + 20 : flowBarHeight;
                            // Each capability column is as wide as its row of business-flow
                            // children (at least one capability tile wide). The "enables"
                            // connectors are drawn to these real column centres.
                            const vsCapabilities = activeCapabilitiesByValueStream.get(valueStream.key) || [];
                            const columnWidths = vsCapabilities.map((capability) => capabilityColumnWidth(capability.businessFlows.length));
                            const columnsTotalWidth = columnWidths.reduce((sum, width) => sum + width, 0) + Math.max(columnWidths.length - 1, 0) * capabilityTileGap;
                            const connectorRowWidth = Math.max(capabilityRowWidth, columnsTotalWidth);
                            const columnsStartX = (connectorRowWidth - columnsTotalWidth) / 2;
                            const columnCenters = columnWidths.map((width, index) => (
                              columnsStartX + columnWidths.slice(0, index).reduce((sum, w) => sum + w + capabilityTileGap, 0) + width / 2
                            ));
                            return (
                            <div
                              key={valueStream.key}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                width: 'fit-content',
                                flexShrink: 0,
                                gap: 10,
                                border: `1px solid ${theme.flowContainerBorder}`,
                                borderRadius: 10,
                                padding: 14,
                                background: theme.flowContainerBackground,
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
                                <div
                                  role="button"
                                  tabIndex={0}
                                  style={{
                                    position: 'relative',
                                    width: '100%',
                                    minWidth: capabilityRowWidth,
                                    height: itemFlowBarHeight,
                                    borderRadius: 8,
                                    background: selectedValueStreamKey === valueStream.key ? theme.flowBackgroundSelected : theme.flowBackground,
                                    border: selectedValueStreamKey === valueStream.key ? `1px solid ${theme.flowBorderSelected}` : `1px solid ${theme.flowBorder}`,
                                    overflow: 'hidden',
                                    boxShadow: selectedValueStreamKey === valueStream.key ? '0 0 0 3px rgba(59, 130, 246, 0.12)' : '0 1px 2px rgba(15, 23, 42, 0.05)',
                                    cursor: onValueStreamSelect ? 'pointer' : 'default',
                                    transform: selectedValueStreamKey === valueStream.key ? 'translateY(-1px)' : 'none',
                                  }}
                                  onClick={() => onValueStreamSelect?.({
                                    neighborhoodName,
                                    domain: domainGroup.domain,
                                    subdomain: subdomainGroup.subdomain,
                                    valueStreamName: valueStream.name,
                                    relationshipCount: valueStream.count,
                                    businessFlows: valueStream.businessFlows || [],
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
                                    businessFlows: valueStream.businessFlows || [],
                                      });
                                    }
                                  }}
                                >
                                  <div style={{ ...tileCaptionStyle, position: 'absolute', top: 6, left: 0, right: 0 }}>{flowEntityLabel}</div>
                                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '12px 22px 0', color: theme.flowName, fontWeight: 600, fontSize: 14 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
                                      <span style={{ maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: theme.flowName }}>
                                        {valueStream.name}
                                      </span>
                                    </div>
                                    {hasJourneyActors ? (
                                      <Tooltip title={journeyActors.join(', ')} placement="bottom">
                                        <div
                                          style={{
                                            maxWidth: '100%',
                                            whiteSpace: 'nowrap',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            marginTop: 2,
                                            fontSize: 11,
                                            fontWeight: 400,
                                            fontStyle: 'italic',
                                            letterSpacing: 0.2,
                                            color: theme.flowCount,
                                            opacity: 0.85,
                                          }}
                                        >
                                          {actorsText}
                                        </div>
                                      </Tooltip>
                                    ) : null}
                                  </div>
                                </div>
                              </div>

                              <div style={{ position: 'relative', width: connectorRowWidth, marginTop: 8, paddingTop: connectorHeight }}>
                                <svg
                                  aria-hidden="true"
                                  width="100%"
                                  height={connectorHeight}
                                  viewBox={`0 0 ${connectorRowWidth} ${connectorHeight}`}
                                  preserveAspectRatio="none"
                                  style={{ position: 'absolute', left: 0, top: 0, zIndex: 2, overflow: 'visible', pointerEvents: 'none' }}
                                >
                                  <defs>
                                    <marker
                                      id={`value-stream-connector-arrow-${connectorMarkerId}`}
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
                                  {vsCapabilities.map((capability, index) => {
                                    const tileCenterX = columnCenters[index];
                                    const flowCenterX = connectorRowWidth / 2;
                                    const curveLift = 8 + Math.min(Math.abs(tileCenterX - flowCenterX) * 0.12, 24);
                                    return (
                                      <g key={`${valueStream.key}__${capability.name}__connector`}>
                                        <path
                                          d={`M ${tileCenterX} ${connectorHeight - 2} C ${tileCenterX} ${curveLift}, ${flowCenterX} ${curveLift}, ${flowCenterX} 0`}
                                          fill="none"
                                          stroke={theme.connectorStroke}
                                          strokeWidth="1.5"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          markerEnd={`url(#value-stream-connector-arrow-${connectorMarkerId})`}
                                        />
                                      </g>
                                    );
                                  })}
                                  <text
                                    x={connectorRowWidth / 2}
                                    y={28}
                                    textAnchor="middle"
                                    fill={theme.connectorArrow}
                                    stroke={theme.flowContainerBackground}
                                    strokeWidth={4}
                                    paintOrder="stroke"
                                    fontSize="10"
                                    fontWeight="600"
                                    style={{ letterSpacing: '0.4px', textTransform: 'uppercase' }}
                                  >
                                    {connectorLabel}
                                  </text>
                                </svg>

                                <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexWrap: 'nowrap', gap: capabilityTileGap, alignItems: 'flex-start', justifyContent: 'center', width: '100%' }}>
                                  {vsCapabilities.map((capability, capabilityIndex) => {
                                    // Capabilities and capability groups both click through to their flows' diagrams.
                                    const canSelect = Boolean(onCapabilitySelect);
                                    const isSelected = canSelect && selectedCapabilityName === capability.name && selectedValueStreamName === valueStream.name;
                                    const selectCapability = () => canSelect && onCapabilitySelect?.({
                                      capabilityName: capability.name,
                                      valueStreamName: valueStream.name,
                                      relationshipCount: capability.count,
                                      businessFlows: capability.businessFlows,
                                      isGroup: capability.isGroup,
                                      neighborhoodName,
                                      domain: domainGroup.domain,
                                      subdomain: subdomainGroup.subdomain,
                                    });
                                    const flowNames = capability.businessFlows;
                                    const columnWidth = columnWidths[capabilityIndex];
                                    const flowsRowWidth = flowNames.length * businessFlowTileWidth + Math.max(flowNames.length - 1, 0) * businessFlowTileGap;
                                    const flowsStartX = (columnWidth - flowsRowWidth) / 2;
                                    const capabilityCenterX = columnWidth / 2;
                                    return (
                                      // One column per capability: the capability tile on top, its
                                      // business flows side by side beneath it, joined by "supports".
                                      <div key={`${valueStream.key}__${capability.name}`} style={{ width: columnWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                      <div
                                        role={canSelect ? 'button' : undefined}
                                        tabIndex={canSelect ? 0 : undefined}
                                        style={{
                                          // A group spans the full width of its flows beneath it.
                                          width: capability.isGroup ? columnWidth : capabilityTileWidth,
                                          minHeight: 72,
                                          borderRadius: 8,
                                          border: isSelected ? `1px solid ${theme.flowBorderSelected}` : `1px solid ${theme.capabilityBorder}`,
                                          background: isSelected ? theme.capabilityBackgroundSelected : theme.capabilityBackground,
                                          display: 'flex',
                                          flexDirection: 'column',
                                          alignItems: 'center',
                                          textAlign: 'center',
                                          padding: '6px 12px 10px',
                                          color: theme.capabilityText,
                                          fontWeight: 500,
                                          boxShadow: isSelected ? '0 0 0 3px rgba(59, 130, 246, 0.12)' : '0 1px 2px rgba(15, 23, 42, 0.05)',
                                          cursor: canSelect ? 'pointer' : 'default',
                                          transform: isSelected ? 'translateY(-1px)' : 'none',
                                        }}
                                        title={capability.isGroup
                                          ? `${capability.name} (${capability.area}) enables ${valueStream.name}\nIncludes: ${(capability.members || []).join(', ')}`
                                          : `${capability.name} enables ${valueStream.name}`}
                                        onClick={selectCapability}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            selectCapability();
                                          }
                                        }}
                                      >
                                        <div style={tileCaptionStyle}>{capability.isGroup ? 'Capability Group' : 'Business Capability'}</div>
                                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                                          <Text style={{ fontSize: 12, color: theme.capabilityTextMuted, fontWeight: capability.isGroup ? 600 : 500, lineHeight: 1.3 }}>
                                            {capability.name}
                                          </Text>
                                          {capability.isGroup ? (
                                            <>
                                              <div style={{ fontSize: 10, color: theme.tileCaption, lineHeight: 1.2 }}>{capability.area}</div>
                                              <div style={{ fontSize: 10, color: theme.capabilityText, opacity: 0.8, lineHeight: 1.3 }}>
                                                {(capability.members || []).join(' · ')}
                                              </div>
                                            </>
                                          ) : null}
                                        </div>
                                      </div>

                                      {/* "supports" connectors: one up-arrow from each business flow to the capability */}
                                      <svg aria-hidden="true" width={columnWidth} height={supportsConnectorHeight} style={{ display: 'block', overflow: 'visible' }}>
                                        {flowNames.map((flowName, flowIndex) => {
                                          const flowCenterX = flowsStartX + flowIndex * (businessFlowTileWidth + businessFlowTileGap) + businessFlowTileWidth / 2;
                                          const lift = supportsConnectorHeight / 2;
                                          return (
                                            <path
                                              key={flowName}
                                              d={`M ${flowCenterX} ${supportsConnectorHeight} C ${flowCenterX} ${lift}, ${capabilityCenterX} ${lift}, ${capabilityCenterX} 8`}
                                              fill="none"
                                              stroke={theme.connectorStroke}
                                              strokeWidth="1.5"
                                              strokeLinecap="round"
                                            />
                                          );
                                        })}
                                        <path d={`M ${capabilityCenterX - 5} 8 L ${capabilityCenterX} 1 L ${capabilityCenterX + 5} 8 z`} fill={theme.connectorArrow} />
                                        <text
                                          x={flowNames.length > 1 ? capabilityCenterX : capabilityCenterX + 8}
                                          y={flowNames.length > 1 ? supportsConnectorHeight / 2 + 3 : supportsConnectorHeight / 2 + 4}
                                          textAnchor={flowNames.length > 1 ? 'middle' : 'start'}
                                          fill={theme.connectorArrow}
                                          stroke={theme.flowContainerBackground}
                                          strokeWidth={4}
                                          paintOrder="stroke"
                                          fontSize="10"
                                          fontWeight="600"
                                          style={{ letterSpacing: '0.4px', textTransform: 'uppercase' }}
                                        >
                                          supports
                                        </text>
                                      </svg>

                                      {/* Business flows: siblings on one row */}
                                      <div style={{ display: 'flex', gap: businessFlowTileGap, justifyContent: 'center', alignItems: 'stretch' }}>
                                        {flowNames.map((flowName) => (
                                          <Tooltip key={flowName} title={`${flowName} supports ${capability.name}`} placement="bottom" mouseEnterDelay={0.3}>
                                            <div
                                              role={onBusinessFlowSelect ? 'button' : undefined}
                                              tabIndex={onBusinessFlowSelect ? 0 : undefined}
                                              onClick={() => onBusinessFlowSelect?.({ neighborhoodName, businessFlowName: flowName })}
                                              onKeyDown={(event) => {
                                                if (event.key === 'Enter' || event.key === ' ') {
                                                  event.preventDefault();
                                                  onBusinessFlowSelect?.({ neighborhoodName, businessFlowName: flowName });
                                                }
                                              }}
                                              style={{
                                                cursor: onBusinessFlowSelect ? 'pointer' : 'default',
                                                width: businessFlowTileWidth,
                                                minHeight: 60,
                                                borderRadius: 8,
                                                border: `1px solid ${theme.businessFlowBorder}`,
                                                background: theme.businessFlowBackground,
                                                color: theme.businessFlowText,
                                                padding: '6px 10px 8px',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                textAlign: 'center',
                                                fontSize: 11,
                                                fontWeight: 500,
                                                lineHeight: 1.3,
                                                boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)',
                                              }}
                                            >
                                              <div style={tileCaptionStyle}>Business Flow</div>
                                              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{flowName}</div>
                                            </div>
                                          </Tooltip>
                                        ))}
                                      </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                            );
                          })}
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