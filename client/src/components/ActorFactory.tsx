import { useState, useEffect, useCallback } from 'react';
import { Table, Input, Button, App as AntApp, Space, Tooltip, Modal, Form, Tag, Select } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import { getActors, createActor, updateActor, deleteActor, type ActorItem } from '../api';
import { getAllowedActions, getStatusTransitions, stateTagColor, transitionState, type StatusRefTransition } from '../stateUtils';
import { matchesFactorySearch, parseFactorySearch, encodeExactFactorySearch } from '../utils/factorySearch';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';

interface ActorFactoryProps {
  defaultSearch?: string;
  defaultAdd?: string;
  onItemAdded?: () => void;
  readOnly?: boolean;
  userRole?: string | null;
}

export default function ActorFactory({ defaultSearch, defaultAdd, onItemAdded, readOnly, userRole }: ActorFactoryProps) {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<ActorItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [exactSearch, setExactSearch] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<ActorItem | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [statusTransitions, setStatusTransitions] = useState<StatusRefTransition[]>([]);

  useEffect(() => {
    getStatusTransitions().then(setStatusTransitions).catch(() => setStatusTransitions([]));
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getActors();
      setItems(data);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { loadItems(); }, [loadItems]);

  useEffect(() => {
    if (defaultSearch !== undefined) {
      const parsed = parseFactorySearch(defaultSearch);
      setSearch(parsed.term);
      setExactSearch(parsed.exact);
    }
  }, [defaultSearch]);

  // Open Add modal when navigated from BpmnEditor properties panel
  useEffect(() => {
    console.log('[ActorFactory] defaultAdd effect:', defaultAdd);
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

  const handleEdit = (item: ActorItem) => {
    setEditingItem(item);
    form.setFieldsValue({
      name: item.name,
      role: item.role,
      description: item.description,
      owner: item.owner || '',
    });
    setShowForm(true);
  };

  const handleDelete = (item: ActorItem) => {
    modal.confirm({
      title: `Delete "${item.name}"?`,
      content: 'This will permanently remove this actor.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteActor(item._id);
        message.success('Deleted');
        loadItems();
      },
    });
  };

  const handleBulkDelete = () => {
    if (!selectedRowKeys.length) return;
    modal.confirm({
      title: `Delete ${selectedRowKeys.length} selected actors?`,
      content: `This will permanently remove ${selectedRowKeys.length} selected actors.`,
      okText: 'Delete Selected',
      okButtonProps: { danger: true },
      onOk: async () => {
        await Promise.all(selectedRowKeys.map((id) => deleteActor(id)));
        message.success(`Deleted ${selectedRowKeys.length} actors`);
        setSelectedRowKeys([]);
        loadItems();
      },
    });
  };

  const handleFormSubmit = async (values: { name: string; role?: string; description?: string; owner?: string }) => {
    try {
      const payload = {
        name: values.name,
        role: values.role || '',
        description: values.description || '',
        owner: values.owner || '',
      };
      if (editingItem) {
        await updateActor(editingItem._id, payload);
        message.success('Updated');
      } else {
        const created = await createActor({ ...payload, state: 'draft' });
        message.success('Created');
        setHighlightId(created._id);
        setTimeout(() => setHighlightId(null), 3000);
      }
      setShowForm(false);
      loadItems();
      onItemAdded?.();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const searchToken = exactSearch ? encodeExactFactorySearch(search) : search;
  const filtered = search
    ? items.filter((i) =>
        matchesFactorySearch([i.name, i.role, i.description], searchToken)
      )
    : items;

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', width: 220, sorter: (a: ActorItem, b: ActorItem) => a.name.localeCompare(b.name) },
    { title: 'Role', dataIndex: 'role', key: 'role', width: 200, sorter: (a: ActorItem, b: ActorItem) => (a.role || '').localeCompare(b.role || '') },
    { title: 'Description', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: 'Owner', dataIndex: 'owner', key: 'owner', width: 130, ellipsis: true,
      render: (v: string) => v || '—' },
    { title: 'Status', dataIndex: 'state', key: 'state', width: 140,
      filters: [...new Set(items.map(i => (i as any).state || 'published'))].sort().map(v => ({ text: v, value: v })),
      onFilter: (value: any, record: ActorItem) => ((record as any).state || 'published') === value,
      render: (val: string, record: ActorItem) => {
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
                  await transitionState('actors', record._id, action, userRole || '');
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
    { title: '', key: 'actions', width: 80, render: (_: unknown, record: ActorItem) => readOnly ? null : (
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
          placeholder="Search actors…"
          size="small"
          prefix={<SearchOutlined />}
          style={{ width: 280 }}
          allowClear
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setExactSearch(false);
          }}
        />
        <div className="flex-1" />
        <span className="text-xs text-gray-500">{filtered.length} items</span>
        {!readOnly && <Button danger size="small" icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} onClick={handleBulkDelete}>
          Delete Selected ({selectedRowKeys.length})
        </Button>}
        {userRole === 'Super' && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreate}>
          New Actor
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
          onChange: (keys) => setSelectedRowKeys(keys as string[]),
        }}
      />

      <Modal
        title={editingItem ? 'Edit Actor' : 'New Actor'}
        open={showForm}
        onCancel={() => setShowForm(false)}
        onOk={() => form.submit()}
        okText={editingItem ? 'Update' : 'Create'}
        width={500}
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" onFinish={handleFormSubmit} className="mt-4">
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Customer, Agent, Technician" />
          </Form.Item>
          <Form.Item name="role" label="Role">
            <Input placeholder="e.g. End User, Support Staff, Field Engineer" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Brief description of this actor's responsibilities" />
          </Form.Item>
          <Form.Item name="owner" label="Owner">
            <Input placeholder="Owner name or ID" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
