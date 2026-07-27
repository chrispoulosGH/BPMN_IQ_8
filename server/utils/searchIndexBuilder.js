const mongoose = require('mongoose');
const ComponentSearchIndex = require('../models/ComponentSearchIndex');
const CanonicalComponent = require('../models/CanonicalComponent');
const Model = require('../models/Model');

function logHeap(stage, extra = {}) {
  const usedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const totalMb = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);
  console.log(`[INDEX] Heap ${stage}: ${usedMb}MB used / ${totalMb}MB total`, extra);
}

const DEFAULT_PARENT_FACTORY_BY_TYPE = new Map([
  ['businessprocessflow', 'Business Capability'],
  ['businessflow', 'Business Capability'],
  ['task', 'Business Process Flow'],
  ['application', 'Task'],
]);

/**
 * Rebuild the search index for all components in a neighborhood
 * This should be called after component uploads or updates
 */
async function rebuildSearchIndex(neighborhoodName, options = {}) {
  const CanonicalModel = options.CanonicalModel || CanonicalComponent;
  const SearchIndexModel = options.SearchIndexModel || ComponentSearchIndex;
  const indexLabel = options.indexLabel || 'ComponentSearchIndex';
  const dataType = options.dataType || '';
  const sourceBatchSize = options.sourceBatchSize || 1000;
  const indexBatchSize = options.indexBatchSize || 500;
  const maxPathsPerRow = options.maxPathsPerRow || 500;

  console.log(`[INDEX] Starting ${indexLabel} rebuild for neighborhood: ${neighborhoodName}`);
  logHeap('start', { neighborhoodName, indexLabel });

  try {
    const normalizeKey = (val) => String(val || '').trim().toLowerCase();
    const parentFactoryByType = new Map();
    try {
      const modelDoc = await Model.findOne({ name: neighborhoodName }, { schemaFactories: 1 }).lean();
      const schemaFactories = Array.isArray(modelDoc?.schemaFactories) ? modelDoc.schemaFactories : [];
      schemaFactories.forEach((factory) => {
        const child = normalizeKey(factory?.name);
        const parent = String(factory?.parentFactoryName || '').trim();
        if (!child || !parent) return;
        parentFactoryByType.set(child, parent);
      });
      for (const [child, parent] of DEFAULT_PARENT_FACTORY_BY_TYPE.entries()) {
        if (!parentFactoryByType.has(child)) parentFactoryByType.set(child, parent);
      }
    } catch (err) {
      console.warn('[INDEX] Failed to load schemaFactories for parent mapping:', err?.message || err);
      for (const [child, parent] of DEFAULT_PARENT_FACTORY_BY_TYPE.entries()) {
        if (!parentFactoryByType.has(child)) parentFactoryByType.set(child, parent);
      }
    }

    // Stream canonical rows and group them into synthesized "components" by componentType.
    const rowProjection = {
      _id: 1,
      primaryKey: 1,
      componentType: 1,
      component_type: 1,
      values: 1,
      parentName: 1,
      parentRefs: 1,
    };
    const componentsByType = new Map();
    const canonicalById = new Map();
    let canonicalRowCount = 0;

    const canonicalCursor = CanonicalModel.find({ neighborhoodName }, rowProjection).lean().cursor({ batchSize: sourceBatchSize });
    for await (const row of canonicalCursor) {
      canonicalRowCount += 1;

      const type = String(row.componentType || row.component_type || 'unknown');
      if (!componentsByType.has(type)) {
        componentsByType.set(type, {
          _id: type,
          name: type,
          parentFactoryName: parentFactoryByType.get(normalizeKey(type)) || '',
          rows: [],
        });
      }

      const rowValues = row.values && typeof row.values === 'object'
        ? (row.values instanceof Map ? Object.fromEntries(row.values.entries()) : { ...row.values })
        : {};

      const compactRow = {
        _id: row._id,
        primaryKey: row.primaryKey,
        componentType: type,
        values: rowValues,
        parentName: (rowValues && (rowValues.parentName || rowValues.parent)) || row.parentName || null,
        parentRefs: Array.isArray(row.parentRefs) ? row.parentRefs.map((id) => String(id)) : [],
      };

      componentsByType.get(type).rows.push(compactRow);
      canonicalById.set(String(row._id), compactRow);

      if (canonicalRowCount % sourceBatchSize === 0) {
        logHeap('streamed source rows', { canonicalRowCount, componentTypes: componentsByType.size });
      }
    }

    const canonicalRows = canonicalRowCount;
    if (!canonicalRows) {
      console.log(`[INDEX] No canonical rows found for ${indexLabel} neighborhood: ${neighborhoodName}`);
      return;
    }

    const components = Array.from(componentsByType.values());
    logHeap('grouped source rows', { canonicalRowCount, componentTypes: components.length });

    console.log(`[INDEX] Synthesized ${components.length} components from canonicalcomponents for ${neighborhoodName}`);
    logHeap('after synthesize components', { components: components.length, canonicalRows: canonicalRowCount });

    // Create component map for hierarchy lookup
    const componentMap = new Map(components.map(c => [normalizeValue(c.name), c]));

    // Also create a map of canonical rows by their _id for direct parentRef lookups
    // (built during the streaming source pass above).

    // Helper function to normalize values for comparison
    function normalizeValue(val) {
      return String(val || '').trim().toLowerCase();
    }

    // Helper function to extract row values
    function getRowValues(row) {
      if (!row.values) return {};
      if (row.values instanceof Map) return Object.fromEntries(row.values.entries());
      if (typeof row.values.toObject === 'function') return row.values.toObject();
      if (typeof row.values === 'object') return { ...row.values };
      return { ...row };
    }

    function getRowName(row, rowValues = getRowValues(row)) {
      const componentKey = Object.keys(rowValues).find((key) => /(?:^|\s)component$/i.test(String(key).trim()));
      return String(rowValues.name || row.name || row.primaryKey || (componentKey && rowValues[componentKey]) || 'unnamed').trim();
    }

    const LINEAGE_FIELD_ALIASES = new Map([
      ['lineofbusiness', 'lineOfBusiness'],
      ['lob', 'lineOfBusiness'],
      ['channel', 'channel'],
      ['product', 'product'],
      ['domain', 'domain'],
      ['subdomain', 'subdomain'],
      ['valuestream', 'valueStream'],
      ['journey', 'journey'],
      ['businesscapability', 'businessCapability'],
      ['businessprocessflow', 'businessFlow'],
      ['businessflow', 'businessFlow'],
      ['task', 'task'],
      ['application', 'application'],
    ]);

    function mapComponentNameToLineageField(componentName) {
      const normalized = String(componentName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
      return LINEAGE_FIELD_ALIASES.get(normalized) || null;
    }

    function getLineageVariants(rowValues) {
      const variants = [];
      if (rowValues.__lineage && typeof rowValues.__lineage === 'object') variants.push(rowValues.__lineage);
      if (Array.isArray(rowValues.__lineageVariants)) {
        rowValues.__lineageVariants.forEach((variant) => {
          if (variant && typeof variant === 'object') variants.push(variant);
        });
      }

      // Deduplicate variants by stable JSON value
      const deduped = [];
      const seen = new Set();
      for (const variant of variants) {
        const key = JSON.stringify(variant);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(variant);
      }
      return deduped;
    }

    function getLineageVariantsOrSingle(rowValues) {
      const variants = getLineageVariants(rowValues);
      return variants.length ? variants : [null];
    }

    function lineageParentNameForComponent(lineageVariant, parentComponentName) {
      if (!lineageVariant || typeof lineageVariant !== 'object') return '';
      const parentField = mapComponentNameToLineageField(parentComponentName);
      if (!parentField) return '';
      return String(lineageVariant?.[parentField] || '').trim();
    }

    // Helper to build ALL hierarchy paths for a row (recursively handling multiple parents)
    // Returns array of hierarchies, where each hierarchy is an array of {componentName, rowName, componentId, rowId}
    const hierarchyPathCache = new Map();
    const truncatedHierarchyRows = new Set();

    const buildAllHierarchyPaths = async (component, row, visitedRowKeys = new Set(), forcedLineageVariant = null) => {
      const rowValues = getRowValues(row);
      const rowName = getRowName(row, rowValues);
      const currentRowKey = `${component.name}:${String(row._id)}`;
      const activeVariant = forcedLineageVariant || null;
      const cacheKey = `${currentRowKey}::${activeVariant ? JSON.stringify(activeVariant) : 'none'}`;

      if (visitedRowKeys.size === 0 && hierarchyPathCache.has(cacheKey)) {
        return hierarchyPathCache.get(cacheKey);
      }

      // Prevent infinite loops
      if (visitedRowKeys.has(currentRowKey)) {
        return [[{ componentName: component.name, componentId: String(component._id), rowName, rowId: String(row._id) }]];
      }

      // Use canonical parentRefs when available (preferred), otherwise fall back to parentName
      const parentRefs = Array.isArray(row.parentRefs) && row.parentRefs.length > 0 ? row.parentRefs.map(String) : [];

      // Helper to produce a single-node fallback path
      const singleNode = [{ componentName: component.name, componentId: String(component._id), rowName, rowId: String(row._id) }];

      if (parentRefs.length === 0) {
        // No explicit parentRefs - fall back to legacy parentName parsing
        const explicitParentNames = row.parentName
          ? row.parentName.split('|').map(p => p.trim()).filter(p => p)
          : [];
        const hierarchies = [];
        const rowVariants = activeVariant ? [activeVariant] : getLineageVariantsOrSingle(rowValues);
        for (const lineageVariant of rowVariants) {
          const parentComponentName = component.parentFactoryName;
          const parentComponent = componentMap.get(normalizeValue(parentComponentName));

          if (!parentComponent) {
            hierarchies.push(singleNode);
            continue;
          }

          const lineageParentName = lineageParentNameForComponent(lineageVariant, parentComponentName);
          const parentNames = lineageParentName ? [lineageParentName] : explicitParentNames;

          if (parentNames.length === 0) {
            hierarchies.push(singleNode);
            continue;
          }

          for (const parentName of parentNames) {
            // Find parent row by exact name; lineage variant already pins which parent to use.
            const parentRow = parentComponent.rows?.find(r => {
              const pRowValues = getRowValues(r);
              const pName = String(pRowValues.name || r.name || r.primaryKey || 'unnamed').trim();
              return normalizeValue(pName) === normalizeValue(parentName);
            });

            if (!parentRow) {
              hierarchies.push(singleNode);
              continue;
            }

            const pathVisitedSet = new Set(visitedRowKeys);
            pathVisitedSet.add(currentRowKey);
            const parentHierarchies = await buildAllHierarchyPaths(parentComponent, parentRow, pathVisitedSet, lineageVariant);
            parentHierarchies.forEach(parentPath => {
              const fullPath = [...parentPath, {
                componentName: component.name,
                componentId: String(component._id),
                rowName,
                rowId: String(row._id)
              }];
              hierarchies.push(fullPath);
            });
          }
        }

        const result = hierarchies.length > 0 ? hierarchies.slice(0, maxPathsPerRow) : [singleNode];
        if (hierarchies.length > maxPathsPerRow) truncatedHierarchyRows.add(currentRowKey);
        if (visitedRowKeys.size === 0) hierarchyPathCache.set(cacheKey, result);
        return result;
      }

      // Build hierarchies from parentRefs (canonical link-based)
      const hierarchies = [];
      const rowVariants = activeVariant ? [activeVariant] : getLineageVariantsOrSingle(rowValues);
      for (const lineageVariant of rowVariants) {
        for (const parentRefId of parentRefs) {
          const parentCanonical = canonicalById.get(String(parentRefId));
          if (!parentCanonical) {
            hierarchies.push(singleNode);
            continue;
          }

          const parentComponentName = parentCanonical.componentType || parentCanonical.component_type || 'unknown';
          const parentComponent = componentMap.get(normalizeValue(parentComponentName));

          if (!parentComponent) {
            hierarchies.push(singleNode);
            continue;
          }

          // Find the parent row in the parentComponent by matching _id
          const parentRow = parentComponent.rows?.find(r => String(r._id) === String(parentRefId));

          if (!parentRow) {
            hierarchies.push(singleNode);
            continue;
          }

          const expectedByLineage = lineageParentNameForComponent(lineageVariant, parentComponentName);
          if (expectedByLineage) {
            const pRowValues = getRowValues(parentRow);
            const pName = String(pRowValues.name || parentRow.primaryKey || parentRow.name || 'unnamed').trim();
            if (normalizeValue(pName) !== normalizeValue(expectedByLineage)) {
              continue;
            }
          }

          const pathVisitedSet = new Set(visitedRowKeys);
          pathVisitedSet.add(currentRowKey);
          const parentHierarchies = await buildAllHierarchyPaths(parentComponent, parentRow, pathVisitedSet, lineageVariant);
          parentHierarchies.forEach(parentPath => {
            if (hierarchies.length >= maxPathsPerRow) return;
            const fullPath = [...parentPath, {
              componentName: component.name,
              componentId: String(component._id),
              rowName,
              rowId: String(row._id)
            }];
            hierarchies.push(fullPath);
          });

          if (hierarchies.length >= maxPathsPerRow) {
            truncatedHierarchyRows.add(currentRowKey);
            break;
          }
        }
      }

      const result = hierarchies.length > 0 ? hierarchies : [singleNode];
      if (visitedRowKeys.size === 0) hierarchyPathCache.set(cacheKey, result);
      return result;
    };

    // Build index entries in batches so we do not retain the full neighborhood in memory.
    let totalRowsProcessed = 0;
    let totalIndexEntries = 0;
    let batchEntries = [];

    const flushIndexBatch = async (reason) => {
      if (!batchEntries.length) return;
      const entriesToInsert = batchEntries;
      batchEntries = [];
      await SearchIndexModel.insertMany(entriesToInsert, { ordered: false });
      totalIndexEntries += entriesToInsert.length;
      logHeap('flushed index batch', { reason, inserted: entriesToInsert.length, totalIndexEntries });
    };

    await SearchIndexModel.deleteMany({ neighborhoodName });

    for (const component of components) {
      const rows = component.rows || [];

      for (const row of rows) {
        const rowValues = getRowValues(row);
        const rowName = getRowName(row, rowValues);

        // Build searchable text from all values
        const allValuesStr = Object.values(rowValues)
          .map(v => String(v || '').trim())
          .filter(v => v)
          .join(' ');

        // Build ALL lineage paths (one per parent if multiple parents)
        const hierarchies = await buildAllHierarchyPaths(component, row);

        if (!hierarchies || hierarchies.length === 0) {
          console.log(`[INDEX] WARNING: No hierarchies built for ${component.name}/${rowName}`);
        }

        // Convert hierarchies to path strings for backward compatibility
        const pathStrings = hierarchies.map(h => h.map(node => node.rowName).join(' > '));

        // Create ONE index entry with ALL paths
        batchEntries.push({
          neighborhoodName,
          componentName: component.name,
          componentId: mongoose.isValidObjectId(component._id) ? component._id : null,
          rowId: mongoose.isValidObjectId(row._id) ? row._id : null,
          rowName,
          searchableTextLower: allValuesStr.toLowerCase(),
          allValues: [rowName, ...Object.values(rowValues)].map(v => String(v || '')),
          fieldByValue: rowValues,
          cachedLineagePaths: pathStrings, // Multiple paths if multiple parents (backward compatibility)
          // Ensure componentId/rowId inside cachedHierarchies are ObjectIds or null
          cachedHierarchies: hierarchies.map(path => path.map(node => ({
            componentName: node.componentName,
            componentId: mongoose.isValidObjectId(node.componentId) ? node.componentId : null,
            rowName: node.rowName,
            rowId: mongoose.isValidObjectId(node.rowId) ? node.rowId : null,
          }))), // Structured hierarchy data with component names
          dataType: rowValues.dataType || row.dataType || dataType,
          updatedAt: new Date(),
        });

        totalRowsProcessed++;

        if (batchEntries.length >= indexBatchSize) {
          await flushIndexBatch('batch-size');
        }
      }
    }

    await flushIndexBatch('final');

    if (totalIndexEntries > 0) {
      console.log(`[INDEX] Successfully indexed ${totalIndexEntries} entries into ${indexLabel}`);
    }

    console.log(`[INDEX] ${indexLabel} rebuild complete: ${neighborhoodName}`);
    logHeap('complete', { totalRowsProcessed, totalIndexEntries, truncatedHierarchyRows: truncatedHierarchyRows.size });
    return { success: true, entriesCount: totalIndexEntries };
  } catch (error) {
    console.error(`[INDEX] Error rebuilding ${indexLabel} for ${neighborhoodName}:`, error);
    throw error;
  }
}

module.exports = { rebuildSearchIndex };
