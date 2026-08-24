import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, Empty, Input, Select, Table } from 'antd';
import { ColumnHeightOutlined } from '@ant-design/icons';
import type { CustomFactoryRow } from '../types';

const ALL_COLUMNS_OPTION = '__all__';

// Known conceptual names for a "correlation ID"/unique-application-id
// column, normalized (qualifier/aggregator/component suffix stripped, then
// lowercased/alphanumeric-only) so a caller's hint (e.g. "correlationId")
// still finds the right column regardless of a data set's raw uploaded
// header naming convention (e.g. "APP_ID Qualifier").
const CORRELATION_ID_COLUMN_CANDIDATES = new Set([
  'correlationid', 'appid', 'applicationid', 'appcorrelationid', 'applicationcorrelationid',
]);

function normalizeColumnKey(column: string) {
  return column.replace(/\s+(Qualifier|Aggregator|Component)$/i, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Guards against object/array values (e.g. an internal lineage snapshot that
// slipped past a caller's own filtering) rendering as the useless
// "[object Object]" — see the same guard in NeighborhoodFactory.tsx.
function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '—';
    }
  }
  return String(value);
}

interface SystemComponentTableProps {
  dataRows: CustomFactoryRow[];
  dataColumns: string[];
  // External request to pin the search to a specific column/value — e.g.
  // "View in Application Component" searching by correlation ID so exactly
  // one record shows. The nonce forces re-application even when the same
  // column/text repeats.
  requestedSearch?: { column: string; text: string; nonce: number } | null;
}

export default function SystemComponentTable({ dataRows, dataColumns, requestedSearch }: SystemComponentTableProps) {
  // "__"-prefixed keys are internal bookkeeping, not user-facing data.
  const publicColumns = useMemo(() => dataColumns.filter((column) => !column.startsWith('__')), [dataColumns]);

  const [searchColumn, setSearchColumn] = useState<string>(ALL_COLUMNS_OPTION);
  const [searchText, setSearchText] = useState('');
  const [exactMatch, setExactMatch] = useState(false);
  const appliedNonceRef = useRef<number | null>(null);

  // Column picker — visible by default; toggled off via the "Columns" menu.
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const toggleColumnVisibility = (column: string) => {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };
  const visibleColumns = useMemo(
    () => publicColumns.filter((column) => !hiddenColumns.has(column)),
    [publicColumns, hiddenColumns],
  );
  const allColumnsVisible = hiddenColumns.size === 0;
  const noColumnsVisible = publicColumns.length > 0 && hiddenColumns.size === publicColumns.length;
  const toggleAllColumnsVisibility = () => {
    setHiddenColumns(allColumnsVisible ? new Set(publicColumns) : new Set());
  };

  useEffect(() => {
    if (!requestedSearch) return;
    if (appliedNonceRef.current === requestedSearch.nonce) return;
    if (!publicColumns.length) return; // retry once real columns have loaded
    appliedNonceRef.current = requestedSearch.nonce;

    const requestedNormalized = normalizeColumnKey(requestedSearch.column);
    const isCorrelationIdHint = CORRELATION_ID_COLUMN_CANDIDATES.has(requestedNormalized);
    const resolvedColumn = publicColumns.includes(requestedSearch.column)
      ? requestedSearch.column
      : isCorrelationIdHint
        ? (publicColumns.find((column) => CORRELATION_ID_COLUMN_CANDIDATES.has(normalizeColumnKey(column))) || ALL_COLUMNS_OPTION)
        : (publicColumns.find((column) => normalizeColumnKey(column) === requestedNormalized) || ALL_COLUMNS_OPTION);

    setSearchColumn(resolvedColumn);
    setSearchText(requestedSearch.text);
    setExactMatch(true);
    // Make sure the column that matched is actually visible.
    if (resolvedColumn !== ALL_COLUMNS_OPTION) {
      setHiddenColumns((current) => {
        if (!current.has(resolvedColumn)) return current;
        const next = new Set(current);
        next.delete(resolvedColumn);
        return next;
      });
    }
  }, [requestedSearch, publicColumns]);

  const filteredRows = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    if (!normalizedSearch) return dataRows;
    const columnsToSearch = searchColumn === ALL_COLUMNS_OPTION ? publicColumns : [searchColumn];
    return dataRows.filter((row) => columnsToSearch.some((column) => {
      const candidate = String(row.values?.[column] ?? '').toLowerCase();
      return exactMatch ? candidate === normalizedSearch : candidate.includes(normalizedSearch);
    }));
  }, [dataRows, searchColumn, searchText, exactMatch, publicColumns]);

  const columns = useMemo(() => visibleColumns.map((column) => ({
    title: column,
    key: column,
    dataIndex: ['values', column],
    ellipsis: true,
    render: (value: unknown) => displayValue(value),
  })), [visibleColumns]);

  return (
    <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select
          value={searchColumn}
          style={{ width: 220 }}
          onChange={(value) => { setSearchColumn(value); setExactMatch(false); }}
          options={[
            { label: 'All columns', value: ALL_COLUMNS_OPTION },
            ...publicColumns.map((column) => ({ label: column, value: column })),
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Search records"
          style={{ width: 280 }}
          value={searchText}
          onChange={(event) => { setSearchText(event.target.value); setExactMatch(false); }}
        />
        {publicColumns.length > 0 && (
          <Dropdown
            menu={{
              items: [
                {
                  key: '__select_all__',
                  label: (
                    <Checkbox
                      checked={allColumnsVisible}
                      indeterminate={!allColumnsVisible && !noColumnsVisible}
                      onChange={toggleAllColumnsVisibility}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {allColumnsVisible ? 'Deselect All' : 'Select All'}
                    </Checkbox>
                  ),
                },
                { type: 'divider' as const },
                ...publicColumns.map((column) => ({
                  key: column,
                  label: (
                    <Checkbox
                      checked={!hiddenColumns.has(column)}
                      onChange={() => toggleColumnVisibility(column)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {column}
                    </Checkbox>
                  ),
                })),
              ],
            }}
            trigger={['click']}
          >
            <Button size="small" icon={<ColumnHeightOutlined />}>Columns</Button>
          </Dropdown>
        )}
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {filteredRows.length} of {dataRows.length} record{dataRows.length === 1 ? '' : 's'}
        </span>
      </div>
      {filteredRows.length ? (
        <Table
          size="small"
          rowKey={(row) => row._id}
          columns={columns}
          dataSource={filteredRows}
          pagination={{ pageSize: 25, showSizeChanger: true }}
          scroll={{ x: 'max-content' }}
        />
      ) : (
        <Empty description="No records match this search" style={{ marginTop: 40 }} />
      )}
    </div>
  );
}
