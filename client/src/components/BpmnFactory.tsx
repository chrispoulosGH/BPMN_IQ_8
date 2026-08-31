import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Table, Input, Button, App as AntApp, Space, Tooltip, Tag, Select, Typography } from 'antd';
import { EditOutlined, DeleteOutlined, SearchOutlined, FolderOpenOutlined, UploadOutlined, DownloadOutlined } from '@ant-design/icons';
import type { DiagramMeta } from '../types';
import { getDiagrams, getDiagram, deleteDiagram, updateDiagram, batchImportDiagrams, transitionState, getStatusTransitions, type StatusRefTransition } from '../api';
import { matchesFactorySearch, parseFactorySearch, encodeExactFactorySearch } from '../utils/factorySearch';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';

interface DiagramMetadataFieldConfig {
  label: string;
  tabKey?: string;
}

interface DiagramMetadataConfig {
  lineOfBusiness?: DiagramMetadataFieldConfig;
  channel?: DiagramMetadataFieldConfig;
  domain?: DiagramMetadataFieldConfig;
  subdomain?: DiagramMetadataFieldConfig;
  product?: DiagramMetadataFieldConfig;
}

const DEFAULT_DIAGRAM_METADATA_CONFIG: Required<DiagramMetadataConfig> = {
  lineOfBusiness: { label: 'Line of Business', tabKey: 'linesOfBusiness' },
  channel: { label: 'Channel', tabKey: 'channels' },
  domain: { label: 'Domain', tabKey: 'domains' },
  subdomain: { label: 'Subdomain', tabKey: 'subdomains' },
  product: { label: 'Product', tabKey: 'products' },
};

// State transition rules — fetched once from GET /api/states/transitions
// (the status_ref Mongo collection; mirrors server/services/stateTransitions.js,
// which still enforces these same rules server-side) instead of being
// hardcoded here.
function getAllowedActions(transitions: StatusRefTransition[], role: string | null | undefined, currentState: string) {
  const state = (currentState || 'draft').toLowerCase();
  if (role === 'Super') {
    return transitions.filter(t => t.from === state);
  }
  return transitions.filter(t => t.role === role && t.from === state);
}

// Resizable header cell
function ResizableHeaderCell({ width, onResize, ...restProps }: any) {
  const startX = useRef(0);
  const startW = useRef(0);

  if (!width || !onResize) return <th {...restProps} />;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = width;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(startW.current + ev.clientX - startX.current, 60);
      onResize(newWidth);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  return (
    <th {...restProps} style={{ ...restProps.style, position: 'relative' }}>
      {restProps.children}
      <span
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 5, cursor: 'col-resize' }}
        onMouseDown={handleMouseDown}
      />
    </th>
  );
}

interface BpmnFactoryProps {
  defaultSearch?: string;
  onOpenDiagram?: (id: string) => void;
  onNavigateToFactory?: (tab: string, search: string) => void;
  readOnly?: boolean;
  refreshTick?: number;
  userRole?: string | null;
  diagramMetadataConfig?: DiagramMetadataConfig;
}

