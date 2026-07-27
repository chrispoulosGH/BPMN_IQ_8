import { memo, useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { App as AntApp, Card, Input, Select, Space, Spin, Switch, Table, Tree, Button, Segmented, Checkbox, Popover } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DataNode } from 'antd/es/tree';
import { SearchOutlined, FolderOutlined, TableOutlined, BarsOutlined, UnorderedListOutlined } from '@ant-design/icons';

import { getModelCatalog, getModelCatalogTree, getModelCatalogTreeChildren, searchModelCatalogTree, type ModelCatalogRow } from '../api';
import type { CatalogTreeNode, ModelCatalog } from '../types';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';
import { loadFkValidationValues, normalizeFkToken, parseFkColumnHeader } from '../utils/fkValidation';

const CATALOG_PAGE_SIZE = 50;

// Insert freshly-loaded children into a lazy tree at the matching node key.
function insertChildrenAt(nodes: CatalogTreeNode[], key: string, children: CatalogTreeNode[]): CatalogTreeNode[] {
  return nodes.map((node) => {
    if (node.key === key) return { ...node, children };
    if (node.children && node.children.length) {
      return { ...node, children: insertChildrenAt(node.children, key, children) };
    }
    return node;
  });
}

// Build a nested tree from flat search-result paths.
function buildTreeFromPaths(paths: { name: string; typeName: string; depth: number }[][]): CatalogTreeNode[] {
  const map = new Map<string, CatalogTreeNode>();
  const roots: CatalogTreeNode[] = [];
  for (const path of paths) {
    const parts: string[] = [];
    for (const node of path) {
      parts.push(node.name);
      const key = parts.join('|');
      if (!map.has(key)) {
        const created: CatalogTreeNode = { key, name: node.name, typeName: node.typeName, depth: node.depth, isLeaf: false, children: [] };
        map.set(key, created);
        if (node.depth === 0) roots.push(created);
        else {
          const parent = map.get(parts.slice(0, node.depth).join('|'));
          if (parent) parent.children!.push(created);
        }
      }
    }
  }
  const markLeaves = (list: CatalogTreeNode[]) => {
    list.forEach((n) => {
      n.isLeaf = !n.children || n.children.length === 0;
      if (n.children) markLeaves(n.children);
    });
  };
  markLeaves(roots);
  return roots;
}


const TREE_BG_COLORS = ['#EFF6FF', '#F0FDF4', '#FEF3C7', '#FCE7F3', '#F3E8FF', '#ECFDF5'];
const TREE_TEXT_COLORS = ['#0C63E4', '#15803D', '#B45309', '#BE185D', '#6D28D9', '#0891B2'];

function renderHighlightedTreeText(text: string, query: string) {
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
}

