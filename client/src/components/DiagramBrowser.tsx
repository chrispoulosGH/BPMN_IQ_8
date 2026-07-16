import { useEffect, useMemo, useState } from 'react';
import { Alert, Empty, Select, Spin, Tag, Typography } from 'antd';
import { FolderOpenOutlined, PartitionOutlined } from '@ant-design/icons';
import type { DiagramMeta, FactoryNeighborhoodSummary } from '../types';
import { getCanonicalTypes, getDiagramsForNeighborhood } from '../api';

const { Text } = Typography;

interface FilterDefinition {
  key: string;
  label: string;
  getValues: (diagram: DiagramMeta) => string[];
}

const HIERARCHY_FILTERS: FilterDefinition[] = [
  {
    key: 'lineOfBusiness',
    label: 'Line of Business',
    getValues: (diagram) => [diagram.lineOfBusiness || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'channel',
    label: 'Channel',
    getValues: (diagram) => [diagram.channel || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'product',
    label: 'Product',
    getValues: (diagram) => [diagram.product || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'domain',
    label: 'Domain',
    getValues: (diagram) => [diagram.domain || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'subdomain',
    label: 'Subdomain',
    getValues: (diagram) => [diagram.subdomain || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
];

const COMPONENT_FILTERS: FilterDefinition[] = [
  {
    key: 'businessCapability',
    label: 'Business Capability',
    getValues: (diagram) => [diagram.businessCapability || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'valueStream',
    label: 'Value Stream',
    getValues: (diagram) => [diagram.valueStream || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'journey',
    label: 'Journey',
    getValues: (diagram) => [diagram.journey || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'businessFlow',
    label: 'Business Process Flow',
    getValues: (diagram) => [diagram.businessFlow || diagram.name || ''].map((value) => String(value || '').trim()).filter(Boolean),
  },
  {
    key: 'task',
    label: 'Task',
    getValues: (diagram) => (diagram.tasks || []).map((task) => String(task.name || '').trim()).filter(Boolean),
  },
  {
    key: 'application',
    label: 'Application',
    getValues: (diagram) => (diagram.tasks || []).flatMap((task) => (task.applications || []).map((application) => String(application.name || '').trim()).filter(Boolean)),
  },
];

const SUPPORTED_COMPONENT_FILTERS = [...COMPONENT_FILTERS, ...HIERARCHY_FILTERS];

function normalizeFacetKey(value: string) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface DiagramBrowserProps {
  frameworks: FactoryNeighborhoodSummary[];
  selectedDiagramIds: string[];
  onToggleDiagram: (id: string) => void;
}

export default function DiagramBrowser({ frameworks, selectedDiagramIds, onToggleDiagram }: DiagramBrowserProps) {
  const [selectedFrameworks, setSelectedFrameworks] = useState<string[]>([]);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [diagrams, setDiagrams] = useState<DiagramMeta[]>([]);
  const [frameworkComponentTypes, setFrameworkComponentTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frameworkOptions = useMemo(
    () => frameworks.map((framework) => ({ label: framework.name, value: framework.name })),
    [frameworks],
  );

  useEffect(() => {
    const availableFrameworks = new Set(frameworks.map((framework) => framework.name));
    setSelectedFrameworks((current) => current.filter((name) => availableFrameworks.has(name)));
  }, [frameworks]);

  useEffect(() => {
    let cancelled = false;
    const loadTypes = async () => {
      try {
        const targetFrameworks = selectedFrameworks.length
          ? selectedFrameworks
          : frameworks.map((framework) => framework.name);
        if (!targetFrameworks.length) {
          if (!cancelled) setFrameworkComponentTypes([]);
          return;
        }

        const responses = await Promise.all(targetFrameworks.map((framework) => getCanonicalTypes(framework).catch(() => [])));
        if (!cancelled) {
          const uniqueTypes = Array.from(new Set(responses.flat().map((type) => String(type || '').trim()).filter(Boolean)));
          setFrameworkComponentTypes(uniqueTypes);
        }
      } catch {
        if (!cancelled) setFrameworkComponentTypes([]);
      }
    };

    void loadTypes();
    return () => { cancelled = true; };
  }, [frameworks, selectedFrameworks]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const targetFrameworks = selectedFrameworks.length
          ? selectedFrameworks
          : frameworks.map((framework) => framework.name);
        const responses = await Promise.all(targetFrameworks.map((framework) => getDiagramsForNeighborhood(framework)));
        if (!cancelled) {
          const byId = new Map<string, DiagramMeta>();
          responses.flat().forEach((diagram) => byId.set(diagram._id, diagram));
          setDiagrams([...byId.values()]);
        }
      } catch (err: any) {
        if (!cancelled) {
          setDiagrams([]);
          setError(err?.response?.data?.error || err?.message || 'Unable to load diagrams.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [frameworks, selectedFrameworks]);

  const facetDefinitions = useMemo(() => {
    const supportedKeys = new Set(frameworkComponentTypes.map(normalizeFacetKey));
    const orderedDefinitions: FilterDefinition[] = [];
    const seen = new Set<string>();

    [...SUPPORTED_COMPONENT_FILTERS]
      .filter((definition) => {
        if (COMPONENT_FILTERS.includes(definition)) {
          return supportedKeys.has(normalizeFacetKey(definition.label));
        }
        return true;
      })
      .forEach((definition) => {
        if (seen.has(definition.key)) return;
        seen.add(definition.key);
        orderedDefinitions.push(definition);
      });

    return orderedDefinitions;
  }, [frameworkComponentTypes]);

  const filterOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    facetDefinitions.forEach((filter) => {
      options[filter.key] = Array.from(new Set(
        diagrams.flatMap((diagram) => filter.getValues(diagram)),
      )).sort((left, right) => left.localeCompare(right));
    });
    return options;
  }, [diagrams, facetDefinitions]);

  const filteredDiagrams = useMemo(() => {
    const selectedValues = new Set(facetDefinitions.flatMap((filter) => filters[filter.key] || []));
    if (!selectedValues.size) return diagrams;

    return diagrams.filter((diagram) => facetDefinitions.some((filter) => filter.getValues(diagram).some((value) => selectedValues.has(value))));
  }, [diagrams, filters, facetDefinitions]);

  const updateFilter = (key: string, values: string[]) => {
    setFilters((current) => ({ ...current, [key]: values }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-slate-200 bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="mb-3 flex items-center gap-2">
          <FolderOpenOutlined className="text-teal-700" />
          <Text strong>Diagram Search</Text>
        </div>
        <div className="grid gap-2">
          <div>
            <Text className="mb-1 block text-xs text-slate-600">Frameworks</Text>
            <Select
              mode="multiple"
              allowClear
              className="w-full"
              placeholder="All frameworks"
              options={frameworkOptions}
              value={selectedFrameworks}
              onChange={setSelectedFrameworks}
              maxTagCount="responsive"
            />
          </div>
          {facetDefinitions.map((filter) => (
            <div key={filter.key}>
              <Text className="mb-1 block text-xs text-slate-600">{filter.label}</Text>
              <Select
                mode="multiple"
                allowClear
                className="w-full"
                placeholder={`All ${filter.label.toLowerCase()} values`}
                options={(filterOptions[filter.key] || []).map((value) => ({ label: value, value }))}
                value={filters[filter.key] || []}
                onChange={(values) => updateFilter(filter.key, values)}
                maxTagCount="responsive"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        <div className="mb-2 flex items-center justify-between">
          <Text className="text-xs text-slate-600">{filteredDiagrams.length} business process flows</Text>
          {loading ? <Spin size="small" /> : null}
        </div>
        {error ? <Alert type="error" message={error} showIcon /> : null}
        {!loading && !error && !filteredDiagrams.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No business process flows match these filters" className="mt-10" />
        ) : null}
        <div className="grid min-h-0 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {filteredDiagrams.map((diagram) => {
            const selected = selectedDiagramIds.includes(diagram._id);
            const framework = diagram.neighborhoodName || 'Unassigned framework';
            const hierarchy = [diagram.lineOfBusiness, diagram.channel, diagram.product, diagram.domain, diagram.subdomain]
              .filter(Boolean)
              .join(' | ');
            return (
              <button
                key={diagram._id}
                type="button"
                onClick={() => onToggleDiagram(diagram._id)}
                className={`min-h-[118px] border p-3 text-left transition-colors ${selected
                  ? 'border-teal-700 bg-teal-100 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-teal-400 hover:bg-teal-50'}`}
              >
                <div className="mb-2 flex items-start gap-2">
                  <PartitionOutlined className={selected ? 'mt-0.5 text-teal-800' : 'mt-0.5 text-slate-500'} />
                  <Text strong className="leading-snug">{diagram.businessFlow || diagram.name}</Text>
                </div>
                <Tag className="mb-2 mr-0 max-w-full truncate" color="cyan">{framework}</Tag>
                {hierarchy ? <div className="line-clamp-3 text-xs leading-relaxed text-slate-600">{hierarchy}</div> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
