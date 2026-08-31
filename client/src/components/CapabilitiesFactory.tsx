import { useState, useEffect, useCallback } from 'react';
import { Table, Input, Button, App as AntApp, Space, Tooltip, Modal, Form, Typography, Tag, Select } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { getCapabilities, createCapability, updateCapability, deleteCapability, type CapabilityItem } from '../api';
import { getAllowedActions, getStatusTransitions, stateTagColor, transitionState, type StatusRefTransition } from '../stateUtils';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';

interface CapabilitiesFactoryProps {
  onNavigateToFactory?: (tab: string, search: string) => void;
  readOnly?: boolean;
  userRole?: string | null;
  defaultSearch?: string;
  focusCapabilityNames?: string[];
  focusDiagramName?: string | null;
  onClearFocus?: () => void;
}

export default function CapabilitiesFactory({
  onNavigateToFactory,
  readOnly,
  userRole,
  defaultSearch = '',
  focusCapabilityNames = [],
  focusDiagramName,
  onClearFocus,
}: CapabilitiesFactoryProps = {}) {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<CapabilityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState(defaultSearch);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<CapabilityItem | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [statusTransitions, setStatusTransitions] = useState<StatusRefTransition[]>([]);

  useEffect(() => {
    getStatusTransitions().then(setStatusTransitions).catch(() => setStatusTransitions([]));
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getCapabilities();
      setItems(data);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { loadItems(); }, [loadItems]);

  useEffect(() => {
    setSearch(defaultSearch || '');
  }, [defaultSearch]);

  const handleCreate = () => {
    setEditingItem(null);
    form.resetFields();
    setShowForm(true);
  };

  const handleEdit = (item: CapabilityItem) => {
    setEditingItem(item);
    form.setFieldsValue({
      name: item.name,
      domainName: item.domainName,
      aspect: item.aspect,
      briefDescription: item.briefDescription,
      tmfVersion: item.tmfVersion,
      owner: item.owner || '',
    });
    setShowForm(true);
  };

  const handleDelete = (item: CapabilityItem) => {
    modal.confirm({
      title: `Delete "${item.name}"?`,
      content: 'This will permanently remove this business capability entry.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteCapability(item._id);
        message.success('Deleted');
        loadItems();
      },
    });
  };

  const handleBulkDelete = () => {
    if (!selectedRowKeys.length) return;
    modal.confirm({
      title: `Delete ${selectedRowKeys.length} selected capabilities?`,
      content: `This will permanently remove ${selectedRowKeys.length} selected capabilities.`,
      okText: 'Delete Selected',
      okButtonProps: { danger: true },
      onOk: async () => {
        await Promise.all(selectedRowKeys.map((id) => deleteCapability(id)));
        message.success(`Deleted ${selectedRowKeys.length} capabilities`);
        setSelectedRowKeys([]);
        loadItems();
      },
    });
  };

  const handleFormSubmit = async (values: { name: string; domainName?: string; aspect?: string; briefDescription?: string; tmfVersion?: string; owner?: string }) => {
    try {
      const payload = {
        name: values.name,
        domainName: values.domainName || '',
        aspect: values.aspect || '',
        briefDescription: values.briefDescription || '',
        tmfVersion: values.tmfVersion || 'GB1029C',
        owner: values.owner || '',
      };
      if (editingItem) {
        await updateCapability(editingItem._id, payload);
        message.success('Updated');
      } else {
        const created = await createCapability({ ...payload, state: 'draft' });
        message.success('Created');
        setHighlightId(created._id);
        setTimeout(() => setHighlightId(null), 3000);
      }
      setShowForm(false);
      loadItems();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const focusNamesSet = new Set(focusCapabilityNames.map((n) => n.toLowerCase()));

  const filteredByFocus = focusNamesSet.size
    ? items.filter((i) => focusNamesSet.has((i.name || '').toLowerCase()))
    : items;

  const searchTerms = search
    .toLowerCase()
    .replace(/>/g, ',')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const filtered = searchTerms.length
    ? filteredByFocus.filter((i) => {
        const haystack = `${i.name || ''} ${i.domainName || ''} ${i.aspect || ''}`.toLowerCase();
        return searchTerms.every((term) => haystack.includes(term));
      })
    : filteredByFocus;

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', width: 260, sorter: (a: CapabilityItem, b: CapabilityItem) => a.name.localeCompare(b.name) },
    { title: 'Domain', dataIndex: 'domainName', key: 'domainName', width: 200, sorter: (a: CapabilityItem, b: CapabilityItem) => (a.domainName || '').localeCompare(b.domainName || ''),
      render: (v: string) => v ? <Typography.Link onClick={() => onNavigateToFactory?.('domains', v)}>{v}</Typography.Link> : '—' },
    { title: 'Aspect', dataIndex: 'aspect', key: 'aspect', width: 180, sorter: (a: CapabilityItem, b: CapabilityItem) => (a.aspect || '').localeCompare(b.aspect || '') },
    { title: 'Description', dataIndex: 'briefDescription', key: 'briefDescription', ellipsis: true },
    { title: 'TMF Version', dataIndex: 'tmfVersion', key: 'tmfVersion', width: 110 },
    { title: 'Owner', dataIndex: 'owner', key: 'owner', width: 130, ellipsis: true,
      render: (v: string) => v || '—' },
    { title: 'Status', dataIndex: 'state', key: 'state', width: 140,
      filters: [...new Set(items.map(i => (i as any).state || 'published'))].sort().map(v => ({ text: v, value: v })),
      onFilter: (value: any, record: CapabilityItem) => ((record as any).state || 'published') === value,
      render: (val: string, record: CapabilityItem) => {
        const currentState = (val || 'published').toLowerCase();
        const actions = getAllowedActions(statusTransitions, userRole, currentState);
        const tagColor = stateTagColor(currentState);
        if (!actions.length || readOnly) {
          return <Tag color={tagColor}>{currentState}</Tag>;
        }
        return (
          <Select
            size="small"
            value="__current__"
            style={{ width: '100%' }}
            onChange={async (action) => {
              const rule = statusTransitions.find(t => t.action === action && t.from === currentState);
              if (rule) {
                try {
                  await transitionState('capabilities', record._id, action, userRole || '');
                  loadItems();
                } catch (e: any) { message.error(e.response?.data?.error || e.message); }
              }
            }}
            options={[
              { label: <Tag color={tagColor}>{currentState}</Tag>, value: '__current__', disabled: true },
              ...actions.map(a => ({ label: `${a.action} → ${a.to}`, value: a.action })),
            ]}
          />
        );
      },
    },
    { title: '', key: 'actions', width: 80, render: (_: unknown, record: CapabilityItem) => readOnly ? null : (
      <Space size="small">
        <Tooltip title="Edit"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} /></Tooltip>
        <Tooltip title="Delete"><Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} /></Tooltip>
      </Space>
    )},
  ];

  return (
    <div className="flex flex-col h-full p-3 gap-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search capabilities…"
          size="small"
          prefix={<SearchOutlined />}
          value={search}
          style={{ width: 280 }}
          allowClear
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex-1" />
        <span className="text-xs text-gray-500">{filtered.length} items</span>
        {!readOnly && <Button danger size="small" icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} onClick={handleBulkDelete}>
          Delete Selected ({selectedRowKeys.length})
        </Button>}
        {userRole === 'Super' && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreate}>
          New Capability
        </Button>}
      </div>

      {focusNamesSet.size > 0 && (
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <Tag color="blue">Capability Name Filter</Tag>
          <span>
            {`Showing only selected capability name${focusNamesSet.size > 1 ? 's' : ''}`}
          </span>
          <Button size="small" type="link" onClick={onClearFocus}>Clear</Button>
        </div>
      )}

      <Table
        dataSource={filtered}
        columns={enhanceColumnsWithSortAndFilters(columns as any, filtered)}
        rowKey="_id"
        size="small"
        loading={loading}
        pagination={{ pageSize: 25, showSizeChanger: true, showTotal: (t) => `${t} items`, position: ['topRight'] }}
        className="flex-1"
        scroll={{ y: 'calc(var(--app-h) - 220px)' }}
        rowClassName={(record) => record._id === highlightId ? 'row-just-created' : ''}
        rowSelection={readOnly ? undefined : {
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as string[]),
        }}
      />

      <Modal
        title={editingItem ? 'Edit Capability' : 'New Capability'}
        open={showForm}
        onCancel={() => setShowForm(false)}
        onOk={() => form.submit()}
        okText={editingItem ? 'Update' : 'Create'}
        width={560}
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" onFinish={handleFormSubmit} className="mt-4">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="domainName" label="Domain Name">
            <Input placeholder="e.g. Operations - Customer Domain" />
          </Form.Item>
          <Form.Item name="aspect" label="Aspect">
            <Input placeholder="e.g. Strategy, Infrastructure, Product" />
          </Form.Item>
          <Form.Item name="briefDescription" label="Brief Description">
            <Input.TextArea rows={3} placeholder="Short description of this capability" />
          </Form.Item>
          <Form.Item name="tmfVersion" label="TMF Version" initialValue="GB1029C">
            <Input placeholder="GB1029C" />
          </Form.Item>
          <Form.Item name="owner" label="Owner">
            <Input placeholder="Owner name or ID" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
