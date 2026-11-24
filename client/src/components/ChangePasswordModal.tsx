import { useState } from 'react';
import { Alert, Form, Input, Modal, message } from 'antd';
import api from '../api';

/** The signed-in user changes their own password (PUT /api/auth/password). */
export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<{ currentPassword: string; newPassword: string; confirm: string }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    form.resetFields();
    setError(null);
    onClose();
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    setError(null);
    try {
      await api.put('/auth/password', { currentPassword: values.currentPassword || '', newPassword: values.newPassword });
      message.success('Password changed');
      close();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not change the password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Change password" open={open} onOk={submit} onCancel={close} okText="Change password" confirmLoading={saving} destroyOnClose>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={submit}>
        <Form.Item name="currentPassword" label="Current password" extra="Leave blank if your account has no password yet.">
          <Input.Password autoComplete="current-password" autoFocus />
        </Form.Item>
        <Form.Item name="newPassword" label="New password" rules={[{ required: true, message: 'Enter a new password' }, { min: 6, message: 'At least 6 characters' }]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="Confirm new password"
          dependencies={['newPassword']}
          rules={[
            { required: true, message: 'Enter the new password again' },
            ({ getFieldValue }) => ({
              validator: (_, value) => (!value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('The passwords do not match'))),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" onPressEnter={submit} />
        </Form.Item>
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Form>
    </Modal>
  );
}
