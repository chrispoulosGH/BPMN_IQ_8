import { useEffect, useMemo, useState, useDeferredValue, useRef } from 'react';
import { App as AntApp, Card, Space, Spin, Tree, Button, Segmented, Tabs, Empty, AutoComplete, Input, Drawer, Divider, Descriptions, Badge, Tag, Collapse, Select } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { FolderOutlined, TableOutlined, SearchOutlined, CloseOutlined, BarsOutlined, UnorderedListOutlined } from '@ant-design/icons';

import { getCustomFactories, getComponentHierarchies, getCustomFactory, getCustomFactoryForModel, getApplicationByCorrelationId, getApplicationByName, getFactoryNeighborhoods, getLeafComponent, getCanonicalFactories, getSystemComponentLinkedTypes, getSystemComponentRecordsLinkedToApplication } from '../api';
import type { LinkedSystemComponentRecord } from '../api';
import type { CustomFactory, CustomFactoryRow, HierarchyPath } from '../types';

// Applications live in the "System Components" reference catalog regardless
// of which model's tree a node is being viewed from — matches
// REFERENCE_DATA_NEIGHBORHOOD_NAME in App.tsx.
const SYSTEM_COMPONENTS_NEIGHBORHOOD = 'System Components';

// "actor_qualifier" -> "Actor", "bpmn_task_type_qualifier" -> "Bpmn Task Type"
const qualifierLabel = (key: string) =>
  key
    .replace(/[_\s]*qualifier$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/(?:^|\s)\S/g, (ch) => ch.toUpperCase())
    .trim();

// Field-value formatting for a linked System Component record's raw values —
// same rules previously used by the (now-removed) LinkedRecordsModal popup.
const toLabel = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (ch) => ch.toUpperCase());

const isKeyLikeString = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
  const mongoIdLike = /^[0-9a-f]{24}$/i.test(text);
  const longOpaqueToken = /^[A-Za-z0-9_-]{20,}$/i.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
  return uuidLike || mongoIdLike || longOpaqueToken;
};

const renderFieldValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === 'object') {
    return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
};

// Colors for synthetic "linked System Component" tree nodes — deliberately
// distinct from the hierarchy's own depth-cycled palette, so the linked-data
// branch under an Application reads as a different kind of thing.
const LINK_TYPE_BG = '#FEF3C7';
const LINK_TYPE_TEXT = '#B45309';
const LINK_RECORD_BG = '#ECFDF5';
const LINK_RECORD_TEXT = '#0891B2';

