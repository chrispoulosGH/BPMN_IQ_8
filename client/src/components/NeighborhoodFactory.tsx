import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState, useRef } from 'react';
import { App as AntApp, Button, Card, Form, Input, List, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Tooltip, Upload, Dropdown, Checkbox } from 'antd';
import { DeleteOutlined, EditOutlined, ExclamationCircleOutlined, FolderAddOutlined, InboxOutlined, PlusOutlined, ColumnHeightOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';
import { parseFactorySearch } from '../utils/factorySearch';

import {
  createFactoryNeighborhood,
  deleteFactoryNeighborhood,
  deleteAllNeighborhoodComponents,
  deleteCustomFactory,
  deleteCustomFactoryRow,
  getCustomFactories,
  getCustomFactory,
  getFactoryNeighborhoods,
  updateCustomFactoryRow,
  uploadCustomFactory,
  type CustomFactory,
  type CustomFactoryRow,
  type FactoryNeighborhoodSummary,
} from '../api';

interface NeighborhoodFactoryProps {
  canManageFactories: boolean;
  fixedNeighborhoodName?: string;
  fixedFactoryId?: string;
  hideFactoryList?: boolean;
  onNeighborhoodsChanged?: () => void | Promise<void>;
  onNeighborhoodCreated?: (name: string) => void;
  onFactoryDeleted?: (factoryId: string, neighborhoodName: string) => void | Promise<void>;
  onNeighborhoodDeleted?: (name: string) => void | Promise<void>;
  showCreateNeighborhood?: boolean;
  showAddFactory?: boolean;
  showDeleteNeighborhood?: boolean;
  mode?: 'panel' | 'action';
  defaultRowSearch?: string;
  defaultRowSearchColumn?: string;
  onApplicationLinkClick?: (applicationName: string, correlationId?: string | null, rowSearchText?: string) => void;
}

interface FactoryRowViewState {
  searchColumn: string;
  searchText: string;
  statusFilter?: string;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

type ForeignKeyColumn = NonNullable<CustomFactory['foreignKeyColumns']>[number];

function normalizeFkFieldName(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/qualifier$/i, '');
}

function getDataTabKeyForTargetScope(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases: Record<string, string> = {
    application: 'applications',
    applications: 'applications',
    app: 'applications',
    apps: 'applications',
    server: 'servers',
    servers: 'servers',
    database: 'databases',
    databases: 'databases',
    databaseinstance: 'databases',
    databaseinstances: 'databases',
  };
  return aliases[normalized] || normalized;
}

function NeighborhoodFactory({ canManageFactories, fixedNeighborhoodName, fixedFactoryId, hideFactoryList = false, onNeighborhoodsChanged, onNeighborhoodCreated, onFactoryDeleted, onNeighborhoodDeleted, showCreateNeighborhood = true, showAddFactory = true, showDeleteNeighborhood = true, mode = 'panel', defaultRowSearch, defaultRowSearchColumn = 'name' }: NeighborhoodFactoryProps) {
  const { message } = AntApp.useApp();
  const ALL_COLUMNS_OPTION = '__all__';
  const PRIMARY_KEY_COLUMN = 'name';
  const [neighborhoods, setNeighborhoods] = useState<FactoryNeighborhoodSummary[]>([]);
  const [factories, setFactories] = useState<CustomFactory[]>([]);
  const [selectedNeighborhood, setSelectedNeighborhood] = useState<string | null>(null);
  const [selectedFactoryId, setSelectedFactoryId] = useState<string | null>(null);
  const [selectedFactory, setSelectedFactory] = useState<CustomFactory | null>(null);
  const [loadingNeighborhoods, setLoadingNeighborhoods] = useState(false);
  const [loadingFactories, setLoadingFactories] = useState(false);
  const [loadingFactoryDetail, setLoadingFactoryDetail] = useState(false);
  const [showNeighborhoodModal, setShowNeighborhoodModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [editingRow, setEditingRow] = useState<CustomFactoryRow | null>(null);
  const [showRowModal, setShowRowModal] = useState(false);
  const [neighborhoodDraftName, setNeighborhoodDraftName] = useState('');
  const [neighborhoodUploadFile, setNeighborhoodUploadFile] = useState<File | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingNeighborhood, setCreatingNeighborhood] = useState(false);
  const [savingRow, setSavingRow] = useState(false);
  const [rowSearchColumn, setRowSearchColumn] = useState<string>(ALL_COLUMNS_OPTION);
  const [rowSearchText, setRowSearchText] = useState('');
  const [rowStatusFilter, setRowStatusFilter] = useState<string | undefined>(undefined);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [factoryRowViewState, setFactoryRowViewState] = useState<Record<string, FactoryRowViewState>>({});
  const [visibleColumns, setVisibleColumns] = useState<Record<string, Set<string>>>({});
  
  // File input refs for fallback file selection
  const neighborhoodFileInputRef = useRef<HTMLInputElement>(null);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const [columnOrder, setColumnOrder] = useState<Record<string, string[]>>({});
  const [draggedFactoryId, setDraggedFactoryId] = useState<string | null>(null);
  const [draggedColumnKey, setDraggedColumnKey] = useState<string | null>(null);
  const [uploadForm] = Form.useForm();
  const [rowForm] = Form.useForm();
  const deferredRowSearchText = useDeferredValue(rowSearchText);
  const canSubmitNeighborhood = neighborhoodDraftName.trim().length > 0 && Boolean(neighborhoodUploadFile);

  const openNeighborhoodModal = useCallback(() => {
    setNeighborhoodDraftName('');
    setNeighborhoodUploadFile(null);
    setShowNeighborhoodModal(true);
  }, []);

  const updateFactoryViewState = useCallback((factoryId: string, nextState: Partial<FactoryRowViewState>) => {
    setFactoryRowViewState((current) => ({
      ...current,
      [factoryId]: {
        searchColumn: current[factoryId]?.searchColumn || ALL_COLUMNS_OPTION,
        searchText: current[factoryId]?.searchText || '',
        statusFilter: current[factoryId]?.statusFilter,
        ...nextState,
      },
    }));
  }, [ALL_COLUMNS_OPTION]);

  const getVisibleColumns = useCallback((factoryId: string, allColumns: string[]) => {
    if (!visibleColumns[factoryId] || visibleColumns[factoryId].size === 0) {
      return new Set(allColumns);
    }
    return visibleColumns[factoryId];
  }, [visibleColumns]);

  const toggleColumnVisibility = useCallback((factoryId: string, column: string) => {
    setVisibleColumns((current) => {
      const factoryVisible: Set<string> = current[factoryId]
        ? new Set<string>(Array.from(current[factoryId] as Set<string>))
        : new Set<string>();
      if (factoryVisible.has(column)) {
        factoryVisible.delete(column);
      } else {
        factoryVisible.add(column);
      }
      return { ...current, [factoryId]: factoryVisible };
    });
  }, []);

  const handleFactoryDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, factoryId: string) => {
    setDraggedFactoryId(factoryId);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('factoryId', factoryId);
    }
  }, []);

  const handleFactoryDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
      e.preventDefault();
    }
  }, []);

  const handleFactoryDrop = useCallback((e: React.DragEvent<HTMLDivElement>, targetFactoryId: string) => {
    e.preventDefault();
    const sourceFactoryId = e.dataTransfer?.getData('factoryId');
    
    if (!sourceFactoryId || sourceFactoryId === targetFactoryId) {
      setDraggedFactoryId(null);
      return;
    }

    const sourceIndex = factories.findIndex((f) => f._id === sourceFactoryId);
    const targetIndex = factories.findIndex((f) => f._id === targetFactoryId);

    if (sourceIndex !== -1 && targetIndex !== -1) {
      const reordered = [...factories];
      const [removed] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, removed);
      setFactories(reordered);
    }

    setDraggedFactoryId(null);
  }, [factories]);

  const handleFactoryDragEnd = useCallback(() => {
    setDraggedFactoryId(null);
  }, []);

  const getOrderedColumns = useCallback((factoryId: string, allColumns: string[]) => {
    const order = columnOrder[factoryId];
    if (!order || order.length === 0) {
      return allColumns;
    }
    // Return columns in stored order, then any new columns not in order
    const ordered = order.filter((col) => allColumns.includes(col));
    const newCols = allColumns.filter((col) => !order.includes(col));
    return [...ordered, ...newCols];
  }, [columnOrder]);

  const handleColumnDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, columnKey: string, factoryId: string) => {
    setDraggedColumnKey(columnKey);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('columnKey', columnKey);
      e.dataTransfer.setData('factoryId', factoryId);
    }
  }, []);

  const handleColumnDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
      e.preventDefault();
    }
  }, []);

  const handleColumnDrop = useCallback((e: React.DragEvent<HTMLDivElement>, targetColumnKey: string, factoryId: string) => {
    e.preventDefault();
    const sourceColumnKey = e.dataTransfer?.getData('columnKey');
    const sourceFactoryId = e.dataTransfer?.getData('factoryId');
    
    if (!sourceColumnKey || sourceFactoryId !== factoryId || sourceColumnKey === targetColumnKey) {
      setDraggedColumnKey(null);
      return;
    }

    const factory = factories.find((f) => f._id === factoryId);
    if (!factory) {
      setDraggedColumnKey(null);
      return;
    }

    const currentOrder = getOrderedColumns(factoryId, factory.columns);
    const sourceIndex = currentOrder.findIndex((col) => col === sourceColumnKey);
    const targetIndex = currentOrder.findIndex((col) => col === targetColumnKey);

    if (sourceIndex !== -1 && targetIndex !== -1) {
      const reordered = [...currentOrder];
      const [removed] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, removed);
      setColumnOrder((current) => ({ ...current, [factoryId]: reordered }));
    }

    setDraggedColumnKey(null);
  }, [factories, getOrderedColumns]);

  const handleColumnDragEnd = useCallback(() => {
    setDraggedColumnKey(null);
  }, []);

  const loadNeighborhoods = useCallback(async () => {
    setLoadingNeighborhoods(true);
    try {
      const data = await getFactoryNeighborhoods();
      setNeighborhoods(data);
      const fallbackNeighborhood = fixedNeighborhoodName || data[0]?.name || null;
      setSelectedNeighborhood((current) => {
        if (fixedNeighborhoodName && data.some((item) => item.name === fixedNeighborhoodName)) return fixedNeighborhoodName;
        if (current && data.some((item) => item.name === current)) return current;
        return fallbackNeighborhood;
      });
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    } finally {
      setLoadingNeighborhoods(false);
    }
  }, [fixedNeighborhoodName, message]);

  const loadFactories = useCallback(async (neighborhoodName: string) => {
    setLoadingFactories(true);
    try {
      const data = await getCustomFactories(neighborhoodName);
      setFactories(data);
      setSelectedFactoryId((current) => {
        if (fixedFactoryId && data.some((factory) => factory._id === fixedFactoryId)) return fixedFactoryId;
        if (current && data.some((factory) => factory._id === current)) return current;
        return data[0]?._id ?? null;
      });
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    } finally {
      setLoadingFactories(false);
    }
  }, [fixedFactoryId, message]);

  const loadFactoryDetail = useCallback(async (factoryId: string) => {
    setLoadingFactoryDetail(true);
    try {
      const data = await getCustomFactory(factoryId);
      setSelectedFactory(data);
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    } finally {
      setLoadingFactoryDetail(false);
    }
  }, [message]);

  useEffect(() => {
    loadNeighborhoods();
  }, [loadNeighborhoods]);

  useEffect(() => {
    if (!fixedNeighborhoodName) return;
    setSelectedNeighborhood(fixedNeighborhoodName);
  }, [fixedNeighborhoodName]);

  useEffect(() => {
    if (mode !== 'panel') return;
    if (!selectedNeighborhood) {
      setFactories([]);
      setSelectedFactory(null);
      setSelectedFactoryId(null);
      return;
    }
    loadFactories(selectedNeighborhood);
  }, [loadFactories, mode, selectedNeighborhood]);

  useEffect(() => {
    if (mode !== 'panel') return;
    if (!selectedFactoryId) {
      setSelectedFactory(null);
      return;
    }
    loadFactoryDetail(selectedFactoryId);
  }, [loadFactoryDetail, mode, selectedFactoryId]);

  useEffect(() => {
    if (mode !== 'panel' || !fixedFactoryId) return;
    setSelectedFactoryId(fixedFactoryId);
  }, [fixedFactoryId, mode]);

  useEffect(() => {
    if (!selectedFactoryId) {
      setRowSearchColumn(ALL_COLUMNS_OPTION);
      setRowSearchText('');
      setRowStatusFilter(undefined);
      return;
    }

    const nextViewState = factoryRowViewState[selectedFactoryId];
    setRowSearchColumn(nextViewState?.searchColumn || ALL_COLUMNS_OPTION);
    setRowSearchText(nextViewState?.searchText || '');
    setRowStatusFilter(nextViewState?.statusFilter);
  }, [ALL_COLUMNS_OPTION, factoryRowViewState, selectedFactoryId]);

  useEffect(() => {
    if (!selectedFactory?._id) return;
    if (defaultRowSearch === undefined) return;

    const parsed = parseFactorySearch(defaultRowSearch);
    const nextSearchText = parsed.term;
    const nextSearchColumn = defaultRowSearchColumn;

    setRowSearchColumn(nextSearchColumn);
    setRowSearchText(nextSearchText);
    updateFactoryViewState(selectedFactory._id, {
      searchColumn: nextSearchColumn,
      searchText: nextSearchText,
    });
  }, [defaultRowSearch, defaultRowSearchColumn, selectedFactory, updateFactoryViewState]);

  const handleCreateNeighborhood = async () => {
    const name = neighborhoodDraftName.trim();
    if (!name) {
      message.error('Model name is required before upload');
      return;
    }
    if (!neighborhoodUploadFile) {
      message.error('Model CSV file is required');
      return;
    }
    setCreatingNeighborhood(true);
    try {
      const created = await createFactoryNeighborhood({ name, file: neighborhoodUploadFile });
      message.success(`Model created: ${created.name}`);
      setShowNeighborhoodModal(false);
      setNeighborhoodDraftName('');
      setNeighborhoodUploadFile(null);
      await loadNeighborhoods();
      if (!fixedNeighborhoodName) {
        setSelectedNeighborhood(created.name);
      }
      await onNeighborhoodsChanged?.();
      onNeighborhoodCreated?.(created.name);
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    } finally {
      setCreatingNeighborhood(false);
    }
  };

  const handleUploadFactory = async (values: { neighborhoodName: string }) => {
    if (!uploadFile) {
      message.error('Spreadsheet file is required');
      return;
    }
    setUploading(true);
    try {
      const neighborhoodName = fixedNeighborhoodName || values.neighborhoodName;
      const result = await uploadCustomFactory({ neighborhoodName, file: uploadFile });
      const uploadedFactories = result.factories || [];
      message.success(uploadedFactories.length === 1
        ? `Component uploaded: ${uploadedFactories[0].name}`
        : `Components uploaded: ${uploadedFactories.length}`);
      setShowUploadModal(false);
      uploadForm.resetFields();
      setUploadFile(null);
      await loadNeighborhoods();
      await onNeighborhoodsChanged?.();
      const firstFactory = uploadedFactories[0];
      if (mode === 'panel' && firstFactory && (!fixedNeighborhoodName || firstFactory.neighborhoodName === fixedNeighborhoodName)) {
        setSelectedNeighborhood(firstFactory.neighborhoodName);
        await loadFactories(firstFactory.neighborhoodName);
        setSelectedFactoryId(firstFactory._id);
      }
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleEditRow = (row: CustomFactoryRow) => {
    if (!selectedFactory) return;
    setEditingRow(row);
    rowForm.setFieldsValue({
      owner: row.owner || '',
      state: row.state || 'staged',
      ...Object.fromEntries(selectedFactory.columns.map((column) => [column, row.values?.[column] ?? ''])),
    });
    setShowRowModal(true);
  };

  const handleSaveRow = async (values: Record<string, unknown>) => {
    if (!selectedFactory || !editingRow) return;
    setSavingRow(true);
    try {
      const nextFactory = await updateCustomFactoryRow(selectedFactory._id, editingRow._id, {
        owner: String(values.owner || ''),
        state: String(values.state || 'staged'),
        values: Object.fromEntries(selectedFactory.columns.map((column) => [column, values[column] ?? ''])),
      });
      setSelectedFactory(nextFactory);
      setFactories((current) => current.map((factory) => (factory._id === nextFactory._id ? nextFactory : factory)));
      setShowRowModal(false);
      setEditingRow(null);
      rowForm.resetFields();
      message.success('Component row updated');
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    } finally {
      setSavingRow(false);
    }
  };

  const handleDeleteRow = async (row: CustomFactoryRow) => {
    if (!selectedFactory) return;
    try {
      const nextFactory = await deleteCustomFactoryRow(selectedFactory._id, row._id);
      setSelectedFactory(nextFactory);
      setFactories((current) => current.map((factory) => (factory._id === nextFactory._id ? nextFactory : factory)));
      message.success('Component row deleted');
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    }
  };

  const handleBulkDeleteRows = async () => {
    if (!selectedFactory || !selectedRowKeys.length) return;

    Modal.confirm({
      title: `Delete ${selectedRowKeys.length} selected rows?`,
      content: `This will permanently remove ${selectedRowKeys.length} selected rows from ${selectedFactory.name}.`,
      okText: 'Delete Selected',
      okButtonProps: { danger: true },
      onOk: async () => {
        let nextFactory = selectedFactory;
        for (const rowId of selectedRowKeys) {
          nextFactory = await deleteCustomFactoryRow(selectedFactory._id, rowId);
        }
        setSelectedFactory(nextFactory);
        setFactories((current) => current.map((factory) => (factory._id === nextFactory._id ? nextFactory : factory)));
        setSelectedRowKeys([]);
        message.success(`Deleted ${selectedRowKeys.length} rows`);
      },
    });
  };

  const handleDeleteFactory = async (factory: CustomFactory) => {
    try {
      await deleteCustomFactory(factory._id);
      message.success(`Component deleted: ${factory.name}`);
      setSelectedFactory((current) => (current?._id === factory._id ? null : current));
      setSelectedFactoryId((current) => (current === factory._id ? null : current));
      await loadFactories(factory.neighborhoodName);
      await onNeighborhoodsChanged?.();
      await onFactoryDeleted?.(factory._id, factory.neighborhoodName);
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message);
    }
  };

  const handleDeleteNeighborhood = useCallback((name: string) => {
    Modal.confirm({
      title: `Delete model ${name}?`,
      icon: <ExclamationCircleOutlined />,
      okText: 'Delete Model',
      okType: 'danger',
      centered: true,
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <div>This will permanently delete the model and every component inside it.</div>
          <div style={{ color: '#b91c1c', fontWeight: 600 }}>This action cannot be undone.</div>
        </div>
      ),
      onOk: async () => {
        try {
          const result = await deleteFactoryNeighborhood(name);
          message.success(`Model deleted: ${result.name} (${result.deletedFactoryCount} components removed)`);
          setSelectedFactory(null);
          setSelectedFactoryId(null);
          setFactories([]);
          if (!fixedNeighborhoodName) {
            setSelectedNeighborhood(neighborhoods[0]?.name || null);
          }
          await onNeighborhoodsChanged?.();
          await onNeighborhoodDeleted?.(name);
        } catch (error: any) {
          message.error(error.response?.data?.error || error.message);
        }
      },
    });
  }, [fixedNeighborhoodName, message, onNeighborhoodDeleted, onNeighborhoodsChanged, neighborhoods]);

  const handleDeleteAllComponents = useCallback(async (name: string) => {
    if (!name) return;
    try {
      setLoadingFactories(true);
      const result = await deleteAllNeighborhoodComponents(name);
      message.success(`Deleted ${result.deletedFactoryCount} components from ${name}`);
      // Refresh lists
      await loadNeighborhoods();
      if (!fixedNeighborhoodName) setSelectedNeighborhood(neighborhoods[0]?.name || null);
      await onNeighborhoodsChanged?.();
      if (selectedNeighborhood) await loadFactories(selectedNeighborhood);
    } catch (error: any) {
      message.error(error.response?.data?.error || error.message || 'Failed to delete components');
    } finally {
      setLoadingFactories(false);
    }
  }, [fixedNeighborhoodName, loadFactories, loadNeighborhoods, message, neighborhoods, onNeighborhoodsChanged, selectedNeighborhood]);

  const rowColumns: ColumnsType<CustomFactoryRow> = useMemo(() => {
    const factoryId = selectedFactory?._id || '';
    const allColumns = selectedFactory?.columns || [];
    const currentVisibleColumns = getVisibleColumns(factoryId, allColumns);
    const foreignKeyByFieldName = new Map<string, ForeignKeyColumn>();
    (selectedFactory?.foreignKeyColumns || []).forEach((fk) => {
      [fk.fieldName, fk.targetColumnNameBase, fk.targetColumnName, fk.sourceColumnName, fk.name]
        .map(normalizeFkFieldName)
        .filter(Boolean)
        .forEach((key) => {
          if (!foreignKeyByFieldName.has(key)) foreignKeyByFieldName.set(key, fk);
        });
    });
    
    const dynamicColumns = allColumns
      // Always include FK_ columns, and respect visibility for others
      .filter((column) => column.toLowerCase().startsWith('fk_') || currentVisibleColumns.has(column))
      .map((column) => {
        // Check if this is a FK column by name prefix
        const isForeignKeyColumn = column.toLowerCase().startsWith('fk_');
        const foreignKeyColumn = foreignKeyByFieldName.get(normalizeFkFieldName(column));
        let targetTab: string | null = null;
        let targetSubtab: string | null = null;
        let searchField: string | null = null;

        if (isForeignKeyColumn) {
          const regexPattern = /FK_([^\[]+)\[([^\]]+)\]\.(.+)$/;
          const match = column.match(regexPattern);
          if (match) {
            targetTab = match[1];
            targetSubtab = match[2];
            searchField = match[3];
          }
        }

        if (foreignKeyColumn) {
          targetTab = foreignKeyColumn.targetGroup || targetTab;
          targetSubtab = foreignKeyColumn.targetScope || targetSubtab;
          searchField = foreignKeyColumn.targetColumnNameBase || foreignKeyColumn.targetColumnName || searchField || foreignKeyColumn.fieldName;
        }

        return {
          title: column,
          key: column,
          dataIndex: ['values', column],
          ellipsis: true,
          sorter: (left: CustomFactoryRow, right: CustomFactoryRow) => String(left.values?.[column] ?? '').localeCompare(String(right.values?.[column] ?? ''), undefined, { sensitivity: 'base', numeric: true }),
          render: (value: unknown, row: CustomFactoryRow) => {
            const display = displayValue(value);
            // FK columns are persisted using normalized field names, so match metadata as well as raw FK_ headers.
            if ((isForeignKeyColumn || foreignKeyColumn) && targetTab && targetSubtab && searchField && display !== '—') {
              const targetDataTab = getDataTabKeyForTargetScope(targetSubtab);
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent('navigateToApplication', {
                      detail: {
                        searchValue: display,
                        searchField: searchField,
                        sourceColumn: column,
                        targetTab: targetTab,
                        targetSubtab: targetSubtab,
                        targetDataTab,
                      },
                    }));
                  }}
                  style={{
                    color: '#0284c7',
                    textDecoration: 'underline',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                  title={`Navigate to ${targetTab} > ${targetSubtab}, search by ${searchField}: ${display}`}
                >
                  {display}
                </a>
              );
            }

            return display;
          },
        };
      });

    return [
      ...dynamicColumns,
      {
        title: 'Owner',
        key: 'owner',
        dataIndex: 'owner',
        width: 140,
        render: (value: string) => displayValue(value),
      },
      {
        title: 'Created',
        key: 'createdAt',
        dataIndex: 'createdAt',
        width: 130,
        render: (value: string) => (value ? new Date(value).toLocaleDateString() : '—'),
      },
      {
        title: 'Sourced From',
        key: 'sourcedFrom',
        dataIndex: 'sourcedFrom',
        width: 180,
        render: (value: string) => displayValue(value),
      },
      {
        title: 'Created By',
        key: 'createdBy',
        dataIndex: 'createdBy',
        width: 150,
        render: (value: string) => displayValue(value),
      },
      {
        title: 'Last Updated',
        key: 'updatedAt',
        dataIndex: 'updatedAt',
        width: 160,
        render: (value: string) => (value ? new Date(value).toLocaleString() : '—'),
      },
      {
        title: 'Updated By',
        key: 'updatedBy',
        dataIndex: 'updatedBy',
        width: 150,
        render: (value: string) => displayValue(value),
      },
      {
        title: 'Status',
        key: 'state',
        dataIndex: 'state',
        width: 110,
        render: (value: string) => {
          const nextValue = String(value || 'staged').toLowerCase();
          const color = nextValue === 'staged'
            ? 'green'
            : nextValue === 'invalid'
              ? 'red'
              : 'blue';
          return <Tag color={color}>{value || 'staged'}</Tag>;
        },
      },
      {
        title: '',
        key: 'actions',
        width: 90,
        render: (_value: unknown, row: CustomFactoryRow) => canManageFactories ? (
          <Space size="small">
            <Tooltip title="Edit row"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => handleEditRow(row)} /></Tooltip>
            <Popconfirm title="Delete this row?" onConfirm={() => handleDeleteRow(row)} okText="Delete" okButtonProps={{ danger: true }}>
              <Tooltip title="Delete row"><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Tooltip>
            </Popconfirm>
          </Space>
        ) : null,
      },
    ];
  }, [canManageFactories, selectedFactory, getVisibleColumns]);

  const filteredRows = useMemo(() => {
    if (!selectedFactory) return [];
    const parsedSearch = parseFactorySearch(deferredRowSearchText);
    const normalizedSearch = parsedSearch.term.trim().toLowerCase();

    return selectedFactory.rows.filter((row) => {
      const matchesStatus = !rowStatusFilter || (row.state || 'staged') === rowStatusFilter;
      if (!matchesStatus) return false;
      if (!normalizedSearch) return true;

      const columnsToSearch = rowSearchColumn === ALL_COLUMNS_OPTION
        ? selectedFactory.columns
        : [rowSearchColumn];

      return columnsToSearch.some((column) => {
        const candidate = String(row.values?.[column] ?? '').toLowerCase();
        return parsedSearch.exact ? candidate === normalizedSearch : candidate.includes(normalizedSearch);
      });
    });
  }, [ALL_COLUMNS_OPTION, deferredRowSearchText, rowSearchColumn, rowStatusFilter, selectedFactory]);

  if (mode === 'action') {
    return (
      <>
        {canManageFactories ? (
          <Space>
            {showCreateNeighborhood ? (
              <Button
                size="small"
                icon={<FolderAddOutlined />}
                onClick={openNeighborhoodModal}
                className="btn-create-model btn-import-framework"
              >
                Import Framework
              </Button>
            ) : null}
            {showAddFactory ? (
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  uploadForm.setFieldsValue({ neighborhoodName: fixedNeighborhoodName || selectedNeighborhood || undefined });
                  setShowUploadModal(true);
                }}
                style={{ fontSize: '10px', padding: '2px 8px', height: '20px', lineHeight: '20px' }}
              >
                Add Model
              </Button>
            ) : null}
            {showDeleteNeighborhood && fixedNeighborhoodName ? (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleDeleteNeighborhood(fixedNeighborhoodName)}
                style={{ fontSize: '10px', padding: '2px 8px', height: '20px', lineHeight: '20px' }}
              >
                Delete Framework
              </Button>
            ) : null}
            {showAddFactory && (fixedNeighborhoodName || selectedNeighborhood) ? (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => {
                  Modal.confirm({
                    title: `Delete all components in ${fixedNeighborhoodName || selectedNeighborhood}?`,
                    icon: <ExclamationCircleOutlined />,
                    okText: 'Delete All',
                    okType: 'danger',
                    centered: true,
                    content: (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <div>This will permanently delete all components in this model.</div>
                        <div style={{ color: '#b91c1c', fontWeight: 600 }}>This action cannot be undone.</div>
                      </div>
                    ),
                    onOk: () => {
                      const neighborhoodName = fixedNeighborhoodName || selectedNeighborhood;
                      if (!neighborhoodName) return;
                      return handleDeleteAllComponents(neighborhoodName);
                    },
                  });
                }}
                style={{ fontSize: '10px', padding: '2px 8px', height: '20px', lineHeight: '20px' }}
              >
                Delete Model
              </Button>
            ) : null}
          </Space>
        ) : null}

        <Modal
          title="Add Components from CSV"
          open={showUploadModal}
          onCancel={() => { setShowUploadModal(false); setUploadFile(null); }}
          onOk={() => uploadForm.submit()}
          okText={uploading ? 'Uploading…' : 'Upload'}
          confirmLoading={uploading}
        >
          <Form form={uploadForm} layout="vertical" onFinish={handleUploadFactory} className="mt-4">
            {fixedNeighborhoodName ? (
              <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
                Adding components in <strong>{fixedNeighborhoodName}</strong>
              </div>
            ) : (
              <Form.Item
                name="neighborhoodName"
                label={(
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span>Model</span>
                    {canManageFactories ? (
                      <Button size="small" type="link" icon={<FolderAddOutlined />} onClick={openNeighborhoodModal}>
                        Create Model
                      </Button>
                    ) : null}
                  </div>
                )}
                rules={[{ required: true, message: 'Model is required' }]}
              >
                <Select
                  placeholder="Select an existing model"
                  options={neighborhoods.map((item) => ({ label: item.name, value: item.name }))}
                />
              </Form.Item>
            )}
            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
              Component names are taken from spreadsheet column headings ending in <strong>Component</strong> or <strong>Components</strong>. Legacy <strong>Part</strong> headers are still accepted. Each derived component must include a unique <strong>{PRIMARY_KEY_COLUMN}</strong> value.
            </div>
            <Form.Item label="CSV File" required>
              <div style={{ marginBottom: 12 }}>
                <Upload.Dragger
                  accept=".csv"
                  maxCount={1}
                  beforeUpload={(file) => {
                    setUploadFile(file);
                    return false;
                  }}
                  onRemove={() => {
                    setUploadFile(null);
                  }}
                  fileList={uploadFile ? [uploadFile as any] : []}
                >
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p className="ant-upload-text">Upload a CSV file to create or update model components from component columns</p>
                </Upload.Dragger>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  ref={uploadFileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setUploadFile(file);
                  }}
                  style={{ display: 'none' }}
                />
                <Button
                  onClick={() => {
                    uploadFileInputRef.current?.click();
                  }}
                >
                  Browse Files
                </Button>
                <span style={{ color: '#64748b', fontSize: 12 }}>
                  {uploadFile ? `✓ ${uploadFile.name}` : 'No file selected'}
                </span>
              </div>
            </Form.Item>
          </Form>
        </Modal>

        <Modal
          title="Create Model from CSV"
          open={showNeighborhoodModal}
          onCancel={() => { setShowNeighborhoodModal(false); setNeighborhoodUploadFile(null); }}
          onOk={handleCreateNeighborhood}
          okText={creatingNeighborhood ? 'Creating…' : 'Create'}
          confirmLoading={creatingNeighborhood}
          okButtonProps={{ disabled: !canSubmitNeighborhood }}
        >
          <div className="mt-4">
            <div style={{ marginBottom: 8, fontWeight: 500 }}>Model Name</div>
            <Input value={neighborhoodDraftName} onChange={(event) => setNeighborhoodDraftName(event.target.value)} />
            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
              Upload the model catalog reference data for this model. The first row is treated as headers and the remaining rows are stored as the model catalog.
            </div>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>Model CSV</div>
            <div style={{ marginBottom: 12 }}>
              <Upload.Dragger
                accept=".csv"
                maxCount={1}
                beforeUpload={(file) => {
                  setNeighborhoodUploadFile(file);
                  return false;
                }}
                onRemove={() => {
                  setNeighborhoodUploadFile(null);
                }}
                fileList={neighborhoodUploadFile ? [neighborhoodUploadFile as any] : []}
              >
                <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                <p className="ant-upload-text">Upload a model CSV to store model catalog reference data</p>
              </Upload.Dragger>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                ref={neighborhoodFileInputRef}
                type="file"
                accept=".csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setNeighborhoodUploadFile(file);
                }}
                style={{ display: 'none' }}
              />
              <Button
                onClick={() => {
                  neighborhoodFileInputRef.current?.click();
                }}
              >
                Browse Files
              </Button>
              <span style={{ color: '#64748b', fontSize: 12 }}>
                {neighborhoodUploadFile ? `✓ ${neighborhoodUploadFile.name}` : 'No file selected'}
              </span>
            </div>
          </div>
        </Modal>
      </>
    );
  }

  return (
    <div className="flex h-full gap-3 p-3 min-h-0">
      {!hideFactoryList ? <Card
        title={fixedNeighborhoodName ? `${fixedNeighborhoodName} Components` : 'Models'}
        size="small"
        style={{ width: 380, minWidth: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'visible' }}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, height: '100%' }}
        extra={canManageFactories ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Button 
              size="large" 
              icon={<FolderAddOutlined />} 
              onClick={openNeighborhoodModal}
              className="btn-create-model"
            >
              Create Model
            </Button>
            <Popconfirm
              title={`Delete all components in ${selectedNeighborhood || 'selected model'}?`}
              description="This will permanently remove every component in the selected model. This does NOT delete the model itself."
              okText="Delete All"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDeleteAllComponents(selectedNeighborhood || '')}
            >
              <Button 
                size="large" 
                danger 
                disabled={!selectedNeighborhood}
              >
                Delete All
              </Button>
            </Popconfirm>
            <Button 
              size="large" 
              icon={<PlusOutlined />} 
              onClick={() => {
                uploadForm.setFieldsValue({ neighborhoodName: selectedNeighborhood || undefined });
                setShowUploadModal(true);
              }}
              className="btn-bulk-import"
            >
              Bulk Import BPMN 2.0 XML
            </Button>
          </div>
        ) : null}
      >
        {!fixedNeighborhoodName ? (
          <Select
            placeholder="Select a model"
            value={selectedNeighborhood || undefined}
            onChange={setSelectedNeighborhood}
            loading={loadingNeighborhoods}
            options={neighborhoods.map((neighborhood) => ({
              label: `${neighborhood.name} (${neighborhood.factoryCount})`,
              value: neighborhood.name,
            }))}
          />
        ) : (
          <div style={{ color: '#64748b', fontSize: 12 }}>
            Viewing components for <strong>{fixedNeighborhoodName}</strong>
          </div>
        )}

        <div style={{ minHeight: 0, overflowY: 'auto' }}>
          <List
            loading={loadingFactories}
            dataSource={factories}
            locale={{ emptyText: selectedNeighborhood ? 'No components in this model yet' : 'No models available' }}
            renderItem={(factory) => (
              <List.Item
                draggable
                onDragStart={(e) => handleFactoryDragStart(e, factory._id)}
                onDragOver={handleFactoryDragOver}
                onDrop={(e) => handleFactoryDrop(e, factory._id)}
                onDragEnd={handleFactoryDragEnd}
                actions={canManageFactories ? [
                  <Popconfirm
                    key="delete"
                    title={`Delete component ${factory.name}?`}
                    description="This removes the entire component and all of its rows."
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDeleteFactory(factory)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </Popconfirm>,
                ] : undefined}
                style={{
                  cursor: draggedFactoryId === factory._id ? 'grabbing' : 'grab',
                  borderRadius: 8,
                  paddingInline: 12,
                  background: draggedFactoryId === factory._id
                    ? '#dbeafe'
                    : selectedFactoryId === factory._id
                      ? '#eff6ff'
                      : undefined,
                  border: draggedFactoryId === factory._id
                    ? '2px solid #3b82f6'
                    : selectedFactoryId === factory._id
                      ? '1px solid #bfdbfe'
                      : '1px solid transparent',
                  marginBottom: 8,
                  opacity: draggedFactoryId === factory._id ? 0.6 : 1,
                  transition: 'all 0.2s ease-in-out',
                }}
                onClick={() => setSelectedFactoryId(factory._id)}
              >
                <List.Item.Meta
                  title={<span style={{ fontWeight: 700 }}>{factory.name}</span>}
                  description={`${factory.rowCount} rows · ${factory.columns.length} spreadsheet columns`}
                />
              </List.Item>
            )}
          />
        </div>
      </Card> : null}

      <Card
        size="small"
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, height: '100%' }}
      >
        {!selectedFactory && (loadingFactories || loadingFactoryDetail) ? <Spin /> : null}

        {!selectedFactory && !(loadingFactories || loadingFactoryDetail) ? (
          <div style={{ color: '#64748b' }}>Select a component to view spreadsheet-derived rows.</div>
        ) : null}

        {selectedFactory ? (
          <>
            <Space wrap>
              <Select
                value={rowSearchColumn}
                style={{ width: 220 }}
                onChange={(value) => {
                  setRowSearchColumn(value);
                  if (selectedFactory?._id) updateFactoryViewState(selectedFactory._id, { searchColumn: value });
                }}
                options={[
                  { label: 'All uploaded columns', value: ALL_COLUMNS_OPTION },
                  ...selectedFactory.columns.map((column) => ({ label: column, value: column })),
                ]}
              />
              <Input.Search
                allowClear
                placeholder="Search uploaded component rows"
                style={{ width: 280 }}
                value={rowSearchText}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  startTransition(() => {
                    setRowSearchText(nextValue);
                    if (selectedFactory?._id) updateFactoryViewState(selectedFactory._id, { searchText: nextValue });
                  });
                }}
              />
              <Select
                allowClear
                placeholder="Filter by status"
                style={{ width: 180 }}
                value={rowStatusFilter}
                onChange={(value) => {
                  setRowStatusFilter(value);
                  if (selectedFactory?._id) updateFactoryViewState(selectedFactory._id, { statusFilter: value });
                }}
                options={[
                  { label: 'invalid', value: 'invalid' },
                  { label: 'staged', value: 'staged' },
                  { label: 'published', value: 'published' },
                ]}
              />
              {selectedFactory?._id && selectedFactory?.columns && selectedFactory.columns.length > 0 ? (
                <Dropdown
                  menu={{
                    items: selectedFactory.columns.map((column) => ({
                      key: column,
                      label: (
                        <Checkbox
                          checked={getVisibleColumns(selectedFactory._id, selectedFactory.columns).has(column)}
                          onChange={() => toggleColumnVisibility(selectedFactory._id, column)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {column}
                        </Checkbox>
                      ),
                    })),
                  }}
                >
                  <Button size="small" icon={<ColumnHeightOutlined />}>Columns</Button>
                </Dropdown>
              ) : null}
              <Button onClick={() => {
                setRowSearchColumn(ALL_COLUMNS_OPTION);
                setRowSearchText('');
                setRowStatusFilter(undefined);
                if (selectedFactory?._id) {
                  updateFactoryViewState(selectedFactory._id, {
                    searchColumn: ALL_COLUMNS_OPTION,
                    searchText: '',
                    statusFilter: undefined,
                  });
                }
              }}>
                Clear Filters
              </Button>
              <span style={{ color: '#64748b', fontSize: 12 }}>
                Showing {filteredRows.length} of {selectedFactory.rows.length} rows
              </span>
              {canManageFactories ? (
                <Button danger size="small" icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} onClick={handleBulkDeleteRows}>
                  Delete Selected ({selectedRowKeys.length})
                </Button>
              ) : null}
            </Space>

            <Table
              rowKey="_id"
              dataSource={filteredRows}
              columns={enhanceColumnsWithSortAndFilters(rowColumns as any, filteredRows)}
              size="small"
              className={hideFactoryList ? 'component-rows-table component-rows-table--nested' : 'component-rows-table'}
              pagination={{ pageSize: 25, showSizeChanger: true, position: ['topRight'] }}
              scroll={{ x: 'max-content', y: hideFactoryList ? 'calc(100dvh - 590px)' : 'calc(100dvh - 360px)' }}
              rowSelection={canManageFactories ? {
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys as string[]),
              } : undefined}
            />
          </>
        ) : null}
      </Card>

      <Modal
        title="Create Model from CSV"
        open={showNeighborhoodModal}
        onCancel={() => { setShowNeighborhoodModal(false); setNeighborhoodUploadFile(null); }}
        onOk={handleCreateNeighborhood}
        okText={creatingNeighborhood ? 'Creating…' : 'Create'}
        confirmLoading={creatingNeighborhood}
        okButtonProps={{ disabled: !canSubmitNeighborhood }}
      >
        <div className="mt-4">
          <div style={{ marginBottom: 8, fontWeight: 500 }}>Model Name</div>
          <Input autoFocus value={neighborhoodDraftName} onChange={(event) => setNeighborhoodDraftName(event.target.value)} />
          <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
            Upload the model catalog reference data for this model. The first row is treated as headers and the remaining rows are stored as the model catalog.
          </div>
          <div style={{ marginBottom: 8, fontWeight: 500 }}>Model CSV</div>
          <Upload.Dragger
            accept=".csv"
            maxCount={1}
            beforeUpload={(file) => {
              setNeighborhoodUploadFile(file);
              return false;
            }}
            onRemove={() => {
              setNeighborhoodUploadFile(null);
            }}
            fileList={neighborhoodUploadFile ? [neighborhoodUploadFile as any] : []}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">Upload a model CSV to store model catalog reference data</p>
          </Upload.Dragger>
        </div>
      </Modal>

      <Modal
        title="Add Components from Spreadsheet"
        open={showUploadModal}
        onCancel={() => { setShowUploadModal(false); setUploadFile(null); }}
        onOk={() => uploadForm.submit()}
        okText={uploading ? 'Uploading…' : 'Upload'}
        confirmLoading={uploading}
      >
        <Form form={uploadForm} layout="vertical" onFinish={handleUploadFactory} className="mt-4">
          <Form.Item
            name="neighborhoodName"
            label={(
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span>Model</span>
                {canManageFactories ? (
                  <Button size="small" type="link" icon={<FolderAddOutlined />} onClick={openNeighborhoodModal}>
                    Create Model
                  </Button>
                ) : null}
              </div>
            )}
            rules={[{ required: true, message: 'Model is required' }]}
          >
            <Select
              placeholder="Select an existing model"
              options={neighborhoods.map((item) => ({ label: item.name, value: item.name }))}
            />
          </Form.Item>
          <div style={{ color: '#64748b', fontSize: 12, marginBottom: 12 }}>
            Component names are taken from spreadsheet column headings ending in <strong>Component</strong> or <strong>Components</strong>. Legacy <strong>Part</strong> headers are still accepted. Each derived component must include a unique <strong>{PRIMARY_KEY_COLUMN}</strong> value.
          </div>
          <Form.Item label="Spreadsheet" required>
            <Upload.Dragger
              accept=".xlsx,.xls,.csv"
              maxCount={1}
              beforeUpload={(file) => {
                setUploadFile(file);
                return false;
              }}
              onRemove={() => {
                setUploadFile(null);
              }}
              fileList={uploadFile ? [uploadFile as any] : []}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">Upload spreadsheet to create or update model components from component columns</p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Edit Factory Row"
        open={showRowModal}
        onCancel={() => { setShowRowModal(false); setEditingRow(null); }}
        onOk={() => rowForm.submit()}
        okText={savingRow ? 'Saving…' : 'Save'}
        confirmLoading={savingRow}
        width={720}
      >
        <Form form={rowForm} layout="vertical" onFinish={handleSaveRow} className="mt-4">
          {(selectedFactory?.columns || []).map((column) => (
            <Form.Item
              key={column}
              name={column}
              label={column}
              rules={column === PRIMARY_KEY_COLUMN ? [{ required: true, whitespace: true, message: 'name is required' }] : undefined}
            >
              <Input />
            </Form.Item>
          ))}
          <Form.Item name="owner" label="Owner">
            <Input />
          </Form.Item>
          <Form.Item name="state" label="Status">
            <Select options={[
              { label: 'invalid', value: 'invalid' },
              { label: 'staged', value: 'staged' },
              { label: 'published', value: 'published' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default memo(NeighborhoodFactory);