export default function BpmnFactory({ defaultSearch, onOpenDiagram, onNavigateToFactory, readOnly, refreshTick, userRole, diagramMetadataConfig }: BpmnFactoryProps) {
  const { message, modal } = AntApp.useApp();
  const canImportExport = userRole === 'Administrator' || userRole === 'Super';
  const metadataConfig = {
    ...DEFAULT_DIAGRAM_METADATA_CONFIG,
    ...diagramMetadataConfig,
  };
  const [diagrams, setDiagrams] = useState<DiagramMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [exactSearch, setExactSearch] = useState(false);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<{ name?: string; description?: string; sourcedFrom?: string; owner?: string }>({});
  const [pendingStateAction, setPendingStateAction] = useState<{ action: string; to: string } | null>(null);
  const [tableFilteredCount, setTableFilteredCount] = useState<number | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [exporting, setExporting] = useState(false);
  const [colWidths, setColWidths] = useState<Record<string, number>>({ name: 300 });
  const [statusTransitions, setStatusTransitions] = useState<StatusRefTransition[]>([]);

  // Fetched once on mount — the status_ref collection rarely changes, and
  // every row's Status cell needs it synchronously to compute its own
  // allowed actions, so one shared fetch beats a per-row round trip.
  useEffect(() => {
    getStatusTransitions().then(setStatusTransitions).catch(() => setStatusTransitions([]));
  }, []);

  const loadDiagrams = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDiagrams();
      setDiagrams(data);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { loadDiagrams(); }, [loadDiagrams, refreshTick]);

  useEffect(() => {
    if (defaultSearch !== undefined) {
      const parsed = parseFactorySearch(defaultSearch);
      setSearch(parsed.term);
      setExactSearch(parsed.exact);
    }
  }, [defaultSearch]);

  // Reset table filter count when search or data changes
  useEffect(() => { setTableFilteredCount(null); }, [search, diagrams]);

  const handleDelete = (diagram: DiagramMeta) => {
    modal.confirm({
      title: `Delete "${diagram.name}"?`,
      content: 'This will permanently remove this diagram.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteDiagram(diagram._id);
        message.success('Deleted');
        loadDiagrams();
      },
    });
  };

  const handleBulkDelete = () => {
    if (!selectedRowKeys.length) return;
    modal.confirm({
      title: `Delete ${selectedRowKeys.length} selected diagrams?`,
      content: `This will permanently remove ${selectedRowKeys.length} selected diagrams.`,
      okText: 'Delete Selected',
      okButtonProps: { danger: true },
      onOk: async () => {
        await Promise.all(selectedRowKeys.map((id) => deleteDiagram(String(id))));
        message.success(`Deleted ${selectedRowKeys.length} diagrams`);
        setSelectedRowKeys([]);
        loadDiagrams();
      },
    });
  };

  const handleInlineEdit = (diagram: DiagramMeta) => {
    setEditingId(diagram._id);
    setEditFields({
      name: diagram.name || '',
      description: diagram.description || '',
      sourcedFrom: diagram.sourcedFrom || '',
      owner: diagram.owner || '',
    });
    setPendingStateAction(null);
  };

  const handleInlineSave = async (id: string) => {
    try {
      // If there's a pending state transition, execute it first
      if (pendingStateAction) {
        await transitionState('diagrams', id, pendingStateAction.action, userRole || '');
      }
      await updateDiagram(id, editFields as any);
      message.success('Updated');
      setEditingId(null);
      // Update in-place to preserve scroll/sort position
      const updates: any = { ...editFields };
      if (pendingStateAction) updates.status = pendingStateAction.to;
      setDiagrams(prev => prev.map(d => d._id === id ? { ...d, ...updates } : d));
      setPendingStateAction(null);
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  // ─── Batch Import ─────────────────────────────────────────
  const handleBatchImport = () => {
    batchInputRef.current?.click();
  };

  const handleBatchFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || !fileList.length) return;
    // Read file contents immediately before clearing the input
    const readFiles: { xml: string; fileName: string }[] = [];
    for (const file of Array.from(fileList)) {
      const xml = await file.text();
      readFiles.push({ xml, fileName: file.name });
    }
    e.target.value = '';
    modal.confirm({
      title: `Batch Import ${readFiles.length} file(s)`,
      content: (
        <div>
          <p>The following files will be imported with status <Tag color="orange">Staged</Tag> or <Tag color="red">Invalid</Tag> when the XML business flow is not in Business Flow reference data:</p>
          <p>Each XML will be matched to a model from its diagram-title metadata and validated against that model's factory/reference values.</p>
          <ul style={{ maxHeight: 200, overflow: 'auto', paddingLeft: 16 }}>
            {readFiles.map((f) => <li key={f.fileName}>{f.fileName}</li>)}
          </ul>
        </div>
      ),
      okText: 'Import All',
      onOk: async () => {
        try {
          const result = await batchImportDiagrams(readFiles, 'cp1853');
          const invalidCount = result.success.filter((item) => (item.status || '').toLowerCase() === 'invalid').length;
          if (result.failed.length) {
            message.warning(`${result.success.length} imported (${invalidCount} invalid), ${result.failed.length} failed`);
          } else {
            message.success(`Imported ${result.success.length} diagrams (${invalidCount} invalid)`);
          }
          loadDiagrams();
        } catch (err: any) {
          message.error(err.response?.data?.error || err.message);
        }
      },
    });
  };

  // ─── Batch Export ──────────────────────────────────────────
  const handleBatchExport = async () => {
    if (!selectedRowKeys.length) {
      message.warning('Select at least one diagram to export');
      return;
    }
    try {
      // Use File System Access API directory picker
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      setExporting(true);
      let exported = 0;
      for (const id of selectedRowKeys) {
        try {
          const diagram = await getDiagram(id as string);
          const fileName = `${(diagram.name || 'diagram').replace(/[<>:"/\\|?*]/g, '_')}.bpmn`;
          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(diagram.xml);
          await writable.close();
          exported++;
        } catch (err: any) {
          console.error(`Failed to export ${id}:`, err);
        }
      }
      message.success(`Exported ${exported} of ${selectedRowKeys.length} diagrams`);
      setSelectedRowKeys([]);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        message.error(`Export failed: ${err.message}`);
      }
    } finally {
      setExporting(false);
    }
  };

  const searchToken = exactSearch ? encodeExactFactorySearch(search) : search;
  const filtered = search
    ? diagrams.filter((d) => {
        return matchesFactorySearch([
          d.name,
          d.lineOfBusiness,
          d.channel,
          d.domain,
          d.subdomain,
          d.product,
          d.businessFlow,
          d.status,
          d.createdBy,
          d.updatedBy,
          d.sourcedFrom,
          ...(d.tasks || []).flatMap((t) => [t.name, ...(t.applications || []).map((a) => a.name)]),
        ], searchToken);
      })
    : diagrams;

  const handleStateTransition = async (record: DiagramMeta, action: string) => {
    const rule = statusTransitions.find(t => t.action === action && t.from === (record.status || 'draft').toLowerCase());
    if (rule) {
      setPendingStateAction({ action, to: rule.to });
    }
  };

  // Compute unique filter values for column filters
  const nameFilters = useMemo(() => {
    const names = [...new Set(diagrams.map((d) => d.name).filter(Boolean))].sort();
    return names.map((n) => ({ text: n, value: n }));
  }, [diagrams]);
  const statusFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.status || 'Draft').filter(Boolean))].sort();
    return values.map((v) => ({ text: v, value: v }));
  }, [diagrams]);
  const createdByFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.createdBy).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);
  const updatedByFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.updatedBy).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);
  const lobFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.lineOfBusiness).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);
  const channelFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.channel).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);
  const domainFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.domain).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);
  const subdomainFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.subdomain).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);
  const productFilters = useMemo(() => {
    const values = [...new Set(diagrams.map((d) => d.product).filter(Boolean))].sort();
    return values.map((v) => ({ text: v!, value: v! }));
  }, [diagrams]);

  const columns = [
    {
      title: 'Diagram Name',
      dataIndex: 'name',
      key: 'name',
      width: 300,
      ellipsis: true,
      sorter: (a: DiagramMeta, b: DiagramMeta) => a.name.localeCompare(b.name),
      filters: nameFilters,
      onFilter: (value: any, record: DiagramMeta) => record.name === value,
      filterSearch: true,
      render: (name: string, record: DiagramMeta) =>
        editingId === record._id ? (
          <Input
            size="small"
            value={editFields.name}
            onChange={(e) => setEditFields((f) => ({ ...f, name: e.target.value }))}
          />
        ) : (
          <Button type="link" size="small" onClick={() => onOpenDiagram?.(record._id)}>
            {name}
          </Button>
        ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      width: 200,
      render: (val: string, record: DiagramMeta) =>
        editingId === record._id ? (
          <Input
            size="small"
            value={editFields.description}
            onChange={(e) => setEditFields((f) => ({ ...f, description: e.target.value }))}
          />
        ) : (
          val || '—'
        ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 160,
      filters: statusFilters,
      onFilter: (value: any, record: DiagramMeta) => (record.status || 'Draft') === value,
      render: (val: string, record: DiagramMeta) => {
        const currentState = (val || 'draft').toLowerCase();
        const actions = getAllowedActions(statusTransitions, userRole, currentState);
        const displayState = (editingId === record._id && pendingStateAction) ? pendingStateAction.to : (val || 'draft');
        const tagColor = displayState === 'published' ? 'green' : displayState === 'approved' ? 'blue' : displayState === 'submitted for approval' ? 'orange' : displayState === 'submitted for publish' ? 'cyan' : displayState === 'staged' ? 'purple' : displayState === 'invalid' ? 'red' : displayState === 'deleted' ? 'red' : 'default';
        if (!actions.length || readOnly || editingId !== record._id) {
          return <Tag color={tagColor}>{displayState}</Tag>;
        }
        return (
          <Select
            size="small"
            value={pendingStateAction ? pendingStateAction.action : '__current__'}
            style={{ width: '100%' }}
            onChange={(action) => handleStateTransition(record, action)}
            options={[
              { label: <Tag color={tagColor}>{val || 'draft'}</Tag>, value: '__current__', disabled: true },
              ...actions.map(a => ({ label: `${a.action} → ${a.to}`, value: a.action })),
            ]}
          />
        );
      },
    },
    {
      title: metadataConfig.lineOfBusiness.label,
      dataIndex: 'lineOfBusiness',
      key: 'lineOfBusiness',
      width: 140,
      filters: lobFilters,
      filterSearch: true,
      onFilter: (value: any, record: DiagramMeta) => record.lineOfBusiness === value,
      render: (val: string) => val
        ? metadataConfig.lineOfBusiness.tabKey
          ? <Typography.Link onClick={() => onNavigateToFactory?.(metadataConfig.lineOfBusiness.tabKey!, val)}>{val}</Typography.Link>
          : val
        : '—',
    },
    {
      title: metadataConfig.channel.label,
      dataIndex: 'channel',
      key: 'channel',
      width: 110,
      filters: channelFilters,
      onFilter: (value: any, record: DiagramMeta) => record.channel === value,
      render: (val: string) => val
        ? metadataConfig.channel.tabKey
          ? <Typography.Link onClick={() => onNavigateToFactory?.(metadataConfig.channel.tabKey!, val)}>{val}</Typography.Link>
          : val
        : '—',
    },
    {
      title: metadataConfig.domain.label,
      dataIndex: 'domain',
      key: 'domain',
      width: 130,
      filters: domainFilters,
      filterSearch: true,
      onFilter: (value: any, record: DiagramMeta) => record.domain === value,
      render: (val: string) => val
        ? metadataConfig.domain.tabKey
          ? <Typography.Link onClick={() => onNavigateToFactory?.(metadataConfig.domain.tabKey!, val)}>{val}</Typography.Link>
          : val
        : '—',
    },
    {
      title: metadataConfig.subdomain.label,
      dataIndex: 'subdomain',
      key: 'subdomain',
      width: 140,
      filters: subdomainFilters,
      filterSearch: true,
      onFilter: (value: any, record: DiagramMeta) => record.subdomain === value,
      render: (val: string) => val
        ? metadataConfig.subdomain.tabKey
          ? <Typography.Link onClick={() => onNavigateToFactory?.(metadataConfig.subdomain.tabKey!, val)}>{val}</Typography.Link>
          : val
        : '—',
    },
    {
      title: metadataConfig.product.label,
      dataIndex: 'product',
      key: 'product',
      width: 120,
      filters: productFilters,
      filterSearch: true,
      onFilter: (value: any, record: DiagramMeta) => record.product === value,
      render: (val: string) => val
        ? metadataConfig.product.tabKey
          ? <Typography.Link onClick={() => onNavigateToFactory?.(metadataConfig.product.tabKey!, val)}>{val}</Typography.Link>
          : val
        : '—',
    },
    {
      title: 'Sourced From',
      dataIndex: 'sourcedFrom',
      key: 'sourcedFrom',
      width: 140,
      render: (val: string, record: DiagramMeta) =>
        editingId === record._id ? (
          <Input
            size="small"
            value={editFields.sourcedFrom}
            onChange={(e) => setEditFields((f) => ({ ...f, sourcedFrom: e.target.value }))}
          />
        ) : (
          val || '—'
        ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 100,
      render: (val: string) => val ? new Date(val).toLocaleDateString() : '—',
      sorter: (a: DiagramMeta, b: DiagramMeta) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    },
    {
      title: 'Created By',
      dataIndex: 'createdBy',
      key: 'createdBy',
      width: 100,
      filters: createdByFilters,
      onFilter: (value: any, record: DiagramMeta) => record.createdBy === value,
      render: (val: string) => val || '—',
    },
    {
      title: 'Last Updated',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 100,
      render: (val: string) => val ? new Date(val).toLocaleDateString() : '—',
      sorter: (a: DiagramMeta, b: DiagramMeta) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: 'Updated By',
      dataIndex: 'updatedBy',
      key: 'updatedBy',
      width: 100,
      filters: updatedByFilters,
      onFilter: (value: any, record: DiagramMeta) => record.updatedBy === value,
      render: (val: string) => val || '—',
    },
    {
      title: 'Owner',
      dataIndex: 'owner',
      key: 'owner',
      width: 120,
      render: (val: string, record: DiagramMeta) => {
        if (editingId === record._id) {
          return <Input size="small" value={editFields.owner || ''} onChange={(e) => setEditFields((f) => ({ ...f, owner: e.target.value }))} />;
        }
        return val || '—';
      },
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, record: DiagramMeta) => (
        <Space size="small">
          {editingId === record._id ? (
            <>
              <Button size="small" type="primary" onClick={() => handleInlineSave(record._id)}>Save</Button>
              <Button size="small" onClick={() => { setEditingId(null); setPendingStateAction(null); }}>Cancel</Button>
            </>
          ) : (
            <>
              <Tooltip title="Open in Canvas">
                <Button size="small" icon={<FolderOpenOutlined />} onClick={() => onOpenDiagram?.(record._id)} />
              </Tooltip>
              {!readOnly && <Tooltip title="Edit">
                <Button size="small" icon={<EditOutlined />} onClick={() => handleInlineEdit(record)} />
              </Tooltip>}
              {!readOnly && <Tooltip title="Delete">
                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} />
              </Tooltip>}
            </>
          )}
        </Space>
      ),
    },
  ];
  const enhancedColumns = useMemo(
    () => enhanceColumnsWithSortAndFilters(columns as any, filtered),
    [columns, filtered]
  );

  return (
    <div className="p-4">
      <input
        ref={batchInputRef}
        type="file"
        multiple
        accept=".bpmn,.xml"
        style={{ display: 'none' }}
        onChange={handleBatchFilesSelected}
      />
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <Input
            placeholder="Search diagrams..."
            prefix={<SearchOutlined />}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setExactSearch(false);
            }}
            allowClear
            style={{ width: 300 }}
          />
          <Typography.Text type="secondary" className="text-xs whitespace-nowrap">
            {tableFilteredCount !== null ? tableFilteredCount : filtered.length} of {diagrams.length} diagrams
          </Typography.Text>
        </div>
        <Space>
          {!readOnly && <Button danger icon={<DeleteOutlined />} onClick={handleBulkDelete} disabled={!selectedRowKeys.length}>
            Delete Selected ({selectedRowKeys.length})
          </Button>}
          {canImportExport && <Button
            icon={<DownloadOutlined />}
            onClick={handleBatchExport}
            disabled={!selectedRowKeys.length || exporting}
            loading={exporting}
          >
            Export ({selectedRowKeys.length})
          </Button>}
          {canImportExport && <Button icon={<UploadOutlined />} onClick={handleBatchImport} disabled={readOnly}>
            Batch Import
          </Button>}
        </Space>
      </div>
      <Table
        dataSource={filtered}
        columns={enhancedColumns.map((col: any) => ({
          ...col,
          width: colWidths[col.key] || col.width,
          onHeaderCell: (column: any) => ({
            width: colWidths[column.key] || column.width,
            onResize: (w: number) => setColWidths((prev) => ({ ...prev, [column.key]: w })),
          }),
        }))}
        components={{ header: { cell: ResizableHeaderCell } }}
        rowKey="_id"
        size="small"
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true, position: ['topRight'] }}
        scroll={{ y: 'calc(var(--app-h) - 260px)' }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
        }}
        onChange={(_pagination, _filters, _sorter, extra) => {
          setTableFilteredCount(extra.currentDataSource.length);
        }}
      />
    </div>
  );
}