function makeTreeTitle(typeName: string, name: string, depth: number) {
  const bgColor = TREE_BG_COLORS[depth % TREE_BG_COLORS.length];
  const textColor = TREE_TEXT_COLORS[depth % TREE_TEXT_COLORS.length];
  return (
    <div style={{ display: 'flex', gap: '24px', alignItems: 'center', width: '100%', padding: '4px 8px' }}>
      <div
        style={{
          minWidth: '130px',
          maxWidth: '130px',
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
        {typeName}
      </div>
      <div style={{ fontSize: '13px', color: '#1E293B', fontWeight: 500 }}>{name}</div>
    </div>
  );
}

interface ModelCatalogProps {
  modelName: string;
  requestedSearch?: {
    text: string;
    column?: string;
    exact?: boolean;
    trigger: number;
  } | null;
}

function ModelCatalog({ modelName, requestedSearch = null }: ModelCatalogProps) {
  const { message } = AntApp.useApp();
  const ALL_COLUMNS_OPTION = '__all__';
  const SEARCH_SETTINGS_STORAGE_PREFIX = 'modelCatalogSearch:';
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchColumn, setSearchColumn] = useState<string>(ALL_COLUMNS_OPTION);
  const [searchText, setSearchText] = useState('');
  const [exactSearch, setExactSearch] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'tree-vertical' | 'tree-horizontal'>('table');
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(new Set());
  const [selectedNodeKey, setSelectedNodeKey] = useState<React.Key | null>(null);
  const [tablePage, setTablePage] = useState(1);

  // Tree view state (server-driven, independent of table pagination)
  const [treeMode, setTreeMode] = useState<'full' | 'lazy'>('lazy');
  const [treeRoots, setTreeRoots] = useState<CatalogTreeNode[]>([]);
  const [treeTupleColumns, setTreeTupleColumns] = useState<string[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [loadedChildKeys, setLoadedChildKeys] = useState<Set<string>>(new Set());
  const [treeSearchText, setTreeSearchText] = useState('');
  const [treeSearchResults, setTreeSearchResults] = useState<CatalogTreeNode[] | null>(null);
  const treeLoadedModelRef = useRef<string | null>(null);
  const horizontalTreeContainerRef = useRef<HTMLDivElement>(null);
  const horizontalTreeNodeRefMap = useRef<Map<React.Key, HTMLButtonElement>>(new Map());
  const builtTreeDataRef = useRef<DataNode[]>([]);
  const horizontalPanStateRef = useRef<{ pointerId: number; startX: number; startY: number; startScrollLeft: number; startScrollTop: number; moved: boolean; } | null>(null);
  const [isHorizontalPanning, setIsHorizontalPanning] = useState(false);
  const [fkValidationSets, setFkValidationSets] = useState<Record<string, Set<string>>>({});

  useEffect(() => {
    let cancelled = false;

    const loadCatalog = async () => {
      setLoading(true);
      try {
        const nextCatalog = await getModelCatalog(
          modelName,
          tablePage,
          CATALOG_PAGE_SIZE,
          debouncedSearch,
          searchColumn,
          exactSearch,
        );
        if (!cancelled) {
          setCatalog(nextCatalog);
          // Auto-include FK columns and component columns in visible columns
          if (nextCatalog.columns && Array.isArray(nextCatalog.columns)) {
            const autoVisible = new Set<string>();
            nextCatalog.columns.forEach((col: string) => {
              const colLower = col.toLowerCase();
              if (colLower.startsWith('fk_') || colLower.endsWith('component')) {
                autoVisible.add(col);
              }
            });
            if (autoVisible.size > 0) {
              setVisibleColumns(prev => new Set([...prev, ...autoVisible]));
            }

            const fkColumns = nextCatalog.columns.filter((column) => parseFkColumnHeader(column));
            const nextValidationSets: Record<string, Set<string>> = {};
            await Promise.all(fkColumns.map(async (column) => {
              const parsed = parseFkColumnHeader(column);
              if (!parsed) return;
              const validationKey = `${normalizeFkToken(parsed.targetTab)}|${normalizeFkToken(parsed.targetSubtab)}|${normalizeFkToken(parsed.targetField)}`;
              nextValidationSets[validationKey] = await loadFkValidationValues(parsed.targetTab, parsed.targetSubtab, parsed.targetField);
            }));
            setFkValidationSets(nextValidationSets);
          }
        }
      } catch (error: any) {
        if (!cancelled) {
          setCatalog(null);
          message.error(error.response?.data?.error || error.message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadCatalog();
    return () => { cancelled = true; };
  }, [message, modelName, tablePage, debouncedSearch, searchColumn, exactSearch]);

  // Debounce the free-text search box before hitting the server.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  // Reset to page 1 whenever the effective search changes.
  useEffect(() => {
    setTablePage(1);
  }, [debouncedSearch, searchColumn, exactSearch]);

  useEffect(() => {
    const storageKey = `${SEARCH_SETTINGS_STORAGE_PREFIX}${modelName}`;
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (!raw) {
        setSearchColumn(ALL_COLUMNS_OPTION);
        setSearchText('');
        setExactSearch(false);
        return;
      }
      const parsed = JSON.parse(raw) as { searchColumn?: string; searchText?: string; exactSearch?: boolean };
      setSearchColumn(parsed.searchColumn || ALL_COLUMNS_OPTION);
      setSearchText(String(parsed.searchText || ''));
      setExactSearch(Boolean(parsed.exactSearch));
    } catch {
      setSearchColumn(ALL_COLUMNS_OPTION);
      setSearchText('');
      setExactSearch(false);
    }
  }, [ALL_COLUMNS_OPTION, SEARCH_SETTINGS_STORAGE_PREFIX, modelName]);

  useEffect(() => {
    const storageKey = `${SEARCH_SETTINGS_STORAGE_PREFIX}${modelName}`;
    const payload = JSON.stringify({ searchColumn, searchText, exactSearch });
    window.sessionStorage.setItem(storageKey, payload);
  }, [SEARCH_SETTINGS_STORAGE_PREFIX, exactSearch, modelName, searchColumn, searchText]);

  useEffect(() => {
    if (!requestedSearch) return;
    setSearchColumn(requestedSearch.column || ALL_COLUMNS_OPTION);
    setSearchText(requestedSearch.text || '');
    setExactSearch(Boolean(requestedSearch.exact));
  }, [ALL_COLUMNS_OPTION, requestedSearch]);

  const columns = useMemo<ColumnsType<ModelCatalogRow>>(() => {
    console.log(`[FK_COLUMN_INIT] Processing catalog:`, {
      name: catalog?.name,
      totalColumns: catalog?.columns?.length,
      columns: catalog?.columns
    });

    // Log ALL columns to see what's actually in the catalog
    console.log(`[FK_COLUMN_INIT_ALL_COLUMNS]`, catalog?.columns?.map((col: string) => ({
      name: col,
      length: col.length,
      startsWith_FK: col.toLowerCase().startsWith('fk_'),
      inVisibleColumns: visibleColumns.has(col),
      charCodes: col.split('').map((c: string) => `${c}(${c.charCodeAt(0)})`)
    })));

    const cols = (catalog?.columns || [])
      .filter(column => visibleColumns.has(column))
      .map((column) => {
        console.log(`[FK_COLUMN_PROCESS] Checking column: "${column}"`);
        
        // ONLY detect foreign key columns with FK_ prefix pattern: FK_Data[Applications].Correlation_ID
        const columnLower = column.toLowerCase();
        const isForeignKeyColumn = columnLower.startsWith('fk_');
        
        console.log(`[FK_COLUMN_PROCESS] "${column}" - starts with FK_? ${isForeignKeyColumn}`);
        
        // Parse FK column to extract:
        // - Target tab from prefix: FK_Data → "Data" tab
        // - Target subtab from brackets: [Applications] → "Applications" subtab  
        // - Search field from suffix: Correlation_ID → searchField
        let targetTab: string | null = null;
        let targetSubtab: string | null = null;
        let searchField: string | null = null;
        
        if (isForeignKeyColumn) {
          // Pattern: FK_Data[Applications].Correlation_ID
          const regexPattern = /FK_([^\[]+)\[([^\]]+)\]\.(.+)$/;
          console.log(`[FK_COLUMN_PARSE] Attempting to parse FK column: "${column}" with pattern: ${regexPattern}`);
          
          const match = column.match(regexPattern);
          console.log(`[FK_COLUMN_PARSE] Regex match result:`, match);
          
          if (match) {
            targetTab = match[1];      // "Data"
            targetSubtab = match[2];   // "Applications"
            searchField = match[3];    // "Correlation_ID"
            console.log(`[FK_COLUMN_SUCCESS] Column "${column}" parsed successfully:`, {
              targetTab,
              targetSubtab,
              searchField
            });
          } else {
            console.warn(`[FK_COLUMN_PARSE_FAIL] Column "${column}" starts with FK_ but regex didn't match. Expected pattern: FK_TabName[SubtabName].FieldName`);
          }
        }

        const fkValidationKey = targetTab && targetSubtab && searchField
          ? `${normalizeFkToken(targetTab)}|${normalizeFkToken(targetSubtab)}|${normalizeFkToken(searchField)}`
          : '';
        const validationSet = fkValidationKey ? fkValidationSets[fkValidationKey] : undefined;

        return {
          title: column,
          key: column,
          dataIndex: ['values', column],
          ellipsis: true,
          render: (value: unknown) => {
            if (value === null || value === undefined || value === '') return '—';
            const valueStr = String(value);
            const normalizedValue = normalizeFkToken(valueStr);
            const isValidFk = Boolean(validationSet && normalizedValue && validationSet.has(normalizedValue));
            
            // Render FK columns as validated links when a matching persisted target exists.
            if (isForeignKeyColumn && searchField && targetTab && targetSubtab && isValidFk) {
              console.log(`[FK_LINK_RENDER] Rendering "${column}" value "${valueStr}" as link`);
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    console.log(`[FK_LINK_CLICK]`, {
                      column,
                      targetTab,
                      targetSubtab,
                      searchField,
                      valueStr,
                      timestamp: new Date().toISOString()
                    });
                    console.log(`[FK_LINK_CLICK] User clicked: navigating to ${targetTab} > ${targetSubtab} tab, searching by ${searchField}="${valueStr}"`);
                    window.dispatchEvent(new CustomEvent('navigateToApplication', { 
                      detail: { 
                        searchValue: valueStr,
                        searchField: searchField,
                        sourceColumn: column,
                        targetTab,
                        targetSubtab
                      } 
                    }));
                  }}
                  style={{ 
                    color: '#0284c7', 
                    textDecoration: 'underline', 
                    fontWeight: 500, 
                    cursor: 'pointer',
                    transition: 'color 0.2s'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#0369a1')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = '#0284c7')}
                  title={`Navigate to ${targetTab} > ${targetSubtab}, search by ${searchField}: ${valueStr}`}
                >
                  {valueStr}
                </a>
              );
            }

            if (isForeignKeyColumn && searchField && targetTab && targetSubtab) {
              return (
                <span
                  style={{ color: '#dc2626', fontWeight: 500 }}
                  title={`Invalid FK: ${targetTab} > ${targetSubtab}.${searchField} did not contain ${valueStr}`}
                >
                  {valueStr}
                </span>
              );
            }
            
            return valueStr;
          },
        };
      });
    
    const fkColumnCount = cols.filter((c: any) => {
      const colName = c.dataIndex?.[1]?.toLowerCase?.();
      return colName?.startsWith('fk_');
    }).length;
    console.log(`[FK_COLUMN_SUMMARY] Catalog: ${catalog?.name}`, {
      totalColumns: catalog?.columns?.length,
      fkColumnsDetected: fkColumnCount,
      visibleColumns: visibleColumns.size,
      allVisibleColumnNames: Array.from(visibleColumns)
    });
    console.log(`[FK_COLUMN_DEBUG] Checking if FK column exists:`, {
      catalogHasColumns: !!catalog?.columns,
      catalogColumnsCount: catalog?.columns?.length,
      visibleColumnsIncludeFK: Array.from(visibleColumns).filter((col: string) => col.toLowerCase().startsWith('fk_')).length
    });
    return cols;
  }, [catalog, fkValidationSets, visibleColumns]);

  // Server already applies search + pagination; render rows as-is.
  const filteredRows = useMemo(() => catalog?.rows ?? [], [catalog]);

  const componentColumns = useMemo(() => {
    if (!catalog) return [];
    return catalog.columns
      .map((col, index) => ({
        fullName: col,
        typeName: col.replace(/\s*component\s*$/i, '').trim(),
        originalIndex: index,
      }))
      .filter((col) => col.fullName.toLowerCase().endsWith('component'))
      .sort((a, b) => a.originalIndex - b.originalIndex);
  }, [catalog]);

  // The tree to display: search results override the loaded tree when a search is active.
  const displayRoots = useMemo<CatalogTreeNode[]>(
    () => (treeSearchResults ?? treeRoots),
    [treeSearchResults, treeRoots],
  );

  // Convert the server-provided tree (full or lazy) into AntD DataNodes.
  const treeData = useMemo<DataNode[]>(() => {
    if (viewMode === 'table') return [];
    const toDataNode = (n: CatalogTreeNode): DataNode => ({
      key: n.key,
      title: makeTreeTitle(n.typeName, n.name, n.depth),
      nodeName: n.name,
      typeName: n.typeName,
      isLeaf: n.isLeaf,
      children: n.children ? n.children.map(toDataNode) : undefined,
    } as DataNode);
    return displayRoots.map(toDataNode);
  }, [viewMode, displayRoots]);

  // Load the aggregated tree structure from the server when entering a tree view
  // (or when the model changes). Full mode returns the entire tree; lazy mode
  // returns only root nodes and children are fetched on expand.
  useEffect(() => {
    if (viewMode === 'table') return;
    if (treeLoadedModelRef.current === modelName) return;

    let cancelled = false;
    treeLoadedModelRef.current = modelName;
    setTreeLoading(true);
    setTreeSearchText('');
    setTreeSearchResults(null);
    setLoadedChildKeys(new Set());
    setExpandedKeys([]);

    (async () => {
      try {
        const resp = await getModelCatalogTree(modelName, 'lazy');
        if (cancelled) return;
        setTreeMode(resp.mode);
        setTreeTupleColumns(resp.tupleColumns || []);
        setTreeRoots(resp.roots || []);
        setExpandedKeys([]);
      } catch (error: any) {
        if (!cancelled) {
          treeLoadedModelRef.current = null;
          setTreeRoots([]);
          message.error(error.response?.data?.error || error.message);
        }
      } finally {
        if (!cancelled) setTreeLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [viewMode, modelName, message]);

  // Reset cached tree when the model changes so it reloads next time a tree view opens.
  useEffect(() => {
    treeLoadedModelRef.current = null;
    setTreeRoots([]);
    setTreeSearchResults(null);
    setTreeSearchText('');
  }, [modelName]);

  // Lazily fetch children for a node (used only in lazy tree mode).
  const loadChildren = useCallback(async (nodeKey: string) => {
    if (treeMode !== 'lazy') return;
    if (loadedChildKeys.has(nodeKey)) return;
    const pathValues = String(nodeKey).split('|');
    try {
      const resp = await getModelCatalogTreeChildren(modelName, pathValues);
      setTreeRoots((prev) => insertChildrenAt(prev, nodeKey, resp.children || []));
      setLoadedChildKeys((prev) => new Set(prev).add(nodeKey));
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    }
  }, [treeMode, loadedChildKeys, modelName, message]);

  // AntD Tree loadData callback for lazy mode.
  const handleLoadData = useCallback(async (node: any) => {
    await loadChildren(String(node.key));
  }, [loadChildren]);

  // Debounced tree search against the server.
  useEffect(() => {
    if (viewMode === 'table') return;
    const term = treeSearchText.trim();
    if (!term) {
      setTreeSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const resp = await searchModelCatalogTree(modelName, term);
        if (cancelled) return;
        const roots = buildTreeFromPaths(resp.paths || []);
        setTreeSearchResults(roots);
        // Expand everything in the search result set.
        const keys: React.Key[] = [];
        const collect = (list: CatalogTreeNode[]) => list.forEach((n) => {
          if (n.children && n.children.length) { keys.push(n.key); collect(n.children); }
        });
        collect(roots);
        setExpandedKeys(keys);
      } catch (error: any) {
        if (!cancelled) message.error(error.response?.data?.error || error.message);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [treeSearchText, viewMode, modelName, message]);

  const handleCollapseAll = () => {
    setExpandedKeys([]);
  };

  // Horizontal tree view - graph diagram with SVG connectors
  const renderHorizontalTree = () => {
    const NODE_WIDTH = 140;
    const COLUMN_GAP = 196;
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
          // Word alone is wider than column — it will wrap character by character
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

    const bgColors = ['#EFF6FF', '#F0FDF4', '#FEF3C7', '#FCE7F3', '#F3E8FF', '#ECFDF5'];
    const textColors = ['#0C63E4', '#15803D', '#B45309', '#BE185D', '#6D28D9', '#0891B2'];

    interface PositionedNode {
      node: DataNode;
      depth: number;
      y: number;
      h: number;
      parentKey: React.Key | null;
    }

    const positioned: PositionedNode[] = [];
    const positionById = new Map<React.Key, { x: number; y: number; h: number }>();
    let maxDepth = 0;
    let maxY = 0;

    // Returns the y-bottom of the last node placed (without trailing gap).
    // Children are laid out first so the parent can be vertically centred over them.
    const traverse = (nodes: DataNode[], depth: number, parentKey: React.Key | null, yOffset: number): number => {
      let currentY = yOffset;
      let lastBottom = yOffset;
      maxDepth = Math.max(maxDepth, depth);

      for (const node of nodes) {
        const h = nodeHeight(String((node as any).nodeName || ''));
        const nodeX = depth * COLUMN_GAP + PADDING;

        if (expandedKeys.includes(node.key) && node.children && node.children.length > 0) {
          // Lay out children first so we know their full vertical span.
          const childrenStartY = currentY;
          const childrenLastBottom = traverse(node.children, depth + 1, node.key, currentY);

          // Centre parent over the children span.
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

    traverse(treeData, 0, null, PADDING);

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
          width: '100%',
          height: '100%',
          minHeight: 0,
          minWidth: 0,
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
            const isSelected = selectedNodeKey === p.node.key;
            const nodeSearchText = String((p.node as any).nodeName || '').toLowerCase();
            const isSearchHit = Boolean(treeSearchText.trim()) && nodeSearchText.includes(treeSearchText.trim().toLowerCase());
            const isExpanded = expandedKeys.includes(p.node.key);
            const hasChildren = !(p.node as any).isLeaf;
            
            const bgColor = bgColors[p.depth % bgColors.length];
            const textColor = textColors[p.depth % textColors.length];

            return (
              <button
                key={p.node.key}
                ref={(el) => {
                  if (el) {
                    horizontalTreeNodeRefMap.current.set(p.node.key, el);
                    (el as any)._posX = pos.x;
                    (el as any)._posY = pos.y;
                  } else {
                    horizontalTreeNodeRefMap.current.delete(p.node.key);
                  }
                }}
                type="button"
                onClick={() => {
                  setSelectedNodeKey(p.node.key);
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
                    {(p.node as any).typeName || ''}
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
                    {renderHighlightedTreeText(String((p.node as any).nodeName || ''), treeSearchText)}
                  </div>
                </div>
                {hasChildren && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      if (horizontalPanStateRef.current?.moved) return;
                      const willExpand = !expandedKeys.includes(p.node.key);
                      if (willExpand) {
                        void loadChildren(String(p.node.key));
                      }
                      setExpandedKeys((prev: React.Key[]) =>
                        prev.includes(p.node.key)
                          ? prev.filter((k: React.Key) => k !== p.node.key)
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

  // Auto-scroll horizontal tree to keep selected node centered
  useEffect(() => {
    if (viewMode !== 'tree-horizontal') return;

    const timer = setTimeout(() => {
      const buttonToCenter = selectedNodeKey ? horizontalTreeNodeRefMap.current.get(selectedNodeKey) : null;
      if (buttonToCenter && horizontalTreeContainerRef.current) {
        const container = horizontalTreeContainerRef.current;
        const posX = (buttonToCenter as any)._posX;
        const posY = (buttonToCenter as any)._posY;

        if (typeof posX === 'number' && typeof posY === 'number') {
          const NODE_WIDTH = 140;
          // Scroll to centre on the node's top position (height unknown here; good enough)
          const scrollLeft = posX - (container.clientWidth / 2) + (NODE_WIDTH / 2);
          const scrollTop = posY - (container.clientHeight / 2) + 40;

          container.scrollTo({
            left: Math.max(0, scrollLeft),
            top: Math.max(0, scrollTop),
            behavior: 'smooth',
          });
        }
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [selectedNodeKey, viewMode, expandedKeys]);

  useEffect(() => {
    if (treeMode === 'full') {
      const typeKeys = treeData.map((node) => node.key);
      setExpandedKeys(typeKeys);
    }
  }, [treeMode, treeData]);

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

  useEffect(() => {
    if (!catalog) return;
    const storageKey = `modelCatalogVisibleColumns:${modelName}`;
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored) {
      try {
        setVisibleColumns(new Set(JSON.parse(stored)));
      } catch {
        setVisibleColumns(new Set(catalog.columns));
      }
    } else {
      setVisibleColumns(new Set(catalog.columns));
    }
  }, [catalog, modelName]);

  useEffect(() => {
    if (!catalog) return;
    const storageKey = `modelCatalogVisibleColumns:${modelName}`;
    window.sessionStorage.setItem(storageKey, JSON.stringify(Array.from(visibleColumns)));
  }, [visibleColumns, catalog, modelName]);

  return (
    <Card
      size="small"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      extra={catalog ? <span style={{ color: '#64748b', fontSize: 12 }}>{catalog.rowCount} rows · {catalog.sourceFileName || 'No source file'}</span> : null}
    >
      {loading ? <Spin /> : null}
      {!loading && !catalog ? <div style={{ color: '#64748b' }}>No model catalog data available.</div> : null}
      {!loading && catalog ? (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            <Segmented
              value={viewMode}
              onChange={(value) => setViewMode(value as 'table' | 'tree-vertical' | 'tree-horizontal')}
              options={[
                { label: <><TableOutlined /> Table</>, value: 'table' },
                { label: <><UnorderedListOutlined /> Tree</>, value: 'tree-vertical', disabled: componentColumns.length === 0 },
                { label: <><BarsOutlined /> Tree (Horizontal)</>, value: 'tree-horizontal', disabled: componentColumns.length === 0 },
              ]}
            />
            {viewMode === 'table' && catalog ? (
              <Popover
                title="Select Columns"
                content={
                  <div style={{ maxWidth: 300 }}>
                    {catalog.columns.map((col) => (
                      <div key={col} style={{ marginBottom: 8 }}>
                        <Checkbox
                          checked={visibleColumns.has(col)}
                          onChange={(e) => {
                            const newVisible = new Set(visibleColumns);
                            if (e.target.checked) {
                              newVisible.add(col);
                            } else {
                              newVisible.delete(col);
                            }
                            setVisibleColumns(newVisible);
                          }}
                        >
                          {col}
                        </Checkbox>
                      </div>
                    ))}
                  </div>
                }
                trigger="click"
              >
                <Button size="small">Column Picker</Button>
              </Popover>
            ) : null}
            {(viewMode === 'tree-vertical' || viewMode === 'tree-horizontal') && componentColumns.length > 0 ? (
              <>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="Search tree"
                  style={{ width: 240 }}
                  value={treeSearchText}
                  onChange={(event) => setTreeSearchText(event.target.value)}
                />
                <Button size="small" onClick={handleCollapseAll}>Collapse All</Button>
                {treeLoading && <Spin size="small" />}
              </>
            ) : null}
          </Space>

          {viewMode === 'table' ? (
            <>
              <Space wrap style={{ marginBottom: 12 }}>
                <Select
                  value={searchColumn}
                  style={{ width: 220 }}
                  onChange={setSearchColumn}
                  options={[
                    { label: 'All columns', value: ALL_COLUMNS_OPTION },
                    ...catalog.columns.map((column) => ({ label: column, value: column })),
                  ]}
                />
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="Search model catalog"
                  style={{ width: 300 }}
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                />
                <Space size={6}>
                  <Switch size="small" checked={exactSearch} onChange={setExactSearch} />
                  <span style={{ color: '#64748b', fontSize: 12 }}>Exact</span>
                </Space>
                <span style={{ color: '#64748b', fontSize: 12 }}>
                  Showing {catalog.rows.length} of {catalog.rowCount} rows {catalog.pagination ? `(page ${catalog.pagination.currentPage} of ${catalog.pagination.totalPages})` : ''}
                </span>
              </Space>

              <Table
                rowKey={(_row, index) => `${modelName}-${index}`}
                dataSource={filteredRows}
                columns={enhanceColumnsWithSortAndFilters(columns as any, filteredRows)}
                size="small"
                pagination={{
                  current: catalog.pagination?.currentPage ?? tablePage,
                  pageSize: CATALOG_PAGE_SIZE,
                  total: catalog.pagination?.totalCount ?? catalog.rowCount,
                  showSizeChanger: false,
                  position: ['topRight'],
                  onChange: (page) => setTablePage(page),
                  showTotal: (total, range) => `${range[0]}-${range[1]} of ${total}`,
                }}
                loading={loading}
                scroll={{ x: 'max-content' }}
              />
            </>
          ) : viewMode === 'tree-vertical' ? (
            <div style={{ paddingTop: '16px', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div
                style={{
                  display: 'flex',
                  gap: '24px',
                  marginBottom: '16px',
                  paddingBottom: '12px',
                  borderBottom: '2px solid #E2E8F0',
                  fontSize: '12px',
                  fontWeight: 700,
                  color: '#475569',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                <div style={{ minWidth: '130px', maxWidth: '130px' }}>Component Type</div>
                <div>Value</div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px' }}>
                <Tree
                  treeData={treeData}
                  expandedKeys={expandedKeys}
                  onExpand={setExpandedKeys}
                  loadData={treeMode === 'lazy' ? handleLoadData : undefined}
                  style={{ padding: '8px 0' }}
                />
              </div>
            </div>
          ) : (
            <div className="component-search-results horizontal-tree-scroll" style={{ flex: 1, minHeight: 0 }}>
              {renderHorizontalTree()}
            </div>
          )}
        </>
      ) : null}
    </Card>
  );
}

export default memo(ModelCatalog);