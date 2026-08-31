import { useEffect, useState } from 'react';
import { Modal, Select, Input, Spin } from 'antd';
import { getModelSchema, getHierarchyOptions, getDiagramsForNeighborhood, type ModelSchemaResponse, type ModelSchemaQualifierField } from '../api';
import type { DiagramMetadata, FactoryNeighborhoodSummary } from '../types';

interface NewDiagramDialogProps {
  open: boolean;
  frameworks: FactoryNeighborhoodSummary[];
  onCancel: () => void;
  // Actually persists the diagram (create-in-Mongo happens as soon as this
  // dialog is completed, not on a later manual save) — should reject/throw
  // on failure so the dialog stays open with the user's picks intact
  // instead of silently discarding them.
  onCreate: (payload: { frameworkName: string; flowName: string; metadata: DiagramMetadata }) => Promise<void>;
}

export default function NewDiagramDialog({ open, frameworks, onCancel, onCreate }: NewDiagramDialogProps) {
  const [selectedFramework, setSelectedFramework] = useState<string | null>(null);
  const [schema, setSchema] = useState<ModelSchemaResponse | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [hierarchyValues, setHierarchyValues] = useState<Record<string, string>>({});
  const [hierarchyOptionsPerLevel, setHierarchyOptionsPerLevel] = useState<Record<number, string[]>>({});
  const [qualifierValues, setQualifierValues] = useState<Record<string, string>>({});
  const [flowName, setFlowName] = useState('');
  const [existingFlowNames, setExistingFlowNames] = useState<string[]>([]);

  // Reset everything each time the dialog is (re-)opened.
  useEffect(() => {
    if (!open) return;
    setSelectedFramework(null);
    setSchema(null);
    setHierarchyValues({});
    setHierarchyOptionsPerLevel({});
    setQualifierValues({});
    setFlowName('');
    setExistingFlowNames([]);
    setCreating(false);
  }, [open]);

  // Framework picked — load its real hierarchy chain, and the flow names
  // that already exist in it (for the duplicate-name check below).
  useEffect(() => {
    if (!selectedFramework) return;
    let cancelled = false;
    setSchemaLoading(true);
    setSchema(null);
    setHierarchyValues({});
    setHierarchyOptionsPerLevel({});
    setQualifierValues({});
    setFlowName('');

    getModelSchema(selectedFramework)
      .then((result) => { if (!cancelled) setSchema(result); })
      .catch(() => { if (!cancelled) setSchema({ hierarchyFields: [], nameField: null }); })
      .finally(() => { if (!cancelled) setSchemaLoading(false); });

    getDiagramsForNeighborhood(selectedFramework)
      .then((diagrams) => { if (!cancelled) setExistingFlowNames(diagrams.map((d) => d.name).filter(Boolean)); })
      .catch(() => { if (!cancelled) setExistingFlowNames([]); });

    return () => { cancelled = true; };
  }, [selectedFramework]);

  // Cascading dropdown options — reloaded whenever the schema or any
  // upstream selection changes. Small datasets, so refetching the whole
  // chain each time is simpler than fine-grained caching and fast enough.
  useEffect(() => {
    if (!selectedFramework || !schema) return;
    let cancelled = false;

    (async () => {
      const nextOptions: Record<number, string[]> = {};
      for (let i = 0; i < schema.hierarchyFields.length; i += 1) {
        const field = schema.hierarchyFields[i];
        const parent = i > 0 ? schema.hierarchyFields[i - 1] : null;
        const parentValue = parent ? hierarchyValues[parent.componentName] : undefined;
        if (parent && !parentValue) {
          nextOptions[i] = [];
          continue;
        }
        try {
          const { options } = await getHierarchyOptions(selectedFramework, field.componentName, parent?.componentName, parentValue);
          if (cancelled) return;
          nextOptions[i] = options;
        } catch {
          if (cancelled) return;
          nextOptions[i] = [];
        }
      }
      if (!cancelled) setHierarchyOptionsPerLevel(nextOptions);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, selectedFramework, hierarchyValues]);

  const handleHierarchyChange = (levelIndex: number, value: string) => {
    if (!schema) return;
    setHierarchyValues((prev) => {
      const next = { ...prev, [schema.hierarchyFields[levelIndex].componentName]: value };
      // Downstream selections are no longer necessarily valid once an
      // upstream level changes — clear them so nothing stale gets submitted.
      for (let i = levelIndex + 1; i < schema.hierarchyFields.length; i += 1) {
        delete next[schema.hierarchyFields[i].componentName];
      }
      return next;
    });
  };

  const allHierarchyFieldsSelected = !schema || schema.hierarchyFields.every((field) => !!hierarchyValues[field.componentName]);
  const normalizedFlowName = flowName.trim();
  const isDuplicateFlowName = normalizedFlowName.length > 0
    && existingFlowNames.some((name) => name.toLowerCase() === normalizedFlowName.toLowerCase());

  const canSubmit = !!selectedFramework
    && !!schema
    && allHierarchyFieldsSelected
    && normalizedFlowName.length > 0
    && !isDuplicateFlowName
    && !creating;

  const handleSubmit = async () => {
    if (!canSubmit || !schema) return;

    const metadata: DiagramMetadata = {};
    const applyQualifiers = (qualifiers: ModelSchemaQualifierField[]) => {
      qualifiers.forEach((qualifier) => {
        const value = qualifierValues[qualifier.fieldName];
        if (value && value.trim()) (metadata as Record<string, string>)[qualifier.diagramField] = value.trim();
      });
    };

    schema.hierarchyFields.forEach((field) => {
      if (field.diagramField) (metadata as Record<string, string>)[field.diagramField] = hierarchyValues[field.componentName];
      applyQualifiers(field.qualifierColumns);
    });
    if (schema.nameField) {
      if (schema.nameField.diagramField) (metadata as Record<string, string>)[schema.nameField.diagramField] = normalizedFlowName;
      applyQualifiers(schema.nameField.qualifierColumns);
    }

    setCreating(true);
    try {
      // Saved to Mongo right here — onCreate rejects on failure (e.g. a
      // last-second duplicate name), which we let bubble so the dialog
      // stays open with everything the user picked still in place.
      await onCreate({ frameworkName: selectedFramework!, flowName: normalizedFlowName, metadata });
    } catch {
      setCreating(false);
    }
  };

  const renderQualifiers = (qualifiers: ModelSchemaQualifierField[]) => {
    if (!qualifiers.length) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, paddingLeft: 12, borderLeft: '2px solid #f0f0f0' }}>
        {qualifiers.map((qualifier) => (
          <div key={qualifier.fieldName}>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              {qualifier.label} <span className="text-gray-400">(optional)</span>
            </label>
            <Input
              value={qualifierValues[qualifier.fieldName] || ''}
              onChange={(e) => setQualifierValues((prev) => ({ ...prev, [qualifier.fieldName]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    );
  };

  const nameFieldLabel = schema?.nameField?.componentName || 'Diagram Name';

  return (
    <Modal
      title="New Diagram"
      open={open}
      onCancel={() => { if (!creating) onCancel(); }}
      onOk={handleSubmit}
      okText="Create"
      okButtonProps={{ disabled: !canSubmit, loading: creating }}
      cancelButtonProps={{ disabled: creating }}
      maskClosable={!creating}
      closable={!creating}
      destroyOnClose
      width={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Framework <span className="text-red-500">*</span></label>
          <Select
            style={{ width: '100%' }}
            placeholder="Select a framework"
            value={selectedFramework || undefined}
            onChange={(value) => setSelectedFramework(value)}
            options={frameworks.map((framework) => ({ label: framework.name, value: framework.name }))}
            showSearch
            optionFilterProp="label"
            autoFocus
          />
        </div>

        {schemaLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
            <Spin size="small" />
          </div>
        )}

        {schema && schema.hierarchyFields.map((field, index) => {
          const parent = index > 0 ? schema.hierarchyFields[index - 1] : null;
          const parentSatisfied = !parent || !!hierarchyValues[parent.componentName];
          return (
            <div key={field.componentName}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {field.componentName} <span className="text-red-500">*</span>
              </label>
              <Select
                style={{ width: '100%' }}
                placeholder={parentSatisfied ? `Select ${field.componentName}` : `Select ${parent?.componentName} first`}
                disabled={!parentSatisfied}
                value={hierarchyValues[field.componentName] || undefined}
                onChange={(value) => handleHierarchyChange(index, value)}
                options={(hierarchyOptionsPerLevel[index] || []).map((value) => ({ label: value, value }))}
                showSearch
                optionFilterProp="label"
              />
              {hierarchyValues[field.componentName] && renderQualifiers(field.qualifierColumns)}
            </div>
          );
        })}

        {schema && allHierarchyFieldsSelected && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {nameFieldLabel} <span className="text-red-500">*</span>
            </label>
            <Input
              autoFocus={!schema.hierarchyFields.length}
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              placeholder={`Enter a new ${nameFieldLabel.toLowerCase()} name`}
              status={isDuplicateFlowName ? 'error' : undefined}
              onPressEnter={() => { if (canSubmit) handleSubmit(); }}
            />
            {isDuplicateFlowName ? (
              <div className="text-xs mt-1" style={{ color: '#dc2626' }}>
                A {nameFieldLabel.toLowerCase()} named "{normalizedFlowName}" already exists in this framework.
              </div>
            ) : (
              <div className="text-xs text-gray-500 mt-1">This name will appear as the diagram title on the canvas.</div>
            )}
            {schema.nameField && renderQualifiers(schema.nameField.qualifierColumns)}
          </div>
        )}
      </div>
    </Modal>
  );
}
