import { useState } from 'react';
import { Modal } from 'antd';
import type { LinkedSystemComponentRecord } from '../api';
import type { LinkedRecordsModalState } from '../hooks/useLinkedSystemComponents';

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

export interface LinkedRecordsModalProps {
  state: LinkedRecordsModalState;
  onClose: () => void;
}

// Generic "what's linked to this application" dialog — same component used
// from the Diagrams tab (BpmnEditor) and the Frameworks tab Model Components
// tree (ComponentsViewer). Renders whatever fields a record actually has;
// no per-type field list.
export default function LinkedRecordsModal({ state, onClose }: LinkedRecordsModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRecord: LinkedSystemComponentRecord | null = state.records.find((record) => record.id === selectedId) || null;

  return (
    <Modal
      title={`${state.componentType}${state.appName ? ` - ${state.appName}` : ''}`}
      open={state.open}
      onCancel={onClose}
      afterClose={() => setSelectedId(null)}
      footer={null}
      width={1200}
      destroyOnClose
    >
      <div className="grid grid-cols-12 gap-3" style={{ minHeight: 520 }}>
        <div className="col-span-4 border border-gray-200 rounded overflow-hidden">
          <div className="px-3 py-2 text-xs text-gray-500 border-b bg-gray-50">{state.componentType} ({state.records.length})</div>
          <div style={{ maxHeight: 480, overflowY: 'auto' }}>
            {state.loading ? (
              <div className="p-4 text-sm text-gray-500">Loading {state.componentType.toLowerCase()}...</div>
            ) : !state.records.length ? (
              <div className="p-4 text-sm text-gray-500">No {state.componentType.toLowerCase()} associated with this application.</div>
            ) : (
              state.records.map((record) => (
                <button
                  key={record.id}
                  className={`w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-blue-50 ${selectedId === record.id ? 'bg-blue-50' : ''}`}
                  onClick={() => setSelectedId(record.id)}
                >
                  <div className="text-sm font-medium text-gray-800">{record.name}</div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="col-span-8 border border-gray-200 rounded overflow-hidden">
          <div className="px-3 py-2 text-xs text-gray-500 border-b bg-gray-50">Properties</div>
          <div className="p-3" style={{ maxHeight: 480, overflowY: 'auto' }}>
            {!selectedRecord ? (
              <div className="text-sm text-gray-500">Select a record to view properties.</div>
            ) : (
              <>
                <div className="text-base font-semibold text-gray-800 mb-3">{selectedRecord.name}</div>
                <table className="w-full text-xs border border-gray-200">
                  <tbody>
                    {Object.entries(selectedRecord.values)
                      .filter(([, value]) => !(typeof value === 'string' && isKeyLikeString(value)))
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([key, value]) => (
                        <tr key={key} className="border-t border-gray-200">
                          <td className="w-1/3 px-2 py-1 text-gray-500 align-top">{toLabel(key)}</td>
                          <td className="px-2 py-1 text-gray-700 align-top">{renderFieldValue(value)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
