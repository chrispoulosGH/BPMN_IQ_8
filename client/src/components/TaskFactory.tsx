import { useState, useEffect, useCallback } from 'react';
import { Table, Select, Input, Button, Modal, Form, Tag, App as AntApp, Space, Tooltip, Typography } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import type { TaskRecord, TaskCreatePayload, ReferenceData, TaskAddData } from '../types';
import { getTasks, getTaskReference, createTask, updateTask, deleteTask } from '../api';
import { getAllowedActions, getStatusTransitions, stateTagColor, transitionState, type StatusRefTransition } from '../stateUtils';
import { parseFactorySearch } from '../utils/factorySearch';
import { enhanceColumnsWithSortAndFilters } from '../utils/tableEnhancer';

interface TaskFactoryProps {
  defaultSearch?: string;
  defaultAddData?: TaskAddData;
  onItemAdded?: () => void;
  onNavigateToFactory?: (tab: string, search: string) => void;
  readOnly?: boolean;
  userRole?: string | null;
}

export default function TaskFactory({ defaultSearch, defaultAddData, onItemAdded, onNavigateToFactory, readOnly, userRole }: TaskFactoryProps = {}) {
  const { message, modal } = AntApp.useApp();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [refData, setRefData] = useState<ReferenceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskRecord | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [statusTransitions, setStatusTransitions] = useState<StatusRefTransition[]>([]);

  useEffect(() => {
    getStatusTransitions().then(setStatusTransitions).catch(() => setStatusTransitions([]));
  }, []);

  // Load reference data once
  useEffect(() => {
    getTaskReference().then(setRefData).catch((e) => message.error(e.message));
  }, [message]);

  // Sync external search prop
  useEffect(() => {
    if (defaultSearch !== undefined) setFilters((f) => ({ ...f, search: defaultSearch }));
  }, [defaultSearch]);

  // Open add form when defaultAddData prop changes
  useEffect(() => {
    if (defaultAddData) {
      setEditingTask(null);
      form.resetFields();
      const formValues: Record<string, unknown> = { name: defaultAddData.name };
      if (defaultAddData.applications?.length) formValues.applications = defaultAddData.applications;
      if (defaultAddData.actor) formValues.actor = defaultAddData.actor;
      if (defaultAddData.businessFlow) formValues.businessFlow = defaultAddData.businessFlow;
      if (defaultAddData.product) formValues.product = defaultAddData.product;
      if (defaultAddData.channel) formValues.channel = defaultAddData.channel;
      if (defaultAddData.domain) formValues.domain = defaultAddData.domain;
      if (defaultAddData.subdomain) formValues.subdomain = defaultAddData.subdomain;
      form.setFieldsValue(formValues);
      setShowForm(true);
    }
  }, [defaultAddData, form]);

  // Load tasks when filters change
  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const cleanFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
      const parsedSearch = parseFactorySearch(cleanFilters.search);
      if (parsedSearch.term) {
        cleanFilters.search = parsedSearch.term;
        if (parsedSearch.exact) cleanFilters.exact = '1';
      }
      const data = await getTasks(cleanFilters);
      setTasks(data);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters, message]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const handleCreate = () => {
    setEditingTask(null);
    form.resetFields();
    setShowForm(true);
  };

  const handleEdit = (task: TaskRecord) => {
    setEditingTask(task);
    form.setFieldsValue(task);
    setShowForm(true);
  };

  const handleDelete = (task: TaskRecord) => {
    modal.confirm({
      title: `Delete "${task.name}"?`,
      content: `This will permanently remove the task from ${task.businessFlow} / ${task.product}.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteTask(task._id);
        message.success('Task deleted');
        loadTasks();
      },
    });
  };

  const handleBulkDelete = () => {
    if (!selectedRowKeys.length) return;
    modal.confirm({
      title: `Delete ${selectedRowKeys.length} selected tasks?`,
      content: `This will permanently remove ${selectedRowKeys.length} selected tasks.`,
      okText: 'Delete Selected',
      okButtonProps: { danger: true },
      onOk: async () => {
        await Promise.all(selectedRowKeys.map((id) => deleteTask(id)));
        message.success(`Deleted ${selectedRowKeys.length} tasks`);
        setSelectedRowKeys([]);
        loadTasks();
      },
    });
  };

  const handleFormSubmit = async (values: TaskCreatePayload) => {
    try {
      if (editingTask) {
        await updateTask(editingTask._id, values);
        message.success('Task updated');
      } else {
        const created = await createTask({ ...values, state: 'draft' } as any);
        message.success('Task created');
        onItemAdded?.();
        setHighlightId(created._id);
        setTimeout(() => setHighlightId(null), 3000);
      }
      setShowForm(false);
      loadTasks();
    } catch (e: any) {
      message.error(e.response?.data?.error || e.message);
    }
  };

  const columns = [
    { title: 'Task Name', dataIndex: 'name', key: 'name', ellipsis: true, width: 220 },
    { title: 'Business Flow', dataIndex: 'businessFlow', key: 'businessFlow', ellipsis: true, width: 180,
      render: (v: string) => v ? <Typography.Link onClick={() => onNavigateToFactory?.('businessFlows', v)}>{v}</Typography.Link> : '—' },
    { title: 'Product', dataIndex: 'product', key: 'product', width: 140,
      render: (v: string) => v ? <Typography.Link onClick={() => onNavigateToFactory?.('products', v)}>{v}</Typography.Link> : '—' },
    { title: 'Channel', dataIndex: 'channel', key: 'channel', width: 90,
      render: (v: string) => v ? <Typography.Link onClick={() => onNavigateToFactory?.('channels', v)}>{v}</Typography.Link> : '—' },
    { title: 'Actor', dataIndex: 'actor', key: 'actor', width: 130,
      render: (v: string) => v ? <Typography.Link onClick={() => onNavigateToFactory?.('actors', v)}>{v}</Typography.Link> : <Tag>—</Tag>,
    },
    { title: 'Applications', dataIndex: 'applications', key: 'applications', ellipsis: true,
      render: (apps: string[]) => apps?.length
        ? apps.slice(0, 2).map((a, i) => (
            <span key={a}>{i > 0 && ', '}<Typography.Link onClick={() => onNavigateToFactory?.('applications', a)}>{a}</Typography.Link></span>
          )).concat(apps.length > 2 ? [<span key="more"> +{apps.length - 2}</span>] : [])
        : '—',
    },
    { title: 'Owner', dataIndex: 'owner', key: 'owner', width: 130, ellipsis: true,
      render: (v: string) => v || '—' },
    { title: 'Status', dataIndex: 'state', key: 'state', width: 140,
      filters: [...new Set(tasks.map(t => (t as any).state || 'published'))].sort().map(v => ({ text: v, value: v })),
      onFilter: (value: any, record: TaskRecord) => ((record as any).state || 'published') === value,
      render: (val: string, record: TaskRecord) => {
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
                  await transitionState('tasks', record._id, action, userRole || '');
                  loadTasks();
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
    { title: '', key: 'actions', width: 80, render: (_: unknown, record: TaskRecord) => readOnly ? null : (
      <Space size="small">
        <Tooltip title="Edit"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} /></Tooltip>
        <Tooltip title="Delete"><Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record)} /></Tooltip>
      </Space>
    )},
  ];

  const filterSelect = (label: string, field: string, options: { name: string }[]) => (
    <Select
      placeholder={label}
      allowClear
      showSearch
      size="small"
      style={{ width: 160 }}
      value={filters[field] || undefined}
      onChange={(v) => setFilters((f) => ({ ...f, [field]: v || '' }))}
      options={options.map((o) => ({ label: o.name, value: o.name }))}
    />
  );

  return (
    <div className="flex flex-col h-full p-3 gap-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {refData && (
          <>
            {filterSelect('Business Flow', 'businessFlow', refData.businessFlows)}
            {filterSelect('Product', 'product', refData.products)}
            {filterSelect('Actor', 'actor', refData.actors)}
            {filterSelect('Channel', 'channel', refData.channels)}
          </>
        )}
        <Input
          placeholder="Search tasks…"
          size="small"
          prefix={<SearchOutlined />}
          style={{ width: 180 }}
          allowClear
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        />
        <div className="flex-1" />
        {!readOnly && <Button danger size="small" icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} onClick={handleBulkDelete}>
          Delete Selected ({selectedRowKeys.length})
        </Button>}
        {userRole === 'Super' && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreate}>
          New Task
        </Button>}
      </div>

      {/* Table */}
      <Table
        dataSource={tasks}
        columns={enhanceColumnsWithSortAndFilters(columns as any, tasks)}
        rowKey="_id"
        size="small"
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `${t} tasks`, position: ['topRight'] }}
        className="flex-1"
        scroll={{ y: 'calc(var(--app-h) - 220px)' }}
        rowClassName={(record) => record._id === highlightId ? 'row-just-created' : ''}
        rowSelection={readOnly ? undefined : {
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as string[]),
        }}
      />

      {/* Create/Edit Modal */}
      <Modal
        title={editingTask ? 'Edit Task' : 'New Task'}
        open={showForm}
        onCancel={() => setShowForm(false)}
        onOk={() => form.submit()}
        okText={editingTask ? 'Update' : 'Create'}
        width={560}
        destroyOnClose={false}
        forceRender
      >
        <Form form={form} layout="vertical" onFinish={handleFormSubmit} className="mt-4">
          <Form.Item name="name" label="Task Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="businessFlow" label="Business Flow" rules={[{ required: true }]}>
              <Select showSearch options={refData?.businessFlows.map((b) => ({ label: b.name, value: b.name }))} />
            </Form.Item>
            <Form.Item name="product" label="Product" rules={[{ required: true }]}>
              <Select showSearch options={refData?.products.map((p) => ({ label: p.name, value: p.name }))} />
            </Form.Item>
            <Form.Item name="actor" label="Actor">
              <Select allowClear showSearch options={refData?.actors.map((p) => ({ label: p.name, value: p.name }))} />
            </Form.Item>
            <Form.Item name="channel" label="Channel">
              <Select allowClear showSearch options={refData?.channels.map((c) => ({ label: c.name, value: c.name }))} />
            </Form.Item>
            <Form.Item name="domain" label="Domain">
              <Select allowClear showSearch options={refData?.domains.map((d) => ({ label: d.name, value: d.name }))} />
            </Form.Item>
            <Form.Item name="subdomain" label="Subdomain">
              <Select allowClear showSearch options={refData?.subdomains.map((s) => ({ label: s.name, value: s.name }))} />
            </Form.Item>
          </div>
          <Form.Item name="applications" label="Applications">
            <Select mode="multiple" allowClear showSearch options={refData?.applications.map((a) => ({ label: a.name, value: a.name }))} />
          </Form.Item>
          <Form.Item name="owner" label="Owner">
            <Input placeholder="Owner name or ID" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
