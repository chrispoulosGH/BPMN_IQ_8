import { useState, useEffect, useCallback } from 'react';
import { Table, Input, Button, App as AntApp, Space, Tooltip, Modal, Form, Tag, Select } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { getRefItems, createRefItem, updateRefItem, deleteRefItem, type RefItem } from '../api';
import { getAllowedActions, getStatusTransitions, stateTagColor, transitionState, type StatusRefTransition } from '../stateUtils';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';

interface ReferenceFactoryProps {
  collection: string;
  title: string;
  defaultSearch?: string;
  defaultAdd?: string;
  onItemAdded?: () => void;
  readOnly?: boolean;
  userRole?: string | null;
}

export default function ReferenceFactory({ collection, title, defaultSearch, defaultAdd, onItemAdded, readOnly, userRole }: ReferenceFactoryProps) {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<RefItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<RefItem | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [statusTransitions, setStatusTransitions] = useState<StatusRefTransition[]>([]);

  useEffect(() => {
    getStatusTransitions().then(setStatusTransitions).catch(() => setStatusTransitions([]));
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRefItems(collection);
      setItems(data);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [collection, message]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // Sync external search prop
  useEffect(() => {
    if (defaultSearch !== undefined) setSearch(defaultSearch);
  }, [defaultSearch]);

  // Open add form when defaultAdd prop changes
  useEffect(() => {
    if (defaultAdd) {
      setEditingItem(null);
      form.resetFields();
      form.setFieldsValue({ name: defaultAdd });
      setShowForm(true);
    }
  }, [defaultAdd, form]);

  const handleCreate = () => {
    setEditingItem(null);
    form.resetFields();
    setShowForm(true);
  };

  const handleEdit = (item: RefItem) => {
    setEditingItem(item);
    form.setFieldsValue({ name: item.name, owner: item.owner || '' });
    setShowForm(true);
  };

  const handleDelete = (item: RefItem) => {
    modal.confirm({
      title: `Delete "${item.name}"?`,
      content: `This will permanently remove this ${title.toLowerCase()} entry.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteRefItem(collection, item._id);
        message.success('Deleted');
        loadItems();
      },
    });
  };

  const handleBulkDelete = () => {
    if (!selectedRowKeys.length) return;

    modal.confirm({
      title: `Delete ${selectedRowKeys.length} ${title.toLowerCase()} entr${selectedRowKeys.length === 1 ? 'y' : 'ies'}?`,
      content: `This will permanently remove ${selectedRowKeys.length} selected ${title.toLowerCase()} entr${selectedRowKeys.length === 1 ? 'y' : 'ies'}.`,
      okText: 'Delete Selected',
      okButtonProps: { danger: true },
      onOk: async () => {
        await Promise.all(selectedRowKeys.map((id) => deleteRefItem(collection, String(id))));
        message.success(`Deleted ${selectedRowKeys.length} ${title.toLowerCase()} entr${selectedRowKeys.length === 1 ? 'y' : 'ies'}`);
        setSelectedRowKeys([]);
        loadItems();
      },
    });
  };

  const handleFormSubmit = async (values: { name: string; owner?: string }) => {
    try {
      if (editingItem) {
        await updateRefItem(collection, editingItem._id, values.name, values.owner);
        message.success('Updated');
      } else {
        const created = await createRefItem(collection, values.name, values.owner, 'draft');
        message.success('Created');
        onItemAdded?.();
        setHighlightId(created._id);
        setTimeout(() => setHighlightId(null), 3000);
      }
      setShowForm(false);
      loadItems();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const filtered = search
    ? items.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
    : items;

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', sorter: (a: RefItem, b: RefItem) => a.name.localeCompare(b.name) },
    { title: 'Owner', dataIndex: 'owner', key: 'owner', width: 150, ellipsis: true,
      render: (v: string) => v || '—' },
    { title: 'Created', dataIndex: 'createdAt', key: 'createdAt', width: 160,
      render: (v: string) => v ? new Date(v).toLocaleDateString() : '—' },
    { title: 'Status', dataIndex: 'state', key: 'state', width: 140,
      filters: [...new Set(items.map(i => (i as any).state || 'published'))].sort().map(v => ({ text: v, value: v })),
      onFilter: (value: any, record: RefItem) => ((record as any).state || 'published') === value,
      render: (val: string, record: RefItem) => {
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
                  await transitionState(collection, record._id, action, userRole || '');
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
    { title: '', key: 'actions', width: 80, render: (_: unknown, record: RefItem) => readOnly ? null : (
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
          placeholder={`Search ${title.toLowerCase()}…`}
          size="small"
          prefix={<SearchOutlined />}
          style={{ width: 240 }}
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex-1" />
        <span className="text-xs text-gray-500">{filtered.length} items</span>
        {!readOnly && <Button danger size="small" icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} onClick={handleBulkDelete}>
          Delete Selected ({selectedRowKeys.length})
        </Button>}
        {userRole === 'Super' && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreate}>
          New {title}
        </Button>}
      </div>

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
          onChange: (keys) => setSelectedRowKeys(keys),
        }}
      />

      <Modal
        title={editingItem ? `Edit ${title}` : `New ${title}`}
        open={showForm}
        onCancel={() => setShowForm(false)}
        onOk={() => form.submit()}
        okText={editingItem ? 'Update' : 'Create'}
        width={400}
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" onFinish={handleFormSubmit} className="mt-4">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="owner" label="Owner">
            <Input placeholder="Owner name or ID" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