const buildBadgeNodeTitle = (badge: string, label: string, bg: string, color: string) => (
  <div style={{ display: 'flex', gap: '12px', alignItems: 'center', width: '100%', padding: '4px 8px' }}>
    <div
      style={{
        minWidth: '120px',
        maxWidth: '120px',
        textAlign: 'left',
        color,
        fontSize: '12px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        padding: '4px 8px',
        backgroundColor: bg,
        borderRadius: '4px',
        flexShrink: 0,
      }}
    >
      {badge}
    </div>
    <div style={{ fontSize: '13px', color: '#1E293B', fontWeight: 500, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
    </div>
  </div>
);

const buildPlaceholderNodeTitle = (label: string) => (
  <div style={{ padding: '4px 20px', fontSize: '12px', color: '#9CA3AF', fontStyle: 'italic' }}>{label}</div>
);

interface ComponentsViewerProps {
  neighborhoodName: string;
  onComponentTabSelect?: (componentId: string, componentName: string) => void;
  availableComponentIds?: string[];
  renderComponentContent?: (componentId: string, componentName: string, highlightedRowName?: string | null) => React.ReactNode;
  onApplicationLinkClick?: (applicationName: string, correlationId?: string | null, rowSearchText?: string) => void;
}

export default function ComponentsViewer({
  neighborhoodName,
  onComponentTabSelect,
  availableComponentIds = [],
  renderComponentContent,
  onApplicationLinkClick,
}: ComponentsViewerProps) {
  const { message } = AntApp.useApp();
  const [selectedSystemComponentRecord, setSelectedSystemComponentRecord] = useState<LinkedSystemComponentRecord | null>(null);
  const [hierarchies, setHierarchies] = useState<HierarchyPath[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [activeModelName, setActiveModelName] = useState<string>(neighborhoodName || '');
  const [components, setComponents] = useState<CustomFactory[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'tree-vertical' | 'tree-horizontal'>('tree-horizontal');
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [searchText, setSearchText] = useState('');
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [selectedNodeKey, setSelectedNodeKey] = useState<React.Key | null>(null);
  const [searchHitNodeKey, setSearchHitNodeKey] = useState<React.Key | null>(null);
  const [selectedComponent, setSelectedComponent] = useState<CustomFactory | null>(null);
  const [selectedNodeQualifiers, setSelectedNodeQualifiers] = useState<Record<string, string>>({});
  const [showMetadataDrawer, setShowMetadataDrawer] = useState(false);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [activeTabKey, setActiveTabKey] = useState<string | undefined>(undefined);
  const [highlightedComponentId, setHighlightedComponentId] = useState<string | null>(null);
  const [highlightedRowName, setHighlightedRowName] = useState<string | null>(null);
  const [ancestryPaths, setAncestryPaths] = useState<Array<Array<{ componentName: string; rowName: string; componentId: string }>> | null>(null);
  // treeViewMode merged into viewMode ('tree-vertical' | 'tree-horizontal')

  // Defer search text updates to prevent blocking the UI on every keystroke
  const deferredSearchText = useDeferredValue(searchText);
  const selectedNodeRef = useRef<HTMLDivElement>(null);
  const horizontalTreeContainerRef = useRef<HTMLDivElement>(null);
  const horizontalTreeNodeRefMap = useRef<Map<React.Key, HTMLElement>>(new Map());
  const pendingHorizontalRevealKeyRef = useRef<React.Key | null>(null);
  const horizontalPanStateRef = useRef<{ pointerId: number; startX: number; startY: number; startScrollLeft: number; startScrollTop: number; moved: boolean; } | null>(null);
  const [isHorizontalPanning, setIsHorizontalPanning] = useState(false);
  // Tracks which tree nodes have already had their linked-System-Components children
  // fetched, so re-expanding a node doesn't re-fetch (and an empty result isn't
  // mistaken for "not yet loaded").
  const loadedNodeKeysRef = useRef<Set<React.Key>>(new Set());
  const linkedApplicationTypesRef = useRef<string[] | null>(null);

  const renderHighlightedText = (text: string, query: string) => {
    const safeText = String(text || '');
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return safeText;
    const lowerText = safeText.toLowerCase();
    const lowerQuery = safeQuery.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    if (matchIndex === -1) return safeText;

    return (
      <>
        {safeText.slice(0, matchIndex)}
        <span style={{ backgroundColor: '#fef08a', borderRadius: 2, padding: '0 1px' }}>
          {safeText.slice(matchIndex, matchIndex + safeQuery.length)}
        </span>
        {safeText.slice(matchIndex + safeQuery.length)}
      </>
    );
  };

  // Load hierarchies from ComponentSearchIndex
  // Load hierarchies for all component types (not just leaf)
  useEffect(() => {
    if (!components || components.length === 0) return; // Wait for components to load

    let cancelled = false;

    const loadHierarchies = async () => {
      setLoading(true);
      try {
        const { leafComponent } = await getLeafComponent(neighborhoodName, activeModelName);
        console.log(`[ComponentsViewer] API CALL: Loading ${leafComponent} hierarchies for ${neighborhoodName}/${activeModelName}`);
        const result = await getComponentHierarchies(neighborhoodName, leafComponent, activeModelName, true);
        const allPaths = result.paths || [];
        
        // Deduplicate paths by pathKey
        const uniquePaths = Array.from(new Map(allPaths.map(p => [p.pathKey, p])).values());
        console.log(`[ComponentsViewer] API RESPONSE: Merged hierarchies loaded`, {
          totalPathsFromComponents: allPaths.length,
          uniquePathCount: uniquePaths.length,
          paths: uniquePaths.slice(0, 5).map((p: any) => ({ 
            componentName: p.nodes?.[p.nodes.length - 1]?.componentName,
            pathStr: p.pathStr
          }))
        });
        
        // TRACE: Look for Care in the hierarchies
        const carePaths = uniquePaths.filter((p: any) => 
          p.nodes?.some((node: any) => node.componentName === 'channel' && node.rowName === 'Care')
        ) || [];
        console.log(`[ComponentsViewer] ✅ FOUND ${carePaths.length} paths containing Care channel`, carePaths.slice(0, 3).map((p: any) => p.pathStr));
        
        if (!cancelled) {
          setHierarchies(uniquePaths);
          console.log(`[ComponentsViewer] HIERARCHY TREE: Set ${uniquePaths.length} unique paths to state`);
        }
      } catch (error: any) {
        if (!cancelled) {
          setHierarchies([]);
          console.error(`[ComponentsViewer] ERROR loading hierarchies:`, error);
          message.error(error.response?.data?.error || error.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadHierarchies();
    return () => { cancelled = true; };
  }, [message, neighborhoodName, activeModelName, components]);

  // Load available models (neighborhoods)
  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        const list = await getFactoryNeighborhoods();
        if (!cancelled) {
          const names = (list || []).map((n: any) => n.name || n);
          setModels(names);
          // Set default active model if not set
          if (!activeModelName && names.length) setActiveModelName(names[0]);
        }
      } catch (err) {
        console.warn('Failed to load models', err);
      }
    };
    loadModels();
    return () => { cancelled = true; };
  }, []);

  // Also load custom factories for table view
  useEffect(() => {
    let cancelled = false;

    const loadComponents = async () => {
      try {
        console.log(`[ComponentsViewer] API CALL: Loading canonical factories for ${neighborhoodName}/${activeModelName}`);
        // Use canonical-backed factories for large datasets, but fall back to legacy factories if canonical is empty.
        let allComponents = await getCanonicalFactories(neighborhoodName, true, 100).catch(() => [] as CustomFactory[]);
        if (!allComponents.length) {
          allComponents = await getCustomFactories(neighborhoodName).catch(() => [] as CustomFactory[]);
        }
        
        // TRACE: Log all component names
        console.log(`[ComponentsViewer] API RESPONSE: Received ${allComponents.length} components:`, 
          allComponents.map((c: any) => ({ name: c.name, rowCount: c.rows?.length || 0 }))
        );
        
        // TRACE: Show Care channel specifically
        const careChannel = allComponents.find((c: any) => c.name === 'channel');
        if (careChannel) {
          console.log(`[ComponentsViewer] TRACE: Channel component found:`, {
            name: careChannel.name,
            rowCount: careChannel.rows?.length || 0,
            rows: careChannel.rows?.map((r: any) => r.values?.name) || []
          });
          const careRow = careChannel.rows?.find((r: any) => r.values?.name === 'Care');
          if (careRow) {
            console.log(`[ComponentsViewer] ✅ CARE FOUND in channel component:`, careRow);
          } else {
            console.warn(`[ComponentsViewer] ⚠️  CARE NOT FOUND in channel component`);
          }
        } else {
          console.warn(`[ComponentsViewer] ⚠️  CHANNEL COMPONENT NOT FOUND in response`);
        }
        
        if (!cancelled) {
          // Restore persisted tab order for this model (if available)
          try {
            const key = localStorageKeyForModel(activeModelName);
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
            if (raw) {
              const ids: string[] = JSON.parse(raw);
              const byId = new Map(allComponents.map((c) => [c._id, c]));
              const ordered: CustomFactory[] = [];
              ids.forEach((id) => {
                const found = byId.get(id);
                if (found) ordered.push(found);
              });
              // Append any new components not in persisted order
              allComponents.forEach((c) => { if (!ids.includes(c._id)) ordered.push(c); });
              setComponents(ordered);
              return;
            }
          } catch (err) {
            console.warn('Failed to restore tab order', err);
          }
          setComponents(allComponents);
        }
      } catch (error: any) {
        if (!cancelled) {
          setComponents([]);
        }
      }
    };

    loadComponents();
    return () => { cancelled = true; };
  }, [neighborhoodName, activeModelName, availableComponentIds]);

  const handleTabDragStart = (e: React.DragEvent<HTMLDivElement>, tabId: string) => {
    setDraggedTabId(tabId);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('tabId', tabId);
    }
  };

  const localStorageKeyForModel = (modelName?: string) => `componentTabOrder:${String(modelName || '')}`;

  const saveTabOrder = (modelName: string | undefined, orderedComponents: CustomFactory[]) => {
    try {
      if (!modelName) return;
      if (typeof localStorage === 'undefined') return;
      const key = localStorageKeyForModel(modelName);
      const ids = orderedComponents.map((c) => c._id);
      localStorage.setItem(key, JSON.stringify(ids));
    } catch (err) {
      console.warn('Failed to save tab order', err);
    }
  };

  const handleTabDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
      e.preventDefault();
    }
  };

  const handleTabDrop = (e: React.DragEvent<HTMLDivElement>, targetTabId: string) => {
    e.preventDefault();
    const sourceTabId = e.dataTransfer?.getData('tabId');

    if (!sourceTabId || sourceTabId === targetTabId) {
      setDraggedTabId(null);
      return;
    }

    const sourceIndex = components.findIndex((c) => c._id === sourceTabId);
    const targetIndex = components.findIndex((c) => c._id === targetTabId);

    if (sourceIndex !== -1 && targetIndex !== -1) {
      const reordered = [...components];
      const [removed] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, removed);
      setComponents(reordered);
      saveTabOrder(activeModelName, reordered);
    }

    setDraggedTabId(null);
  };

  const handleTabDragEnd = () => {
    setDraggedTabId(null);
  };

  // Generate a description from available component data
  const getComponentDescription = (component: CustomFactory | null): string => {
    if (!component) return '';
    
    // Prefer explicit shortDescription
    if (component.shortDescription) {
      return component.shortDescription;
    }

    // Build description from available fields
    const parts: string[] = [];
    
    if (component.sourceColumnName) {
      parts.push(`Source: ${component.sourceColumnName}`);
    }
    
    if (component.parentFactoryName) {
      parts.push(`Parent: ${component.parentFactoryName}`);
    }
    
    if (component.rowCount) {
      parts.push(`Records: ${component.rowCount}`);
    }
    
    if (component.columns && component.columns.length > 0) {
      parts.push(`Columns: ${component.columns.join(', ')}`);
    }

    return parts.length > 0 ? parts.join(' | ') : 'No description available';
  };

  // Handle tree node selection to show metadata
  const handleNodeSelect = async (selectedKeys: React.Key[]) => {
    const nodeKey = selectedKeys[0];
    setSelectedNodeKey(nodeKey);

    if (!nodeKey) {
      setShowMetadataDrawer(false);
      setSelectedNodeQualifiers({});
      setSelectedSystemComponentRecord(null);
      return;
    }

    // Find the matching node directly from the treeData using the pathKey
    const findNodeByKey = (nodes: DataNode[], key: React.Key): any => {
      for (const n of nodes) {
        if (n.key === key) return (n as any).data;
        if (n.children) {
          const found = findNodeByKey(n.children, key);
          if (found) return found;
        }
      }
      return null;
    };

    const selectedNodeInfo = findNodeByKey(treeData, nodeKey);
    setSelectedNodeQualifiers(selectedNodeInfo?.qualifiers || {});

    // Clicking an Application (or a linked-type node under one) both selects it and
    // reveals its linked System Components — driven explicitly here rather than via
    // AntD's built-in expandAction="click", which raced against our async treeData
    // update and made the node snap back to collapsed right after loading.
    if (selectedNodeInfo?.isApplicationNode || selectedNodeInfo?.isSystemComponentTypeNode) {
      if (loadedNodeKeysRef.current.has(nodeKey)) {
        // Already loaded — a click now just toggles expand/collapse like any other node.
        setExpandedKeys((prev) => (prev.includes(nodeKey) ? prev.filter((k) => k !== nodeKey) : [...prev, nodeKey]));
      } else {
        const children = await loadChildrenForNode(nodeKey, selectedNodeInfo);
        if (children) setTreeData((prev) => setNodeChildren(prev, nodeKey, children));
        setExpandedKeys((prev) => (prev.includes(nodeKey) ? prev : [...prev, nodeKey]));
      }
    }

    // A linked System Component record (e.g. a specific server or software install
    // under an Application) — populate the right column with its raw field values
    // instead of trying to resolve it as a model-hierarchy component.
    if (selectedNodeInfo?.isSystemComponentRecord && selectedNodeInfo.record) {
      setSelectedSystemComponentRecord(selectedNodeInfo.record);
      setSelectedComponent(null);
      setShowMetadataDrawer(true);
      return;
    }
    setSelectedSystemComponentRecord(null);

    const componentId = selectedNodeInfo?.componentId ? String(selectedNodeInfo.componentId) : undefined;

    if (componentId) {
      setLoadingMetadata(true);
      try {
        let component = await getCustomFactoryForModel(componentId, activeModelName);

        // If this component has FK columns, follow the FK to get enriched metadata
        if (component.foreignKeyColumns && component.foreignKeyColumns.length > 0) {
          const fk = component.foreignKeyColumns[0];
          // FK targetScope holds the linked component name (e.g. "Application" → applications collection)
          const targetScope = fk.targetScope?.toLowerCase();
          if (targetScope === 'application' && selectedNodeInfo?.rowName) {
            try {
              const appData = await getApplicationByName(selectedNodeInfo.rowName, activeModelName || neighborhoodName);
              component = {
                ...component,
                name: appData.name,
                shortDescription: appData.shortDescription,
                applicationType: appData.applicationType,
                businessCriticality: appData.businessCriticality,
                owner: appData.owner,
                createdBy: appData.createdBy,
                ...({ acronym: appData.acronym, lifecycle: appData.lifecycle, lifecycleStatus: appData.lifecycleStatus, applPurpose: appData.applPurpose, businessPurpose: appData.businessPurpose } as any),
              };
            } catch (error: any) {
              // Silent fail - component exists but may not have enriched metadata
            }
          }
        } else if (selectedNodeInfo?.componentName === 'application') {
          // No FK column but it's an application node — try direct lookup by name
            try {
              const appData = await getApplicationByName(selectedNodeInfo.rowName, activeModelName || neighborhoodName);
            component = {
              ...component,
              name: appData.name,
              shortDescription: appData.shortDescription,
              applicationType: appData.applicationType,
              businessCriticality: appData.businessCriticality,
              owner: appData.owner,
              ...({ acronym: appData.acronym, lifecycle: appData.lifecycle, lifecycleStatus: appData.lifecycleStatus, applPurpose: appData.applPurpose, businessPurpose: appData.businessPurpose } as any),
            };
          } catch (error: any) {
            // Silent fail - component exists but may not have enriched metadata
          }
        }

        setSelectedComponent(component);
        setShowMetadataDrawer(true);
      } catch (error: any) {
        console.error('Error fetching metadata:', error);
        // If component not found, still show drawer with available node info
        setSelectedComponent({
          name: selectedNodeInfo?.rowName,
          sourceColumnName: selectedNodeInfo?.componentName,
          neighborhoodName: neighborhoodName,
        } as any);
        setShowMetadataDrawer(true);
      } finally {
        setLoadingMetadata(false);
      }
    } else if (selectedNodeInfo) {
      // Show drawer with available node info even if no componentId
      setSelectedComponent({
        name: selectedNodeInfo.rowName,
        sourceColumnName: selectedNodeInfo.componentName,
        neighborhoodName: neighborhoodName,
      } as any);
      setShowMetadataDrawer(true);
    }
  };

  // Deterministic color selection for model badges
  const modelColors = ['#FFB6C1', '#BFEFFF', '#E6E6FA', '#FFF5BA', '#D1F2EB', '#FDE2C9', '#E0F7FA'];
  const getColorForModel = (name: string | undefined) => {
    if (!name) return modelColors[0];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return modelColors[h % modelColors.length];
  };

  const getSequenceQualifier = (component: CustomFactory): number => {
    const candidateValues = [
      component.rows?.[0]?.values?.l0_sequence_qualifier,
      component.rows?.[0]?.values?.['L0 sequence Qualifier'],
      component.rows?.[0]?.values?.l1_sequence_qualifier,
      component.rows?.[0]?.values?.['L1 sequence Qualifier'],
      component.rows?.[0]?.values?.sequence_qualifier,
      component.rows?.[0]?.values?.['sequence Qualifier'],
      component.rows?.[0]?.values?.sequence,
    ];

    for (const candidate of candidateValues) {
      if (candidate === null || candidate === undefined || candidate === '') continue;
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }

    return Number.MAX_SAFE_INTEGER;
  };

  const orderedComponents = useMemo(() => {
    return [...components].sort((left, right) => {
      const leftSequence = getSequenceQualifier(left);
      const rightSequence = getSequenceQualifier(right);
      if (leftSequence !== rightSequence) return leftSequence - rightSequence;
      return String(left.name || '').localeCompare(String(right.name || ''));
    });
  }, [components]);

  const filteredComponents = useMemo(() => {
    if (!searchText.trim()) return components;
    const normalized = searchText.toLowerCase();
    return orderedComponents.filter(
      (c) =>
        c.name.toLowerCase().includes(normalized) ||
        c.sourceColumnName?.toLowerCase().includes(normalized)
    );
  }, [orderedComponents, searchText]);

  // Controlled active tab: ensure active tab follows components list
  useEffect(() => {
    if (!activeTabKey && components && components.length > 0) {
      setActiveTabKey(components[0]._id);
    } else if (activeTabKey && !components.find((c) => c._id === activeTabKey)) {
      // If active tab was removed, reset to first
      setActiveTabKey(components[0]?._id);
    }
  }, [components, activeTabKey]);

  // Helper to extract all keys from tree data recursively
  const getAllTreeKeys = (nodes: DataNode[]): string[] => {
    const keys: string[] = [];
    const collect = (nodeList: DataNode[]) => {
      nodeList.forEach((node) => {
        if (node.key) keys.push(String(node.key));
        if (node.children) collect(node.children);
      });
    };
    collect(nodes);
    return keys;
  };

  // Build hierarchical tree from component hierarchies with ModelCatalog styling
  const baseTreeData = useMemo<DataNode[]>(() => {
    if (hierarchies.length === 0) {
      console.log(`[TreeBuilder] No hierarchies to render for ${activeModelName}`);
      return [];
    }

    console.log(`[TreeBuilder] Building tree from ${hierarchies.length} hierarchy paths for ${activeModelName}`);

    const pathToNode = new Map<string, DataNode>();
    const rootNodes: DataNode[] = [];
    let nodeId = 0;
    let nodeCount = 0;

    // Color arrays (matching ModelCatalog)
    const bgColors = ['#EFF6FF', '#F0FDF4', '#FEF3C7', '#FCE7F3', '#F3E8FF', '#ECFDF5'];
    const textColors = ['#0C63E4', '#15803D', '#B45309', '#BE185D', '#6D28D9', '#0891B2'];

    hierarchies.forEach((hierarchy, hierarchyIdx) => {
      const { nodes, pathStr } = hierarchy;
      let currentPath: string[] = [];

      nodes.forEach((node, depth) => {
        currentPath.push(node.rowName);
        
        // TRACE: Log Care nodes
        if (node.rowName === 'Care' || node.componentName === 'channel') {
          console.log(`[TreeBuilder] TRACE: Processing node:`, {
            componentName: node.componentName,
            rowName: node.rowName,
            depth,
            currentPath: currentPath.join(' > ')
          });
        }
        
        // Include model name in path key to avoid collisions across models
        const pathKey = `${activeModelName || ''}|${currentPath.join('|')}`;

        if (!pathToNode.has(pathKey)) {
          nodeCount++;
          const bgColor = bgColors[depth % bgColors.length];
          const textColor = textColors[depth % textColors.length];

          const badgeColor = getColorForModel(activeModelName);
          // Same "is this an Application node" check used to decide whether this node
          // should lazily expand into linked System Components (Servers, Software, ...).
          const isApplicationNode = /^applications?$/i.test(String(node.componentName || '').trim());
          const nodeTitle = (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', width: '100%', padding: '4px 8px' }}>
              <div
                style={{
                  minWidth: '120px',
                  maxWidth: '120px',
                  textAlign: 'left',
                  color: textColor,
                  fontSize: '12px',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  padding: '4px 8px',
                  backgroundColor: bgColor,
                  borderRadius: '4px',
                  flexShrink: 0,
                }}
              >
                {node.componentName}
              </div>
                <div style={{ fontSize: '13px', color: '#1E293B', fontWeight: 500, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.rowName}</div>
              </div>
            </div>
          );

          const newNode: DataNode = {
            key: pathKey,
            title: nodeTitle,
            children: [],
            // Application nodes are never true leaves — they can always expand into
            // their linked System Components (Servers, Software, ...), even when they're
            // the deepest level of the model hierarchy itself.
            isLeaf: isApplicationNode ? false : depth === nodes.length - 1,
            // Store node metadata for quick lookup on selection
            data: {
              componentName: node.componentName,
              rowName: node.rowName,
              rowId: node.rowId,
              componentId: node.componentId,
              modelName: activeModelName,
              qualifiers: node.qualifiers,
              isApplicationNode,
            },
          } as DataNode & { data: any };

          // TRACE: Log Care node creation
          if (node.rowName === 'Care') {
            console.log(`[TreeBuilder] ✅ CREATED Care node:`, { pathKey, isLeaf: newNode.isLeaf });
          }

          if (depth === 0) {
            rootNodes.push(newNode);
          } else {
            const parentPath = `${activeModelName || ''}|${currentPath.slice(0, depth).join('|')}`;
            const parentNode = pathToNode.get(parentPath);
            if (parentNode && parentNode.children) {
              parentNode.children.push(newNode);
              parentNode.isLeaf = false;
              if (node.rowName === 'Care') {
                console.log(`[TreeBuilder] ✅ ADDED Care as child of:`, parentPath);
              }
            }
          }

          pathToNode.set(pathKey, newNode);
        }
      });
    });

    console.log(`[TreeBuilder] ✅ FINAL: Created ${nodeCount} unique nodes, ${rootNodes.length} root nodes for ${activeModelName}`);

    // Sort root nodes alphabetically
    return rootNodes.sort((a, b) => {
      const aText = String(a.title);
      const bText = String(b.title);
      const aValue = aText.match(/\>([^<]+)<\/div>\s*<div/)?.[1] || '';
      const bValue = bText.match(/\>([^<]+)<\/div>\s*<div/)?.[1] || '';
      return String(aValue).localeCompare(String(bValue));
    });
  }, [hierarchies]);

  // treeData starts as the hierarchy-derived structure above, but is real state so
  // that expanding an Application node can graft in lazily-fetched linked System
  // Components children without rebuilding the whole tree.
  const [treeData, setTreeData] = useState<DataNode[]>([]);
  useEffect(() => {
    setTreeData(baseTreeData);
    loadedNodeKeysRef.current.clear();
  }, [baseTreeData]);

  // Immutably replaces the children of the node with the given key, anywhere in the tree.
  const setNodeChildren = (nodes: DataNode[], key: React.Key, children: DataNode[]): DataNode[] =>
    nodes.map((n) => {
      if (n.key === key) return { ...n, children };
      if (n.children && n.children.length) return { ...n, children: setNodeChildren(n.children, key, children) };
      return n;
    });

  const getLinkedApplicationTypes = async (): Promise<string[]> => {
    if (linkedApplicationTypesRef.current) return linkedApplicationTypesRef.current;
    const types = await getSystemComponentLinkedTypes('Applications').catch(() => []);
    linkedApplicationTypesRef.current = types;
    return types;
  };

  // Lazily fetches the children for an Application node (linked System Component
  // types) or a linked-type node (the actual records) the first time it's expanded.
  // Returns null when this node has nothing to lazily load (a normal hierarchy node,
  // or one already loaded).
  const loadChildrenForNode = async (nodeKey: React.Key, data: any): Promise<DataNode[] | null> => {
    if (loadedNodeKeysRef.current.has(nodeKey)) return null;

    if (data?.isApplicationNode) {
      loadedNodeKeysRef.current.add(nodeKey);
      let correlationId: string | null = null;
      try {
        const appData = await getApplicationByName(data.rowName, SYSTEM_COMPONENTS_NEIGHBORHOOD);
        correlationId = appData?.correlationId || null;
      } catch {
        // Not found in the System Components catalog — linked-type nodes will show "no records".
      }
      const types = await getLinkedApplicationTypes();
      if (!types.length) {
        return [{
          key: `${nodeKey}::no-links`,
          title: buildPlaceholderNodeTitle('No linked System Components'),
          isLeaf: true,
          selectable: false,
          data: { isPlaceholder: true },
        } as DataNode & { data: any }];
      }
      return types.map((componentType) => ({
        key: `${nodeKey}::type::${componentType}`,
        title: buildBadgeNodeTitle('LINKED', componentType, LINK_TYPE_BG, LINK_TYPE_TEXT),
        isLeaf: false,
        children: [],
        selectable: false,
        data: { isSystemComponentTypeNode: true, componentType, correlationId, componentName: componentType, rowName: componentType },
      }));
    }

    if (data?.isSystemComponentTypeNode) {
      loadedNodeKeysRef.current.add(nodeKey);
      const records = data.correlationId
        ? await getSystemComponentRecordsLinkedToApplication(data.componentType, data.correlationId).catch(() => [])
        : [];
      if (!records.length) {
        return [{
          key: `${nodeKey}::empty`,
          title: buildPlaceholderNodeTitle(`No ${String(data.componentType || '').toLowerCase()} linked`),
          isLeaf: true,
          selectable: false,
          data: { isPlaceholder: true },
        } as DataNode & { data: any }];
      }
      return records.map((record: LinkedSystemComponentRecord) => ({
        key: `${nodeKey}::record::${record.id}`,
        title: buildBadgeNodeTitle(data.componentType, record.name, LINK_RECORD_BG, LINK_RECORD_TEXT),
        isLeaf: true,
        data: { isSystemComponentRecord: true, record, componentName: data.componentType, rowName: record.name },
      }));
    }

    return null;
  };

  // Flatten tree nodes to suggestions for typeahead
  const flatTreeNodes = useMemo(() => {
    // Only flatten tree nodes if search is active and looking for tree results
    // This avoids expensive tree traversal when not needed
    if (!deferredSearchText.trim()) return [];
    
    const out: { key: string; label: string; data: any }[] = [];
    const seen = new Set<string>();
    const collect = (nodes?: DataNode[]) => {
      if (!nodes) return;
      nodes.forEach((n) => {
        const data = (n as any).data;
        const label = data ? `${data.componentName}: ${data.rowName}` : String(n.title);
        // dedupe by label to avoid repeated suggestions
        if (!seen.has(label)) {
          out.push({ key: String(n.key), label, data });
          seen.add(label);
        }
        if (n.children) collect(n.children);
      });
    };
    collect(treeData);
    return out;
  }, [treeData, deferredSearchText]);

  // Build typeahead options from components and tree nodes
  const searchOptions = useMemo(() => {
    const opts: { value: string; label: React.ReactNode }[] = [];
    
    // Only search if text is provided
    if (!deferredSearchText.trim()) return opts;
    
    const searchNorm = deferredSearchText.toLowerCase();

    // Helper to highlight matching text
    const highlightMatch = (text: string, query: string) => {
      const idx = text.toLowerCase().indexOf(query);
      if (idx === -1) return text;
      return (
        <>
          {text.substring(0, idx)}
          <span style={{ backgroundColor: '#ffd700', fontWeight: 700 }}>{text.substring(idx, idx + query.length)}</span>
          {text.substring(idx + query.length)}
        </>
      );
    };

    // Add component header
    const componentMatches = components.filter((c) => {
      const keyName = String(c.name || '').toLowerCase();
      return keyName.includes(searchNorm) || String(c.rowCount || '').includes(searchNorm);
    });

    if (componentMatches.length > 0) {
      opts.push({
        value: 'components-header',
        label: (
          <div style={{ padding: '6px 12px', backgroundColor: '#e0f2fe', fontWeight: 700, color: '#0369a1', fontSize: '12px', textTransform: 'uppercase', pointerEvents: 'none' }}>
            📦 Components
          </div>
        ),
      });

      const seenNames = new Set<string>();
      componentMatches.forEach((c) => {
        const keyName = String(c.name || '').toLowerCase();
        if (seenNames.has(keyName)) return;
        seenNames.add(keyName);

        opts.push({
          value: `comp:${c._id}`,
          label: (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginLeft: '12px' }}>
              <div style={{ fontWeight: 600 }}>{highlightMatch(c.name, deferredSearchText)}</div>
              <div style={{ color: '#888' }}>{c.rowCount}</div>
            </div>
          ),
        });
      });
    }

    // Tree nodes - limit to 20 results to avoid overwhelming dropdown
    const treeMatches = flatTreeNodes.filter((n) => n.label.toLowerCase().includes(searchNorm)).slice(0, 20);

    if (treeMatches.length > 0) {
      opts.push({
        value: 'tree-header',
        label: (
          <div style={{ padding: '6px 12px', backgroundColor: '#f0fdf4', fontWeight: 700, color: '#15803d', fontSize: '12px', textTransform: 'uppercase', pointerEvents: 'none', marginTop: '4px' }}>
            🌳 Hierarchy Nodes
          </div>
        ),
      });

      treeMatches.forEach((n) => {
        opts.push({
          value: `node:${n.key}`,
          label: (
            <div style={{ marginLeft: '12px' }}>
              {highlightMatch(n.label, deferredSearchText)}
            </div>
          ),
        });
      });
    }

    return opts;
  }, [components, flatTreeNodes, deferredSearchText]);

  const computeParentKeysForPath = (pathKey: string) => {
    // pathKey format: `${modelName}|A|B|C`
    const parts = String(pathKey).split('|');
    const out: string[] = [];
    for (let i = 1; i <= parts.length - 1; i++) {
      out.push(parts.slice(0, i + 1).join('|'));
    }
    return out;
  };

  // Handle clicking on an ancestry path cell to navigate to that component with row filtered
  const handleAncestryPathCellClick = (componentId: string, rowName: string) => {
    setViewMode('table');
    setActiveTabKey(componentId);
    setHighlightedComponentId(componentId);
    setHighlightedRowName(rowName);
  };

  const handleSuggestionSelect = (value: string) => {
    if (!value) return;
    // Ignore header clicks
    if (value.endsWith('-header')) return;
    
    if (value.startsWith('comp:')) {
      const id = value.slice('comp:'.length);
      setViewMode('table');
      setActiveTabKey(id);
      setHighlightedComponentId(id);
      setAncestryPaths(null);
      // also focus search text
      const target = components.find((c) => c._id === id);
      if (target) setSearchText(target.name);
    } else if (value.startsWith('node:')) {
      const key = value.slice('node:'.length);
      // If node selected, prefer showing the component tab and the specific row
      const node = flatTreeNodes.find((n) => n.key === key);
      if (node) {
        setSearchText(node.label as string);
        const selectedComponentName = node.data?.componentName ? String(node.data.componentName) : null;
        const selectedRowName = node.data?.rowName ? String(node.data.rowName) : null;

        // Find ALL hierarchy paths that include this node (for multiple lineages).
        // Match by componentName + rowName because canonical component types are
        // strings (not ObjectIds), so node.componentId is null and cannot be relied on.
        const matchingHierarchies = hierarchies.filter((h) =>
          h.nodes.some(
            (n) =>
              n.rowName === selectedRowName &&
              n.componentName === selectedComponentName
          )
        );

        if (matchingHierarchies.length > 0) {
          const paths = matchingHierarchies.map((h) =>
            h.nodes.map((n) => ({
              componentName: n.componentName,
              rowName: n.rowName,
              componentId: n.componentId ? String(n.componentId) : '',
            }))
          );
          // Deduplicate paths by serializing and comparing
          const uniquePaths = Array.from(
            new Map(paths.map((p) => [JSON.stringify(p), p])).values()
          );
          setAncestryPaths(uniquePaths);

          // Switch to the table view and, if we can resolve the component tab by
          // matching the component name to a loaded component, activate it.
          setViewMode('table');
          const targetComponent = selectedComponentName
            ? components.find((c) => c.name === selectedComponentName)
            : undefined;
          if (targetComponent) {
            setActiveTabKey(targetComponent._id);
            setHighlightedComponentId(targetComponent._id);
          }
          setHighlightedRowName(selectedRowName);
        } else {
          // No hierarchy paths matched — fall back to tree view and reveal the node.
          setViewMode('tree-vertical');
          const parents = computeParentKeysForPath(key as string);
          setExpandedKeys(parents);
          setSelectedNodeKey(key);
          setHighlightedComponentId(null);
          setHighlightedRowName(null);
          setAncestryPaths(null);
        }
      }
    }
  };

  // Clear highlighted component when search is cleared
  useEffect(() => {
    if (!searchText || !searchText.trim()) {
      setHighlightedComponentId(null);
      setHighlightedRowName(null);
      setAncestryPaths(null);
    }
  }, [searchText]);

  // Helper to extract correlation ID from component rows
  const getCorrelationIdFromComponent = (component: CustomFactory): string | null => {
    if (!component.rows || component.rows.length === 0) return null;
    const firstRow = component.rows[0];
    // Look for correlationId field in the row values
    const values = firstRow.values || {};
    const correlationId = values['correlationId'] || values['applicationCorrelationId'] || values['correlation_id'];
    return correlationId ? String(correlationId) : null;
  };

  // Handle clicking on component name to navigate to Data section
  const handleComponentNameClick = (component: CustomFactory, e: React.MouseEvent) => {
    if (!onApplicationLinkClick) return;
    e.preventDefault();
    // Don't stopPropagation - allow tab onClick to still work
    const correlationId = getCorrelationIdFromComponent(component);
    onApplicationLinkClick(component.name, correlationId, undefined);
  };

  // Auto-expand tree on load - expand root node.
  // Depends on baseTreeData (the hierarchy-derived source), not treeData — treeData
  // also changes when a lazily-loaded node's linked System Components get grafted
  // in, and re-running this on every one of those would reset expandedKeys back down
  // to just the root, collapsing whatever the user just expanded.
  useEffect(() => {
    if (baseTreeData && baseTreeData.length > 0) {
      setExpandedKeys([baseTreeData[0].key]);
    }
  }, [baseTreeData]);

  // Keep hierarchies in sync with components - if components are deleted, clear hierarchies
  useEffect(() => {
    if (!components || components.length === 0) {
      setHierarchies([]);
    }
  }, [components]);

  // Auto-scroll horizontal tree to keep the selected branch and newly revealed column visible.
  useEffect(() => {
    if (viewMode !== 'tree-horizontal') return;

    const revealKey = pendingHorizontalRevealKeyRef.current;
    const buttonToCenter = revealKey
      ? horizontalTreeNodeRefMap.current.get(revealKey)
      : selectedNodeKey
        ? horizontalTreeNodeRefMap.current.get(selectedNodeKey)
        : null;
    if (buttonToCenter && horizontalTreeContainerRef.current) {
      const rect = buttonToCenter.getBoundingClientRect();
      const containerRect = horizontalTreeContainerRef.current.getBoundingClientRect();
      const scrollLeft = horizontalTreeContainerRef.current.scrollLeft;
      const scrollTop = horizontalTreeContainerRef.current.scrollTop;

      const targetScrollLeft = scrollLeft + rect.left - containerRect.left - containerRect.width / 2 + rect.width / 2;
      const targetScrollTop = scrollTop + rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2;

      horizontalTreeContainerRef.current.scrollTo({
        left: Math.max(0, targetScrollLeft),
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth',
      });

      pendingHorizontalRevealKeyRef.current = null;
    }
  }, [selectedNodeKey, expandedKeys, viewMode]);

  const handleHorizontalPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = horizontalTreeContainerRef.current;
    if (!container) return;

    horizontalPanStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: container.scrollLeft,
      startScrollTop: container.scrollTop,
      moved: false,
    };
    setIsHorizontalPanning(true);
    // Don't capture the pointer yet — only do so once real dragging is detected.
    // Per the Pointer Events spec, click/mouseup events are redirected to the
    // capturing element while a pointer is captured, so capturing immediately
    // on pointerdown would break plain clicks (e.g. the expand/collapse arrow).
  };

  const handleHorizontalPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = horizontalPanStateRef.current;
    const container = horizontalTreeContainerRef.current;
    if (!state || !container || state.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    if (!state.moved && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
      state.moved = true;
      container.setPointerCapture?.(event.pointerId);
    }
    if (!state.moved) return;

    container.scrollLeft = state.startScrollLeft - deltaX;
    container.scrollTop = state.startScrollTop - deltaY;
  };

  const endHorizontalPointerPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = horizontalPanStateRef.current;
    const container = horizontalTreeContainerRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    if (container?.hasPointerCapture?.(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
    horizontalPanStateRef.current = null;
    setIsHorizontalPanning(false);
  };

  // Filter tree data based on search text — matches at any hierarchy level (Domain,
  // Subdomain, Business Process Flow, Task, Application), and a match keeps its full
  // branch down through Application so the whole path is visible, not just the
  // matched node itself.
  const filteredTreeData = useMemo<DataNode[]>(() => {
    if (!searchText.trim()) return treeData;

    const normalized = searchText.trim().toLowerCase();

    const filterNode = (node: DataNode): DataNode | null => {
      const nodeData = (node as DataNode & {
        data?: { rowName?: string; isSystemComponentTypeNode?: boolean; isSystemComponentRecord?: boolean; isPlaceholder?: boolean };
      }).data;

      // Linked System Components are reached by explicit click, not search.
      if (nodeData?.isSystemComponentTypeNode || nodeData?.isSystemComponentRecord || nodeData?.isPlaceholder) {
        return null;
      }

      const nodeText = String(nodeData?.rowName ?? '').toLowerCase();
      const matches = nodeText.includes(normalized);

      if (matches) {
        // Keep the matched node's subtree exactly as-is — including any linked System
        // Components the user has already manually expanded — so filtering never hides
        // content they explicitly loaded, and the expand arrow keeps working on it.
        return node;
      }

      const filteredChildren = node.children
        ? node.children
            .map((child) => filterNode(child))
            .filter((child) => child !== null) as DataNode[]
        : undefined;

      if (filteredChildren && filteredChildren.length > 0) {
        return {
          ...node,
          children: filteredChildren,
        };
      }

      return null;
    };

    return treeData
      .map((node) => filterNode(node))
      .filter((node) => node !== null) as DataNode[];
  }, [treeData, searchText]);

  // Auto-expand tree on search — expand exactly the branches that survived filtering
  // (ancestors of a match, plus the match's own path down through Application), not
  // the entire tree.
  useEffect(() => {
    if (!searchText.trim()) {
      if (baseTreeData.length > 0) setExpandedKeys([baseTreeData[0].key]);
      return;
    }
    const allKeys = filteredTreeData.flatMap((node) => {
      const keys: React.Key[] = [node.key];
      const collect = (n: DataNode) => {
        if (n.children) {
          n.children.forEach((child) => {
            keys.push(child.key);
            collect(child);
          });
        }
      };
      collect(node);
      return keys;
    });
    setExpandedKeys(allKeys);
  }, [filteredTreeData, searchText, baseTreeData]);

  const firstFilteredNodeKey = useMemo<React.Key | null>(() => {
    if (!searchText.trim()) return null;

    const normalized = searchText.trim().toLowerCase();
    const findFirstMatchKey = (nodes: DataNode[]): React.Key | null => {
      for (const node of nodes) {
        const nodeData = (node as DataNode & { data?: { rowName?: string } }).data;
        const nodeText = String(nodeData?.rowName ?? '').toLowerCase();
        if (nodeText.includes(normalized)) return node.key;
        if (node.children && node.children.length > 0) {
          const childMatch = findFirstMatchKey(node.children);
          if (childMatch) return childMatch;
        }
      }
      return null;
    };

    return findFirstMatchKey(filteredTreeData);
  }, [filteredTreeData, searchText]);

  useEffect(() => {
    if (!searchText.trim()) return;
    if (!firstFilteredNodeKey) return;
    setSearchHitNodeKey(firstFilteredNodeKey);
    setSelectedNodeKey(firstFilteredNodeKey);
  }, [firstFilteredNodeKey, searchText]);

  useEffect(() => {
    if (!searchText.trim()) {
      setSearchHitNodeKey(null);
    }
  }, [searchText]);

  // Render table view with all components as tabs
  const tableViewContent = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Ancestry paths as columnar table */}
      {ancestryPaths && ancestryPaths.length > 0 && (
        <div className="component-search-results" style={{ marginBottom: '16px', border: '1px solid #d9d9d9', borderRadius: '2px', maxHeight: '30vh', flexShrink: 0 }}>
          {/* Headers */}
          <div style={{ display: 'flex', backgroundColor: '#fafafa', borderBottom: '1px solid #d9d9d9' }}>
            {ancestryPaths[0]?.map((node, colIdx) => (
              <div
                key={`header-${colIdx}`}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRight: colIdx < ancestryPaths[0].length - 1 ? '1px solid #d9d9d9' : 'none',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#1e293b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  minWidth: '120px',
                }}
              >
                {node.componentName}
              </div>
            ))}
          </div>
          {/* Rows */}
          {ancestryPaths.map((path, rowIdx) => (
            <div
              key={`row-${rowIdx}`}
              style={{
                display: 'flex',
                borderBottom: rowIdx < ancestryPaths.length - 1 ? '1px solid #d9d9d9' : 'none',
                backgroundColor: rowIdx % 2 === 0 ? '#fff' : '#fafafa',
              }}
            >
              {path.map((node, colIdx) => (
                <div
                  key={`cell-${rowIdx}-${colIdx}`}
                  onClick={() => handleAncestryPathCellClick(node.componentId, node.rowName)}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRight: colIdx < path.length - 1 ? '1px solid #d9d9d9' : 'none',
                    cursor: 'pointer',
                    fontSize: '12px',
                    color: '#0050b3',
                    fontWeight: 500,
                    minWidth: '120px',
                    transition: 'background-color 0.2s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#e6f7ff')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = rowIdx % 2 === 0 ? '#fff' : '#fafafa')}
                >
                  {node.rowName}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {components && components.length > 0 ? (
        <Tabs
          className="components-table-view"
          style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
          activeKey={activeTabKey}
          onChange={(key) => {
            setViewMode('table');
            setActiveTabKey(key);
            // Clear highlight when switching tabs to show all tabs again
            setHighlightedComponentId(null);
            setHighlightedRowName(null);
          }}
          items={orderedComponents.map((component) => ({
          key: component._id,
          label: (
            <div
              draggable
              onDragStart={(e) => handleTabDragStart(e, component._id)}
              onDragOver={handleTabDragOver}
              onDrop={(e) => handleTabDrop(e, component._id)}
              onDragEnd={handleTabDragEnd}
              style={{
                cursor: draggedTabId === component._id ? 'grabbing' : 'grab',
                padding: '4px 8px',
                borderRadius: '4px',
                background: draggedTabId === component._id ? '#dbeafe' : undefined,
                border: draggedTabId === component._id ? '2px solid #3b82f6' : '1px solid transparent',
                opacity: draggedTabId === component._id ? 0.6 : 1,
                transition: 'all 0.2s ease-in-out',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  fontWeight: 500,
                }}
              >
                {component.name}
              </span>
              <span style={{ color: '#666', fontWeight: 'normal' }}>
                ({component.rowCount})
              </span>
            </div>
          ),
          children: renderComponentContent
            ? renderComponentContent(component._id, component.name, highlightedComponentId === component._id ? highlightedRowName : null)
            : (
                <div style={{ padding: '16px' }}>
                  {/* Default component view: show rows, and if highlightedRowName is set for this component, show only that row */}
                  {component.rows && component.rows.length > 0 ? (
                    <div>
                      {(highlightedComponentId === component._id && highlightedRowName)
                        ? component.rows.filter((r: any) => String(r.rowName).toLowerCase() === String(highlightedRowName).toLowerCase()).map((row: any, idx: number) => (
                            <div key={idx} style={{ marginBottom: '8px', padding: '8px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                              <strong>{row.rowName}</strong>
                              <div style={{ marginTop: '4px', fontSize: '11px' }}>
                                {Object.entries(row.values || {}).map(([key, value]) => (
                                  <div key={key}><strong>{key}:</strong> {String(value || '—')}</div>
                                ))}
                              </div>
                            </div>
                          ))
                        : component.rows.slice(0, 5).map((row: any, idx: number) => (
                            <div key={idx} style={{ marginBottom: '8px', padding: '8px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                              <strong>{row.rowName}</strong>
                              <div style={{ marginTop: '4px', fontSize: '11px' }}>
                                {Object.entries(row.values || {}).map(([key, value]) => (
                                  <div key={key}><strong>{key}:</strong> {String(value || '—')}</div>
                                ))}
                              </div>
                            </div>
                          ))}
                      {component.rows.length > 5 && !(highlightedComponentId === component._id && highlightedRowName) && (
                        <div style={{ textAlign: 'center', color: '#999', fontSize: '12px', marginTop: '8px' }}>
                          +{component.rows.length - 5} more rows
                        </div>
                      )}
                    </div>
                  ) : (
                    <Empty description={`No data available for ${component.name}`} />
                  )}
                </div>
              ),
        }))}
        />
      ) : (
        <Empty description="No components available" style={{ marginTop: '40px' }} />
      )}
    </div>
  );

  // Horizontal tree view - graph diagram with SVG connectors (LOB Drill down style)
  const renderHorizontalTree = () => {
    const NODE_WIDTH = 140;
    const COLUMN_GAP = 280;
    const BETWEEN_GAP = 36;
    const PADDING = 40;

    // Measure actual text width with a canvas so height is correct for any name.
    // CONTENT_WIDTH is kept conservative (< real pixel width) so we always over-estimate
    // the number of wrapped lines, preventing the rendered box from exceeding nodeHeight.
    const CONTENT_WIDTH = 84; // conservative: NODE_WIDTH - button-padding - inner-padding - arrow
    const LINE_H = 20;         // 13px bold * 1.3 + rounding buffer
    const TYPE_H = 22;         // uppercase type label row (10px * 1.1 lh + wrap buffer)
    const BOX_PADDING = 32;    // top + bottom button + inner padding + gap buffer
    const _ctx = (() => {
      try { return (document.createElement('canvas') as HTMLCanvasElement).getContext('2d'); } catch { return null; }
    })();
    if (_ctx) _ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const measureLines = (name: string): number => {
      if (!_ctx || !name) return 1;
      const words = name.split(/\s+/);
      let lines = 1;
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (_ctx.measureText(test).width > CONTENT_WIDTH) {
          if (!line) {
            lines += Math.ceil(_ctx.measureText(word).width / CONTENT_WIDTH) - 1;
          } else {
            lines++;
          }
          line = word;
        } else {
          line = test;
        }
      }
      return lines;
    };
    const nodeHeight = (name: string) =>
      Math.max(56, BOX_PADDING + TYPE_H + measureLines(name) * LINE_H);

    // Color scheme matching vertical tree view
    const bgColors = ['#EFF6FF', '#F0FDF4', '#FEF3C7', '#FCE7F3', '#F3E8FF', '#ECFDF5'];
    const textColors = ['#0C63E4', '#15803D', '#B45309', '#BE185D', '#6D28D9', '#0891B2'];

    interface PositionedNode {
      node: DataNode;
      depth: number;
      y: number;
      h: number;
      parentKey: React.Key | null;
    }

    // Build positioned nodes — recurse children first so each parent centres over its subtree.
    const positioned: PositionedNode[] = [];
    const positionById = new Map<React.Key, { x: number; y: number; h: number }>();
    let maxDepth = 0;
    let maxY = 0;

    const traverse = (nodes: DataNode[], depth: number, parentKey: React.Key | null, yOffset: number): number => {
      let currentY = yOffset;
      let lastBottom = yOffset;
      maxDepth = Math.max(maxDepth, depth);

      for (const node of nodes) {
        const data = (node as any).data;
        const name = data?.rowName || String(node.key);
        const h = nodeHeight(name);
        const nodeX = depth * COLUMN_GAP + PADDING;

        if (expandedKeys.includes(node.key) && node.children && node.children.length > 0) {
          const childrenStartY = currentY;
          const childrenLastBottom = traverse(node.children, depth + 1, node.key, currentY);

          const mid = (childrenStartY + childrenLastBottom) / 2;
          const nodeY = Math.max(childrenStartY, mid - h / 2);

          positioned.push({ node, depth, y: nodeY, h, parentKey });
          positionById.set(node.key, { x: nodeX, y: nodeY, h });

          lastBottom = Math.max(childrenLastBottom, nodeY + h);
          maxY = Math.max(maxY, lastBottom);
          currentY = lastBottom + BETWEEN_GAP;
        } else {
          positioned.push({ node, depth, y: currentY, h, parentKey });
          positionById.set(node.key, { x: nodeX, y: currentY, h });
          lastBottom = currentY + h;
          maxY = Math.max(maxY, lastBottom);
          currentY = lastBottom + BETWEEN_GAP;
        }
      }
      return lastBottom;
    };

    traverse(filteredTreeData, 0, null, PADDING);

    const width = (maxDepth + 1) * COLUMN_GAP + PADDING * 2;
    const height = Math.max(600, maxY + PADDING);

    return (
      <div
        ref={horizontalTreeContainerRef}
        onPointerDown={handleHorizontalPointerDown}
        onPointerMove={handleHorizontalPointerMove}
        onPointerUp={endHorizontalPointerPan}
        onPointerCancel={endHorizontalPointerPan}
        onPointerLeave={endHorizontalPointerPan}
        style={{
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          position: 'relative',
          backgroundColor: '#f8fafc',
          borderRadius: '6px',
          cursor: isHorizontalPanning ? 'grabbing' : 'grab',
          userSelect: isHorizontalPanning ? 'none' : 'auto',
        }}
      >
        <div style={{ position: 'relative', width, height }}>
          <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
            {positioned
              .filter((p) => p.parentKey !== null)
              .map((p) => {
                const from = positionById.get(p.parentKey!);
                const to = positionById.get(p.node.key);
                if (!from || !to) return null;

                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + from.h / 2;
                const x2 = to.x;
                const y2 = to.y + to.h / 2;
                const c1 = x1 + 60;
                const c2 = x2 - 60;
                const path = `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;

                const lineColor = textColors[p.depth % textColors.length];

                return (
                  <path
                    key={`line-${p.parentKey}-${p.node.key}`}
                    d={path}
                    stroke={lineColor}
                    strokeWidth="2"
                    fill="none"
                    opacity="0.5"
                  />
                );
              })}
          </svg>

          {positioned.map((p) => {
            const pos = positionById.get(p.node.key)!;
            const nodeData = (p.node as any).data;
            const isSelected = selectedNodeKey === p.node.key;
            const nodeSearchText = String(nodeData?.rowName || '').toLowerCase();
            const isSearchHit = Boolean(searchText.trim()) && nodeSearchText.includes(searchText.trim().toLowerCase());
            const isExpanded = expandedKeys.includes(p.node.key);
            const hasChildren = p.node.children && p.node.children.length > 0;
            const label = nodeData?.componentName || 'Label';
            const value = nodeData?.rowName || (typeof p.node.title === 'function' ? p.node.title({ title: 'Node' } as any) : p.node.title);
            const isLazyNode = Boolean(nodeData?.isApplicationNode || nodeData?.isSystemComponentTypeNode);
            const isSelectable = !nodeData?.isSystemComponentTypeNode && !nodeData?.isPlaceholder;
            const isExpandable = hasChildren || (isLazyNode && !loadedNodeKeysRef.current.has(p.node.key));

            const bgColor = bgColors[p.depth % bgColors.length];
            const textColor = textColors[p.depth % textColors.length];

            // Single shared expand/collapse path for both the whole-box click and the
            // arrow's own click — lazily fetches linked System Components the first
            // time an Application or type node is expanded, then behaves as a normal
            // toggle once children are present.
            const expandOrToggleNode = async () => {
              if (!hasChildren && isLazyNode && !loadedNodeKeysRef.current.has(p.node.key)) {
                const children = await loadChildrenForNode(p.node.key, nodeData);
                if (children) {
                  setTreeData((prev) => setNodeChildren(prev, p.node.key, children));
                  pendingHorizontalRevealKeyRef.current = children[0]?.key ?? p.node.key;
                  setExpandedKeys((previousKeys) => (previousKeys.includes(p.node.key) ? previousKeys : [...previousKeys, p.node.key]));
                }
                return;
              }

              if (hasChildren) {
                if (!isExpanded) {
                  const firstChildKey = p.node.children?.[0]?.key;
                  pendingHorizontalRevealKeyRef.current = firstChildKey || p.node.key;
                }
                setExpandedKeys((previousKeys) =>
                  previousKeys.includes(p.node.key)
                    ? previousKeys.filter((key) => key !== p.node.key)
                    : [...previousKeys, p.node.key]
                );
              }
            };

            return (
              <button
                key={p.node.key}
                ref={(el) => {
                  if (el) {
                    horizontalTreeNodeRefMap.current.set(p.node.key, el);
                  } else {
                    horizontalTreeNodeRefMap.current.delete(p.node.key);
                  }
                }}
                type="button"
                onClick={async () => {
                  if (horizontalPanStateRef.current?.moved) return;
                  if (isSelectable) handleNodeSelect([p.node.key]);
                  await expandOrToggleNode();
                }}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: NODE_WIDTH,
                  height: p.h,
                  overflow: 'hidden',
                  borderRadius: 8,
                  border: isSearchHit ? '3px solid #eab308' : isSelected ? '2px solid #0284c7' : `2px solid ${textColor}`,
                  background: isSelected ? '#ecf0f5' : bgColor,
                  boxShadow: isSearchHit ? '0 0 0 3px rgba(234, 179, 8, 0.18), 0 2px 8px rgba(15, 23, 42, 0.12)' : '0 2px 8px rgba(15, 23, 42, 0.06)',
                  padding: '8px',
                  cursor: 'pointer',
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gridTemplateRows: 'auto 1fr',
                  gap: 4,
                  fontFamily: 'inherit',
                  transition: 'all 0.2s',
                  alignItems: 'start',
                  whiteSpace: 'normal',
                }}
              >
                <div style={{ gridColumn: '1 / 2', gridRow: '1 / 3', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4px', gap: '3px' }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: textColor,
                      textTransform: 'uppercase',
                      letterSpacing: 0.3,
                      textAlign: 'center',
                      lineHeight: '1.1',
                      wordBreak: 'break-word',
                    }}
                  >
                    {label}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: textColor,
                      whiteSpace: 'normal',
                      wordBreak: 'break-word',
                      textAlign: 'center',
                      lineHeight: '1.3',
                      width: '100%',
                    }}
                  >
                    {renderHighlightedText(String(value || ''), searchText)}
                  </div>
                </div>
                {isExpandable && (
                  <span
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (horizontalPanStateRef.current?.moved) return;
                      if (isSelectable) setSelectedNodeKey(p.node.key);
                      await expandOrToggleNode();
                    }}
                    style={{
                      gridColumn: '2 / 3',
                      gridRow: '1 / 2',
                      color: textColor,
                      fontSize: 11,
                      cursor: 'pointer',
                      padding: '2px 2px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      userSelect: 'none',
                    }}
                  >
                    {isExpanded ? '▾' : '▸'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  // Render tree view
  const treeViewContent = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {hierarchies && hierarchies.length > 0 ? (
        <div className={`component-search-results${viewMode === 'tree-horizontal' ? ' horizontal-tree-scroll' : ''}`} style={{ flex: 1, paddingRight: '4px' }}>
          {viewMode === 'tree-vertical' ? (
            <Tree
              treeData={filteredTreeData}
              expandedKeys={expandedKeys}
              onExpand={setExpandedKeys}
              selectedKeys={selectedNodeKey ? [selectedNodeKey] : []}
              onSelect={handleNodeSelect}
              loadData={async (node) => {
                const children = await loadChildrenForNode(node.key, (node as any).data);
                if (children) {
                  setTreeData((prev) => setNodeChildren(prev, node.key, children));
                  // Explicitly keep this node expanded ourselves rather than relying on
                  // AntD's own post-loadData expand — with controlled expandedKeys that
                  // implicit behavior raced against our treeData update and the node
                  // snapped back to collapsed right after loading.
                  setExpandedKeys((prev) => (prev.includes(node.key) ? prev : [...prev, node.key]));
                }
              }}
              style={{ padding: '8px 0' }}
            />
          ) : (
            renderHorizontalTree()
          )}
        </div>
      ) : (
        <Empty description="No components available" style={{ marginTop: '40px' }} />
      )}
    </div>
  );

  return (
    <Card
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '16px' }}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          value={viewMode}
          onChange={(value) => setViewMode(value as 'table' | 'tree-vertical' | 'tree-horizontal')}
          options={[
            { label: <><BarsOutlined /> Tree (Horizontal)</>, value: 'tree-horizontal' },
            { label: <><UnorderedListOutlined /> Tree</>, value: 'tree-vertical' },
            { label: <><TableOutlined /> Table</>, value: 'table' },
          ]}
        />
        {(viewMode === 'tree-vertical' || viewMode === 'tree-horizontal') ? (
          <>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Search tree"
              style={{ width: 240 }}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <Button size="small" onClick={() => {
              const allKeys = filteredTreeData.flatMap((node) => {
                const keys: React.Key[] = [node.key];
                const collect = (n: DataNode) => { if (n.children) n.children.forEach((c) => { keys.push(c.key); collect(c); }); };
                collect(node);
                return keys;
              });
              setExpandedKeys(allKeys);
            }}>Expand All</Button>
            <Button size="small" onClick={() => setExpandedKeys([])}>Collapse All</Button>
          </>
        ) : null}
      </Space>
      <Spin spinning={loading} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {viewMode !== 'table' ? treeViewContent : tableViewContent}
        </div>
      </Spin>

      {/* Metadata Drawer */}
      <Drawer
        title={selectedSystemComponentRecord ? selectedSystemComponentRecord.name : 'Component Metadata'}
        placement="right"
        onClose={() => setShowMetadataDrawer(false)}
        open={showMetadataDrawer}
        width={450}
        loading={loadingMetadata}
      >
        <Spin spinning={loadingMetadata}>
          {selectedSystemComponentRecord ? (
            <div>
              <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: LINK_RECORD_BG, borderLeft: `3px solid ${LINK_RECORD_TEXT}`, borderRadius: '4px' }}>
                <strong>{selectedSystemComponentRecord.name}</strong>
              </div>
              <Descriptions bordered size="small" column={1}>
                {Object.entries(selectedSystemComponentRecord.values)
                  .filter(([, value]) => !(typeof value === 'string' && isKeyLikeString(value)))
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, value]) => (
                    <Descriptions.Item key={key} label={toLabel(key)}>
                      {renderFieldValue(value)}
                    </Descriptions.Item>
                  ))}
              </Descriptions>
            </div>
          ) : selectedComponent ? (
            <div>
              <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f0f5ff', borderLeft: '3px solid #1890ff', borderRadius: '4px' }}>
                <strong>Description:</strong>
                <div style={{ marginTop: '8px', fontSize: '13px', color: '#595959' }}>
                  {getComponentDescription(selectedComponent)}
                </div>
              </div>

              {Object.entries(selectedNodeQualifiers).filter(([, value]) => String(value || '').trim()).length > 0 && (
                <>
                  <Divider style={{ margin: '12px 0' }}>Attributes</Divider>
                  <Descriptions bordered size="small" column={1} style={{ marginBottom: '16px' }}>
                    {Object.entries(selectedNodeQualifiers)
                      .filter(([, value]) => String(value || '').trim())
                      .map(([key, value]) => (
                        <Descriptions.Item key={key} label={qualifierLabel(key)}>
                          {value}
                        </Descriptions.Item>
                      ))}
                  </Descriptions>
                </>
              )}

              <Divider style={{ margin: '12px 0' }} />

              <Descriptions bordered size="small" column={1} style={{ marginBottom: '16px' }}>
                <Descriptions.Item label="Name" labelStyle={{ fontWeight: 600 }}>
                  {selectedComponent.name}
                </Descriptions.Item>
                <Descriptions.Item label="Neighborhood">
                  {selectedComponent.neighborhoodName || 'N/A'}
                </Descriptions.Item>
                {selectedComponent.applicationType && (
                  <Descriptions.Item label="Type">
                    <Tag color="blue">{selectedComponent.applicationType}</Tag>
                  </Descriptions.Item>
                )}
                {selectedComponent.businessCriticality && (
                  <Descriptions.Item label="Criticality">
                    <Tag color={selectedComponent.businessCriticality === 'high' ? 'red' : selectedComponent.businessCriticality === 'medium' ? 'orange' : 'default'}>
                      {selectedComponent.businessCriticality}
                    </Tag>
                  </Descriptions.Item>
                )}
                {(selectedComponent as any).lifecycle && (
                  <Descriptions.Item label="Lifecycle">
                    {(selectedComponent as any).lifecycle}
                  </Descriptions.Item>
                )}
                {(selectedComponent as any).lifecycleStatus && (
                  <Descriptions.Item label="Lifecycle Status">
                    {(selectedComponent as any).lifecycleStatus}
                  </Descriptions.Item>
                )}
                {(selectedComponent as any).acronym && (
                  <Descriptions.Item label="Acronym">
                    <Tag>{(selectedComponent as any).acronym}</Tag>
                  </Descriptions.Item>
                )}
                {(selectedComponent as any).applPurpose && (
                  <Descriptions.Item label="Purpose">
                    {(selectedComponent as any).applPurpose}
                  </Descriptions.Item>
                )}
                {(selectedComponent as any).businessPurpose && (
                  <Descriptions.Item label="Business Purpose">
                    {(selectedComponent as any).businessPurpose}
                  </Descriptions.Item>
                )}
                <Descriptions.Item label="Source Column">
                  {selectedComponent.sourceColumnName || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="Owner">
                  {selectedComponent.owner || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="Created At">
                  {selectedComponent.createdAt
                    ? new Date(selectedComponent.createdAt).toLocaleString()
                    : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="Row Count">
                  <Badge count={selectedComponent.rowCount} style={{ backgroundColor: '#52c41a' }} />
                </Descriptions.Item>
              </Descriptions>

              {selectedComponent.columns && selectedComponent.columns.length > 0 && (
                <>
                  <Divider>Columns</Divider>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '16px' }}>
                    {selectedComponent.columns.map((col) => (
                      <Tag key={col} color="blue">
                        {col}
                      </Tag>
                    ))}
                  </div>
                </>
              )}

              {selectedComponent.qualifierColumns && selectedComponent.qualifierColumns.length > 0 && (
                <>
                  <Divider>Qualifier Columns</Divider>
                  <Collapse
                    items={selectedComponent.qualifierColumns.map((qc) => ({
                      key: qc.name,
                      label: qc.name,
                      children: (
                        <Descriptions bordered size="small" column={1}>
                          <Descriptions.Item label="Source Column">
                            {qc.sourceColumnName}
                          </Descriptions.Item>
                          <Descriptions.Item label="Field Name">
                            {qc.fieldName}
                          </Descriptions.Item>
                        </Descriptions>
                      ),
                    }))}
                    size="small"
                  />
                </>
              )}

              {selectedComponent.foreignKeyColumns && selectedComponent.foreignKeyColumns.length > 0 && (
                <>
                  <Divider>Foreign Keys</Divider>
                  <Collapse
                    items={selectedComponent.foreignKeyColumns.map((fk) => ({
                      key: fk.name,
                      label: fk.name,
                      children: (
                        <Descriptions bordered size="small" column={1}>
                          <Descriptions.Item label="Source Column">
                            {fk.sourceColumnName}
                          </Descriptions.Item>
                          <Descriptions.Item label="Field Name">
                            {fk.fieldName}
                          </Descriptions.Item>
                          <Descriptions.Item label="Target Reference">
                            {fk.targetReference || '—'}
                          </Descriptions.Item>
                          <Descriptions.Item label="Target Group">
                            {fk.targetGroup || '—'}
                          </Descriptions.Item>
                        </Descriptions>
                      ),
                    }))}
                    size="small"
                  />
                </>
              )}

              {selectedComponent.rowCount > 0 && (
                <>
                  <Divider>Sample Rows ({selectedComponent.rowCount} total)</Divider>
                  <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '12px' }}>
                    {selectedComponent.rows?.slice(0, 5).map((row, idx) => (
                      <div key={idx} style={{ marginBottom: '8px', padding: '8px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
                        <strong>Row {idx + 1}</strong>
                        <div style={{ marginTop: '4px', fontSize: '11px' }}>
                          {Object.entries(row.values || {}).map(([key, value]) => (
                            <div key={key}>
                              <strong>{key}:</strong> {String(value || '—')}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {selectedComponent.rowCount > 5 && (
                      <div style={{ textAlign: 'center', color: '#999', fontSize: '12px', marginTop: '8px' }}>
                        +{selectedComponent.rowCount - 5} more rows
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <Empty description="Select a component to view metadata" />
          )}
        </Spin>
      </Drawer>

    </Card>
  );
}
