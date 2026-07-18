import { useEffect, useMemo, useState, useDeferredValue, useRef } from 'react';
import { App as AntApp, Card, Space, Spin, Tree, Button, Segmented, Tabs, Empty, AutoComplete, Input, Drawer, Divider, Descriptions, Badge, Tag, Collapse, Select } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { FolderOutlined, TableOutlined, SearchOutlined, CloseOutlined, BarsOutlined, UnorderedListOutlined } from '@ant-design/icons';

import { getCustomFactories, getComponentHierarchies, getCustomFactory, getCustomFactoryForModel, getApplicationByCorrelationId, getApplicationByName, getFactoryNeighborhoods, getLeafComponent, getCanonicalFactories } from '../api';
import type { CustomFactory, CustomFactoryRow, HierarchyPath } from '../types';

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
  const [hierarchies, setHierarchies] = useState<HierarchyPath[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [activeModelName, setActiveModelName] = useState<string>(neighborhoodName || '');
  const [components, setComponents] = useState<CustomFactory[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'tree-vertical' | 'tree-horizontal'>('tree-vertical');
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [searchText, setSearchText] = useState('');
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [selectedNodeKey, setSelectedNodeKey] = useState<React.Key | null>(null);
  const [selectedComponent, setSelectedComponent] = useState<CustomFactory | null>(null);
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
  const horizontalTreeNodeRefMap = useRef<Map<React.Key, HTMLButtonElement>>(new Map());

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
  const filteredComponents = useMemo(() => {
    if (!searchText.trim()) return components;
    const normalized = searchText.toLowerCase();
    return components.filter(
      (c) =>
        c.name.toLowerCase().includes(normalized) ||
        c.sourceColumnName?.toLowerCase().includes(normalized)
    );
  }, [components, searchText]);

  // Controlled active tab: ensure active tab follows components list
  useEffect(() => {
    if (!activeTabKey && components && components.length > 0) {
      setActiveTabKey(components[0]._id);
    } else if (activeTabKey && !components.find((c) => c._id === activeTabKey)) {
      // If active tab was removed, reset to first
      setActiveTabKey(components[0]?._id);
    }
  }, [components, activeTabKey]);

  // When the user selects a component tab, always start in the table view.
  useEffect(() => {
    if (!activeTabKey) return;
    setViewMode('table');
  }, [activeTabKey]);

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
  const treeData = useMemo<DataNode[]>(() => {
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
            isLeaf: depth === nodes.length - 1,
            // Store node metadata for quick lookup on selection
            data: {
              componentName: node.componentName,
              rowName: node.rowName,
              rowId: node.rowId,
              componentId: node.componentId,
              modelName: activeModelName,
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

  // Auto-expand tree on load - expand root node
  useEffect(() => {
    if (treeData && treeData.length > 0) {
      setExpandedKeys([treeData[0].key]);
    }
  }, [treeData]);

  // Auto-expand tree on search
  useEffect(() => {
    if (!treeData || treeData.length === 0) return;

    if (searchText.trim()) {
      // Expand all nodes when searching
      const allKeys = treeData
        .flatMap((node) => {
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
    } else {
      // Default: expand root level to show component types
      if (treeData.length > 0) {
        setExpandedKeys([treeData[0].key]);
      }
    }
  }, [treeData, searchText]);

  // Keep hierarchies in sync with components - if components are deleted, clear hierarchies
  useEffect(() => {
    if (!components || components.length === 0) {
      setHierarchies([]);
    }
  }, [components]);

  // Auto-scroll horizontal tree to keep selected/expanded node centered
  useEffect(() => {
    if (viewMode !== 'tree-horizontal') return;
    
    const buttonToCenter = selectedNodeKey ? horizontalTreeNodeRefMap.current.get(selectedNodeKey) : null;
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
    }
  }, [selectedNodeKey, expandedKeys, viewMode]);

  // Filter tree data based on search text
  const filteredTreeData = useMemo<DataNode[]>(() => {
    if (!searchText.trim()) return treeData;

    const normalized = searchText.toLowerCase();

    const filterNode = (node: DataNode): DataNode | null => {
      const nodeText = String(node.title).toLowerCase();
      const matches = nodeText.includes(normalized);

      const filteredChildren = node.children
        ? node.children
            .map((child) => filterNode(child))
            .filter((child) => child !== null) as DataNode[]
        : undefined;

      if (matches || (filteredChildren && filteredChildren.length > 0)) {
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
            setActiveTabKey(key);
            // Clear highlight when switching tabs to show all tabs again
            setHighlightedComponentId(null);
            setHighlightedRowName(null);
          }}
          items={components.map((component) => ({
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
        style={{
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          position: 'relative',
          backgroundColor: '#f8fafc',
          borderRadius: '6px',
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
            const isSelected = selectedNodeKey === p.node.key;
            const isExpanded = expandedKeys.includes(p.node.key);
            const hasChildren = p.node.children && p.node.children.length > 0;
            const nodeData = (p.node as any).data;
            const label = nodeData?.componentName || 'Label';
            const value = nodeData?.rowName || (typeof p.node.title === 'function' ? p.node.title({ title: 'Node' } as any) : p.node.title);
            
            const bgColor = bgColors[p.depth % bgColors.length];
            const textColor = textColors[p.depth % textColors.length];

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
                onClick={() => {
                  handleNodeSelect([p.node.key]);
                }}
                style={{
                  position: 'absolute',
                  left: pos.x,
                  top: pos.y,
                  width: NODE_WIDTH,
                  height: p.h,
                  overflow: 'hidden',
                  borderRadius: 8,
                  border: isSelected ? '2px solid #0284c7' : `2px solid ${textColor}`,
                  background: isSelected ? '#ecf0f5' : bgColor,
                  boxShadow: '0 2px 8px rgba(15, 23, 42, 0.06)',
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
                    {value}
                  </div>
                </div>
                {hasChildren && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedKeys(prev =>
                        prev.includes(p.node.key)
                          ? prev.filter(k => k !== p.node.key)
                          : [...prev, p.node.key]
                      );
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
        <div className="component-search-results" style={{ flex: 1, paddingRight: '4px' }}>
          {viewMode === 'tree-vertical' ? (
            <Tree
              treeData={filteredTreeData}
              expandedKeys={expandedKeys}
              onExpand={setExpandedKeys}
              selectedKeys={selectedNodeKey ? [selectedNodeKey] : []}
              onSelect={handleNodeSelect}
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
            { label: <><TableOutlined /> Table</>, value: 'table' },
            { label: <><UnorderedListOutlined /> Tree</>, value: 'tree-vertical' },
            { label: <><BarsOutlined /> Tree (Horizontal)</>, value: 'tree-horizontal' },
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
        title="Component Metadata"
        placement="right"
        onClose={() => setShowMetadataDrawer(false)}
        open={showMetadataDrawer}
        width={450}
        loading={loadingMetadata}
      >
        <Spin spinning={loadingMetadata}>
          {selectedComponent ? (
            <div>
              <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f0f5ff', borderLeft: '3px solid #1890ff', borderRadius: '4px' }}>
                <strong>Description:</strong>
                <div style={{ marginTop: '8px', fontSize: '13px', color: '#595959' }}>
                  {getComponentDescription(selectedComponent)}
                </div>
              </div>
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
