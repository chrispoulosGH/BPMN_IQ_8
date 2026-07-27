const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const User = require('../models/User');
const Component = require('../models/Component');
const ComponentSearchIndex = require('../models/ComponentSearchIndex');
const Data = require('../models/Data');
const DataSearchIndex = require('../models/DataSearchIndex');
const Model = require('../models/Model');
const { Actor, Product } = require('../models/ReferenceData');
const Server = require('../models/Server');
const DatabaseInstance = require('../models/DatabaseInstance');
const { rebuildSearchIndex } = require('../utils/searchIndexBuilder');
const fkRegistry = require('../services/ForeignKeyRegistry');
const fkResolver = require('../services/ForeignKeyResolver');
const { materializeFromBatches } = require('../lib/materializer');
const CanonicalComponent = require('../models/CanonicalComponent');
const CanonicalData = require('../models/CanonicalData');
const Diagram = require('../models/Diagram');
const { DEFAULT_NEIGHBORHOOD_NAME } = require('../utils/neighborhoodScope');
const { findApplicationByAcronym, findApplicationByCorrelationId } = require('../utils/applicationReferenceLookup');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });
const DATA_NEIGHBORHOOD_NAME = 'System Components';
const XLSX_READ_OPTIONS = {
  type: 'buffer',
  raw: false,
  dense: false,
  cellStyles: false,
  cellFormula: false,
  cellHTML: false,
  cellNF: false,
  cellText: false,
  cellDates: false,
};
const handleSpreadsheetUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum upload size is 250 MB.' });
      }
      return next(err);
    }
    return next();
  });
};
const PRIMARY_KEY_COLUMN = 'name';
const LEGACY_PART_COLUMN_PATTERN = /\bparts?$/i;
const COMPONENT_COLUMN_PATTERN = /\bcomponents?$/i;
const FK_COLUMN_PREFIX = /^fk_/i;
const LEGACY_COMPONENT_HEADER_ALIASES = new Map([
  ['lineofbusiness', 'LOB'],
  ['lob', 'LOB'],
  ['channel', 'Channel'],
  ['product', 'Product'],
  ['domain', 'L0'],
  ['l0', 'L0'],
  ['subdomain', 'L1'],
  ['l1', 'L1'],
  ['businessflow', 'Business Flow'],
  ['business_flow', 'Business Flow'],
  ['task', 'Task'],
  ['e2eux', 'Task'],
  ['application', 'Application'],
  ['applications', 'Application'],
]);

function getCurrentUserLabel(req) {
  return req.currentUser?.displayName || req.currentUser?.userId || '';
}

function getCurrentUserId(req) {
  return req.currentUser?.userId || '';
}

function createValidationError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getValidationMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err.message === 'string') return err.message;
  return err.toString?.() || 'Unknown error';
}

function collectValidationErrors({ modelCatalogRows = [], matchedModelColumns = [], uploadRows = [] }) {
  // Exact tuple membership validation for component columns only.
  // Build ordered list of model column keys from matchedModelColumns
  // matchedModelColumns may include a matchedModelHeader (the actual model CSV header that matched the component)
  const modelKeys = (matchedModelColumns || []).map((col) => String(col.matchedModelHeader || col.sourceColumnName || '').trim()).filter(Boolean);
  try {
    console.log('[VALIDATION TRACE] collectValidationErrors: modelKeys=', modelKeys);
    console.log('[VALIDATION TRACE] collectValidationErrors: modelCatalogRows=', (modelCatalogRows || []).length, 'uploadRows=', (uploadRows || []).length);
  } catch (e) {
    console.log('[VALIDATION TRACE] collectValidationErrors: trace init failed', e && e.message);
  }

  // Build set of normalized tuples from model catalog rows
  const tupleSet = new Set();
  (modelCatalogRows || []).forEach((modelRow, rowIdx) => {
    const values = getModelCatalogRowValues(modelRow);
    if (rowIdx === 0) {
      console.log('[VALIDATION TRACE] first modelRow values object:', JSON.stringify(values, null, 2).substring(0, 300));
    }
    const tuple = modelKeys.map((k) => {
      const val = getRowValueByColumnName(values, k);
      const comparable = getComparableValue(val);
      if (rowIdx === 0) console.log(`[VALIDATION TRACE] modelKey "${k}" -> value="${val}" -> comparable="${comparable}"`);
      return comparable;
    }).join('\u001F');
    tupleSet.add(tuple);
  });
  try {
    console.log('[VALIDATION TRACE] collectValidationErrors: tupleSetSize=', tupleSet.size, 'sampleTuples=', Array.from(tupleSet).slice(0, 10));
  } catch (e) {
    console.log('[VALIDATION TRACE] collectValidationErrors: tuple sample failed', e && e.message);
  }

  const errorRows = [];
  (uploadRows || []).forEach((uploadRow, index) => {
    const tuple = modelKeys.map((k) => {
      const val = getRowValueByColumnName(uploadRow, k);
      const comparable = getComparableValue(val);
      if (index === 0) console.log(`[VALIDATION TRACE] uploadKey "${k}" -> value="${val}" -> comparable="${comparable}"`);
      return comparable;
    }).join('\u001F');
    if (index === 0) console.log(`[VALIDATION TRACE] uploadRow tuple: "${tuple}"`);
    if (!tupleSet.has(tuple)) {
      const uploadedValues = {};
      modelKeys.forEach((k) => {
        uploadedValues[k] = String(getRowValueByColumnName(uploadRow, k) ?? '').trim();
      });

      try {
        console.log('[VALIDATION TRACE] collectValidationErrors: failingRow=', { rowNumber: index + 2, tuple, uploadedValues });
      } catch (e) {
        console.log('[VALIDATION TRACE] collectValidationErrors: failingRow trace failed', e && e.message);
      }

      errorRows.push({
        rowNumber: index + 2,
        uploadedValues,
        closestModelMatch: {},
        matchScore: 0,
      });
    }
  });

  return errorRows;
}

function validateUploadRowsAgainstModel({ modelCatalogRows = [], matchedModelColumns = [], uploadRows = [] }) {
  const errorRows = collectValidationErrors({ modelCatalogRows, matchedModelColumns, uploadRows });
  if (errorRows.length) {
    try {
      console.log('[VALIDATION TRACE] validateUploadRowsAgainstModel: errorRowsCount=', errorRows.length);
      console.log('[VALIDATION TRACE] validateUploadRowsAgainstModel: firstFailures=', errorRows.slice(0, 8));
    } catch (e) {
      console.log('[VALIDATION TRACE] validateUploadRowsAgainstModel: trace failed', e && e.message);
    }
    const preview = errorRows.slice(0, 12)
      .map((err) => {
        const values = matchedModelColumns.map((col) => `${col.sourceColumnName}=${err.uploadedValues[col.sourceColumnName]}`).join(', ');
        const model = matchedModelColumns.map((col) => `${col.sourceColumnName}=${err.closestModelMatch[col.sourceColumnName] || ''}`).join(', ');
        return `row ${err.rowNumber} (${values}) -> closest: ${model}`;
      })
      .join('; ');
    throw createValidationError(`Component upload is incompatible with model data. ${errorRows.length} row(s) did not match model hierarchy. Examples: ${preview}${errorRows.length > 12 ? '; ...' : ''}`);
  }
}

function saveValidationErrorReport({ neighborhoodName, errorRows = [], matchedModelColumns = [], sourceFileName = '' }) {
  try {
    const errorReportsDir = path.join(__dirname, '..', '..', 'data', 'error-reports');
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(errorReportsDir)) {
      fs.mkdirSync(errorReportsDir, { recursive: true });
    }

    // Build spreadsheet data
    const headers = ['Row Number', 'Match Score'];
    const columnNames = matchedModelColumns.map((col) => col.sourceColumnName || col);
    
    headers.push(...columnNames.map((col) => `${col} (Uploaded)`));
    headers.push(...columnNames.map((col) => `${col} (Model)`));

    const rows = errorRows.map((error) => {
      const row = [error.rowNumber, error.matchScore];
      columnNames.forEach((col) => {
        row.push(error.uploadedValues?.[col] || '');
      });
      columnNames.forEach((col) => {
        row.push(error.closestModelMatch?.[col] || '');
      });
      return row;
    });

    // Create workbook
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Failed Rows');

    // Set column widths
    const colWidths = headers.map(() => 20);
    worksheet['!cols'] = colWidths;

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('Z')[0];
    const safeSourceName = String(sourceFileName || 'upload').replace(/[^a-z0-9.-]/gi, '_');
    const filename = `validation-errors-${neighborhoodName}-${timestamp}-${safeSourceName}.xlsx`;
    const filepath = path.join(errorReportsDir, filename);

    // Write file with error handling
    try {
      const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
      if (!buffer || buffer.length === 0) {
        throw new Error('Generated buffer is empty');
      }
      fs.writeFileSync(filepath, buffer);
      console.log(`[ERROR-REPORT] Saved validation errors to: ${filepath}`);
    } catch (writeErr) {
      console.error(`[ERROR-REPORT] Failed to write file: ${writeErr.message}`);
      // Fallback: just return error info without file
      return {
        filename,
        errorCount: errorRows.length,
        error: `Could not write report file: ${writeErr.message}`,
      };
    }

    return {
      filename,
      filepath,
      relativePath: `data/error-reports/${filename}`,
      errorCount: errorRows.length,
    };
  } catch (err) {
    console.error(`[ERROR-REPORT] Failed to save validation error report: ${err.message}`, err);
    return null;
  }
}

async function getCurrentRole(req) {
  const userId = req.currentUser?.userId;
  if (!userId) return null;
  const user = await User.findOne({ userId }).lean();
  if (!user?.role) return null;
  return mongoose.connection.collection('roles').findOne({ name: user.role });
}

async function migrateFactoriesToDefaultNeighborhood() {
  const missingNeighborhoodFilter = {
    $or: [
      { neighborhoodName: { $exists: false } },
      { neighborhoodName: null },
      { neighborhoodName: '' },
    ],
  };

  const missingCount = await Component.countDocuments(missingNeighborhoodFilter);
  if (!missingCount) return;

  const hasDefaultNeighborhood = await Model.exists({ name: DEFAULT_NEIGHBORHOOD_NAME });
  if (!hasDefaultNeighborhood) return;

  await Component.updateMany(
    missingNeighborhoodFilter,
    { $set: { neighborhoodName: DEFAULT_NEIGHBORHOOD_NAME } }
  );
}

async function ensureNeighborhoodRecordsFromFactories() {
  const [factoryNeighborhoods, existingNeighborhoods] = await Promise.all([
    Component.distinct('neighborhoodName', { neighborhoodName: { $type: 'string', $ne: '' } }),
    Model.distinct('name'),
  ]);

  const existingNames = new Set(existingNeighborhoods.map((name) => String(name || '').trim()).filter(Boolean));
  const missingNames = factoryNeighborhoods
    .map((name) => String(name || '').trim())
    .filter((name) => name && !existingNames.has(name));

  if (!missingNames.length) return;

  await Model.insertMany(
    missingNames.map((name) => ({
      name,
      owner: name === DEFAULT_NEIGHBORHOOD_NAME ? 'System' : '',
      createdBy: name === DEFAULT_NEIGHBORHOOD_NAME ? 'system' : '',
    })),
    { ordered: false }
  ).catch((error) => {
    if (error?.code !== 11000) throw error;
  });
}

async function requireAdminWrite(req, res, next) {
  const role = await getCurrentRole(req);
  const canWrite = role?.capabilities?.some((capability) => capability.permission && capability.permission !== 'Read');
  if (!canWrite) return res.status(403).json({ error: 'Write access required' });
  next();
}

function normalizeColumnName(columnName) {
  const trimmed = String(columnName || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase() === PRIMARY_KEY_COLUMN ? PRIMARY_KEY_COLUMN : trimmed;
}

function normalizeRowsAndColumns(rows) {
  const seen = new Set();
  const columns = [];
  const normalizedRows = rows.map((row) => {
    const nextRow = {};
    for (const key of Object.keys(row || {})) {
      const column = normalizeColumnName(key);
      if (!column || seen.has(column)) continue;
      seen.add(column);
      columns.push(column);
    }

    for (const key of Object.keys(row || {})) {
      const column = normalizeColumnName(key);
      if (!column || Object.prototype.hasOwnProperty.call(nextRow, column)) continue;
      nextRow[column] = row[key] ?? '';
    }
    return nextRow;
  });

  console.log('[NORMALIZE_ROWS_AND_COLUMNS] Input rows count:', rows.length);
  console.log('[NORMALIZE_ROWS_AND_COLUMNS] Output columns count:', columns.length);
  console.log('[NORMALIZE_ROWS_AND_COLUMNS] Output columns list:', columns);

  return { rows: normalizedRows, columns };
}

function getNormalizedPrimaryKeyValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function validatePrimaryKeyRows(rows) {
  const seen = new Set();

  rows.forEach((row, index) => {
    const rawValue = row?.[PRIMARY_KEY_COLUMN];
    const normalizedValue = getNormalizedPrimaryKeyValue(rawValue);
    if (!normalizedValue) {
      throw createValidationError(`Each row must include a non-empty ${PRIMARY_KEY_COLUMN} value (row ${index + 1})`);
    }
    if (seen.has(normalizedValue)) {
      throw createValidationError(`Duplicate ${PRIMARY_KEY_COLUMN} value found: ${String(rawValue).trim()}`);
    }
    seen.add(normalizedValue);
  });
}

function validateComponentRows(rows, columns) {
  if (!columns.includes(PRIMARY_KEY_COLUMN)) {
    throw createValidationError(`Spreadsheet must include a ${PRIMARY_KEY_COLUMN} column`);
  }
  validatePrimaryKeyRows(rows);
}

function parseWorkbookRows(buffer, fileName) {
  try {
    if (!buffer || buffer.length === 0) {
      throw createValidationError('File buffer is empty');
    }
    const workbook = XLSX.read(buffer, XLSX_READ_OPTIONS);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error(`No worksheet found in ${fileName || 'uploaded file'}`);
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    if (matrix.length < 2) throw createValidationError('Spreadsheet must include a header row and at least one data row');

    // DEBUG: Log raw matrix dimensions before any filtering
    console.log('[PARSE_WORKBOOK_ROWS] Raw matrix dimensions:', { rowCount: matrix.length, headerCount: matrix[0]?.length });
    console.log('[PARSE_WORKBOOK_ROWS] ALL raw headers (including empty):', matrix[0]);

    const headers = (matrix[0] || []).map((value) => String(value || '').trim());
    console.log('[PARSE_WORKBOOK_ROWS] After trim headers count:', headers.length);
    console.log('[PARSE_WORKBOOK_ROWS] Trimmed headers:', headers);
    if (!headers.some(Boolean)) throw createValidationError('Spreadsheet header row is empty');

    const rawRows = matrix.slice(1)
      .map((row, rowIdx) => {
        try {
          return headers.reduce((acc, header, index) => {
            if (header && index < (row || []).length) {
              acc[header] = row[index] ?? '';
            } else if (header) {
              acc[header] = '';
            }
            return acc;
          }, {});
        } catch (e) {
          console.error(`[PARSE_WORKBOOK_ROWS] Error mapping row ${rowIdx}:`, e.message);
          throw e;
        }
      })
      .filter((row) => Object.values(row).some((value) => String(value ?? '').trim()));

    if (!rawRows.length) throw createValidationError('Spreadsheet does not contain any data rows');
    console.log('[PARSE_WORKBOOK_ROWS] After normalizeRowsAndColumns - input rawRows[0] keys:', Object.keys(rawRows[0] || {}).length);
    const { rows, columns } = normalizeRowsAndColumns(rawRows);
    if (!columns.length) throw createValidationError('Spreadsheet does not contain any usable columns');
    validateComponentRows(rows, columns);
    return { rows, columns, sheetName };
  } catch (e) {
    console.error('[PARSE_WORKBOOK_ROWS] Error:', e.message);
    throw e;
  }
}

function parseNeighborhoodWorkbook(buffer, fileName) {
  try {
    if (!buffer || buffer.length === 0) {
      throw createValidationError('File buffer is empty');
    }
    const workbook = XLSX.read(buffer, XLSX_READ_OPTIONS);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error(`No worksheet found in ${fileName || 'uploaded file'}`);
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    if (matrix.length < 2) throw createValidationError('Model CSV must include a header row and at least one data row');

    const headers = (matrix[0] || []).map((value) => String(value || '').trim());
    if (!headers.some(Boolean)) throw createValidationError('Model CSV header row is empty');

    const rows = matrix.slice(1)
      .map((row, rowIdx) => {
        try {
          return headers.reduce((acc, header, index) => {
            if (header && index < (row || []).length) {
              acc[header] = row[index] ?? '';
            } else if (header) {
              acc[header] = '';
            }
            return acc;
          }, {});
        } catch (e) {
          console.error(`[PARSE_NEIGHBORHOOD_WORKBOOK] Error mapping row ${rowIdx}:`, e.message);
          throw e;
        }
      })
      .filter((row) => Object.values(row).some((value) => String(value ?? '').trim()));

    if (!rows.length) throw createValidationError('Model CSV does not contain any usable data rows');
    return { headers, rows, sheetName };
  } catch (e) {
    console.error('[PARSE_NEIGHBORHOOD_WORKBOOK] Error:', e.message);
    throw e;
  }
}

function parseModelCatalogWorkbook(buffer, fileName) {
  try {
    if (!buffer || buffer.length === 0) {
      throw createValidationError('File buffer is empty');
    }
    
    console.log('[XLSX-READ] Starting XLSX.read with buffer size:', buffer.length);
    const xlsxReadStart = Date.now();
    const workbook = XLSX.read(buffer, XLSX_READ_OPTIONS);
    console.log('[XLSX-READ] XLSX.read succeeded in', Date.now() - xlsxReadStart, 'ms');
    
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error(`No worksheet found in ${fileName || 'uploaded file'}`);
    const sheet = workbook.Sheets[sheetName];
    
    console.log('[XLSX-PARSE] Converting sheet to JSON');
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    console.log('[XLSX-PARSE] Conversion succeeded, matrix size:', matrix.length);
    
    if (matrix.length < 2) throw createValidationError('Model CSV must include a header row and at least one data row');

    // DEBUG: Log raw matrix dimensions
    console.log('[PARSE_MODEL_CATALOG] Raw matrix dimensions:', { rowCount: matrix.length, headerCount: matrix[0]?.length });
    console.log('[PARSE_MODEL_CATALOG] ALL raw headers (including empty):', matrix[0]);

    const seenHeaders = new Set();
    // Keep track of original index for each column to map row values correctly
    const columnsWithIndices = [];
    (matrix[0] || []).forEach((value, originalIndex) => {
      const trimmed = String(value || '').trim();
      if (trimmed) {
        const normalized = trimmed.toLowerCase();
        if (seenHeaders.has(normalized)) {
          throw createValidationError(`Duplicate model column found: ${trimmed}`);
        }
        seenHeaders.add(normalized);
        columnsWithIndices.push({ name: trimmed, originalIndex });
      }
    });

    const columns = columnsWithIndices.map((col) => col.name);

    console.log('[PARSE_MODEL_CATALOG] After filtering empty headers count:', columns.length);
    console.log('[PARSE_MODEL_CATALOG] Filtered columns:', columns);

    if (!columns.length) throw createValidationError('Model CSV header row is empty');

    const rows = matrix.slice(1)
      .map((row) => columnsWithIndices.reduce((acc, colInfo) => {
        acc[colInfo.name] = row[colInfo.originalIndex] ?? '';
        return acc;
      }, {}))
      .filter((row) => Object.values(row).some((value) => String(value ?? '').trim()));

    if (!rows.length) throw createValidationError('Model CSV does not contain any usable data rows');
    console.log('[PARSE_MODEL_CATALOG] Successfully parsed workbook:', { columns: columns.length, rows: rows.length });
    return { columns, rows, sheetName };
  } catch (e) {
    console.error('[PARSE_MODEL_CATALOG] Error during parsing:', {
      message: e?.message,
      code: e?.code,
      type: e?.constructor?.name,
      fileName,
      bufferSize: buffer?.length,
      stack: e?.stack?.substring(0, 300),
    });
    throw e;
  }
}

function getNormalizedText(value) {
  return String(value ?? '').trim();
}

function getComponentFieldName(label) {
  const trimmed = getNormalizedText(label);
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === PRIMARY_KEY_COLUMN) return PRIMARY_KEY_COLUMN;
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isTreeComponentHeader(header) {
  const trimmedHeader = getNormalizedText(header);
  return Boolean(trimmedHeader) && COMPONENT_COLUMN_PATTERN.test(trimmedHeader);
}

function getTreeComponentColumnBaseName(header) {
  const trimmedHeader = getNormalizedText(header);
  if (!isTreeComponentHeader(trimmedHeader)) return '';
  return trimmedHeader.replace(COMPONENT_COLUMN_PATTERN, '').trim();
}

function getComponentColumnBaseName(header) {
  return getTreeComponentColumnBaseName(header);
}

function isIgnoredMetadataColumn(columnName) {
  const normalized = getComparableValue(columnName);
  if (!normalized) return true;

  // Global metadata columns to ignore
  const ignoredPatterns = [
    /^sequence/i,           // sequence_uml, domain_sequence, etc.
    /^editor$/i,             // editor
    /^action$/i,             // action
    /^api$/i,                // api
    /^date\s*updated/i,      // Date Updated, Date Updated Qualifier
    /^column\d+$/i,          // Column1, Column2, etc (empty columns)
    /^e2eux/i,               // e2eux_sequence, e2eux
    /^sox\s*control/i,       // SOX Control
  ];

  return ignoredPatterns.some((pattern) => pattern.test(normalized));
}

function parseForeignKeyColumnHeader(header) {
  const trimmedHeader = getNormalizedText(header);
  if (!FK_COLUMN_PREFIX.test(trimmedHeader)) return null;

  const rawReference = trimmedHeader.replace(FK_COLUMN_PREFIX, '').trim();
  if (!rawReference) return null;

  const [targetNamespace, targetColumnName = ''] = rawReference.split('.');
  const namespaceMatch = targetNamespace.match(/^(.+?)(?:\[(.+?)\])?$/);
  const targetGroup = namespaceMatch?.[1] ? getNormalizedText(namespaceMatch[1]) : '';
  const targetScope = namespaceMatch?.[2] ? getNormalizedText(namespaceMatch[2]) : '';
  const normalizedFieldName = getComponentFieldName(targetColumnName || targetGroup || rawReference);
  const fieldName = normalizedFieldName && normalizedFieldName !== PRIMARY_KEY_COLUMN
    ? normalizedFieldName
    : `fk_${getComponentFieldName(targetColumnName || targetGroup || rawReference || 'reference')}`;

  const targetColumnNameBase = getNormalizedText(targetColumnName).replace(/\s+qualifier$/i, '').trim();

  return {
    name: trimmedHeader,
    sourceColumnName: trimmedHeader,
    fieldName,
    targetReference: rawReference,
    targetGroup,
    targetScope,
    targetColumnName: getNormalizedText(targetColumnName),
    targetColumnNameBase,
  };
}

function identifyTupleType(columns) {
  // tupleType = columns ending in "Component" from left to right
  // These define the validation key for component rows against the model
  const tupleType = (columns || []).filter((col) => {
    const trimmed = getNormalizedText(col);
    return isTreeComponentHeader(trimmed);
  });
  
  console.log('[TUPLE] Identified tupleType:', tupleType);
  return tupleType;
}

function findLongestPrefixMatch(uploadTupleType, modelTupleType) {
  // Find the longest prefix of uploadTupleType that matches modelTupleType
  // Returns { matchedTuple, isFullMatch }
  const uploadLen = uploadTupleType.length;
  const modelLen = modelTupleType.length;
  
  let matchedLength = 0;
  for (let i = 0; i < Math.min(uploadLen, modelLen); i++) {
    if (uploadTupleType[i] === modelTupleType[i]) {
      matchedLength++;
    } else {
      break;
    }
  }
  
  const matchedTuple = uploadTupleType.slice(0, matchedLength);
  const isFullMatch = matchedLength === modelLen;
  
  console.log('[TUPLE] Prefix match: upload had', uploadLen, 'columns, model has', modelLen, ', matched', matchedLength, 'columns. Is full match:', isFullMatch);
  
  return { matchedTuple, isFullMatch, matchedLength };
}

function buildModelCatalogHash(rows, tupleType) {
  // Build a Map/Set of concatenated tuple values from model rows
  // Used to validate component rows against the model
  const hash = new Map();
  
  (rows || []).forEach((row, idx) => {
    const tuple = (tupleType || [])
      .map((col) => {
        const val = getRowValueByColumnName(row, col);
        return getComparableValue(val);
      })
      .join('\x1F');
    
    if (tuple && !hash.has(tuple)) {
      hash.set(tuple, true);
    }
    
    if (idx === 0) {
      console.log('[TUPLE] First model row tuple:', tuple);
    }
  });
  
  console.log('[TUPLE] Built modelCatalogHash with', hash.size, 'tuples');
  return hash;
}

function validateComponentRowsAgainstModelHash(uploadRows, tupleType, modelHash) {
  // Validate each component row against the model's tupleType and hash
  const errorRows = [];
  
  (uploadRows || []).forEach((uploadRow, index) => {
    const tuple = (tupleType || [])
      .map((col) => {
        const val = getRowValueByColumnName(uploadRow, col);
        return getComparableValue(val);
      })
      .join('\x1F');
    
    if (index === 0) {
      console.log('[TUPLE-VALIDATE] First component row tuple:', tuple);
    }
    
    if (!modelHash || !modelHash.has(tuple)) {
      errorRows.push({
        rowNumber: index + 2,
        tuple,
        uploadedValues: Object.fromEntries((tupleType || []).map((col) => [col, getRowValueByColumnName(uploadRow, col)])),
      });
    }
  });
  
  console.log('[TUPLE-VALIDATE] Validation complete. Total rows:', uploadRows.length, 'Error rows:', errorRows.length);
  return errorRows;
}

function buildHierarchyColumnPlan(columns) {
  const componentColumns = [];
  const seenComponentNames = new Set();
  let currentComponent = null;

  columns.forEach((column, index) => {
    const sourceColumnName = getNormalizedText(column);
    if (!sourceColumnName) return;

    // Skip ignored metadata columns
    if (isIgnoredMetadataColumn(sourceColumnName)) return;

    if (isTreeComponentHeader(sourceColumnName)) {
      const componentName = getTreeComponentColumnBaseName(sourceColumnName);
      if (!componentName) {
        throw createValidationError(`Invalid component column name: ${sourceColumnName}`);
      }

      const normalizedComponentName = getComparableValue(componentName);
      if (!normalizedComponentName) {
        throw createValidationError(`Invalid component column name: ${sourceColumnName}`);
      }
      if (seenComponentNames.has(normalizedComponentName)) {
        throw createValidationError(`Duplicate component column found: ${sourceColumnName}`);
      }

      const parentFactoryName = componentColumns[componentColumns.length - 1]?.name || '';
      currentComponent = {
        sourceColumnName,
        name: componentName,
        normalizedName: normalizedComponentName,
        parentFactoryName,
        index,
        qualifierColumns: [],
        foreignKeyColumns: [],
        assignedFieldNames: new Set(),
      };
      componentColumns.push(currentComponent);
      seenComponentNames.add(normalizedComponentName);
      return;
    }

    if (!currentComponent) return;

    if (FK_COLUMN_PREFIX.test(sourceColumnName)) {
      const foreignKeyColumn = parseForeignKeyColumnHeader(sourceColumnName);
      if (foreignKeyColumn) {
        if (currentComponent.assignedFieldNames.has(foreignKeyColumn.fieldName)) {
          throw createValidationError(`Duplicate component field found for ${currentComponent.name}: ${sourceColumnName}`);
        }
        currentComponent.assignedFieldNames.add(foreignKeyColumn.fieldName);
        currentComponent.foreignKeyColumns.push({
          ...foreignKeyColumn,
          columnIndex: index,
        });
      }
      return;
    }

    const fieldName = getComponentFieldName(sourceColumnName);
    if (!fieldName || fieldName === PRIMARY_KEY_COLUMN) return;

    if (currentComponent.assignedFieldNames.has(fieldName)) {
      throw createValidationError(`Duplicate component qualifier column found for ${currentComponent.name}: ${sourceColumnName}`);
    }

    currentComponent.assignedFieldNames.add(fieldName);
    currentComponent.qualifierColumns.push({
      name: sourceColumnName,
      sourceColumnName,
      fieldName,
      columnIndex: index,
    });
  });

  if (!componentColumns.length) {
    throw createValidationError('Spreadsheet does not contain any component columns ending in Component');
  }

  return componentColumns;
}

function splitMultiValue(value) {
  return getNormalizedText(value)
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeDistinctQualifierValues(currentValue, nextValue) {
  const merged = new Map();

  splitMultiValue(currentValue).forEach((value) => {
    merged.set(value.toLowerCase(), value);
  });
  splitMultiValue(nextValue).forEach((value) => {
    merged.set(value.toLowerCase(), value);
  });

  return Array.from(merged.values()).join(' | ');
}

function deriveNeighborhoodSchema(headers) {
  return buildHierarchyColumnPlan(headers).map((factory, index) => ({
    name: factory.name,
    sourceColumnName: factory.sourceColumnName,
    columnIndex: factory.index ?? index,
    parentFactoryName: factory.parentFactoryName,
    level: index,
    qualifiers: (factory.qualifierColumns || []).map((qualifier) => ({
      name: qualifier.name,
      sourceColumnName: qualifier.sourceColumnName,
      fieldName: qualifier.fieldName,
      columnIndex: qualifier.columnIndex,
    })),
    foreignKeyColumns: (factory.foreignKeyColumns || []).map((fk) => ({
      name: fk.name,
      sourceColumnName: fk.sourceColumnName,
      fieldName: fk.fieldName,
      targetReference: fk.targetReference,
      targetGroup: fk.targetGroup,
      targetScope: fk.targetScope,
      targetColumnName: fk.targetColumnName,
      columnIndex: fk.columnIndex,
    })),
  }));
}

function getRowValueByColumnName(row, columnName) {
  const normalizedColumnName = String(columnName || '').trim().toLowerCase();
  if (!normalizedColumnName) return '';

  const matchingKey = Object.keys(row || {}).find((key) => String(key || '').trim().toLowerCase() === normalizedColumnName);
  return matchingKey ? row[matchingKey] : '';
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getComparableValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getCanonicalModelMatchValue(value) {
  let normalized = getComparableValue(value);
  if (!normalized) return '';

  // Strip hierarchical numeric prefixes such as "2.04 " or "3 ".
  normalized = normalized.replace(/^\d+(?:\.\d+)*\s*[.)-]?\s*/, '');
  normalized = normalized.replace(/&/g, ' and ');
  normalized = normalized.replace(/\//g, ' ');
  normalized = normalized.replace(/[^a-z0-9\s]+/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();

  if (!normalized) return '';

  const phraseAliases = new Map([
    ['lead managment', 'lead management'],
    ['proposal management', 'quotation and proposal rfp mgmt'],
    ['proposal mgmt', 'quotation and proposal rfp mgmt'],
    ['pricing management', 'pricing order mgmt'],
    ['pricing mgmt', 'pricing order mgmt'],
    ['design management', 'design mgmt'],
  ]);

  if (phraseAliases.has(normalized)) {
    normalized = phraseAliases.get(normalized);
  }

  normalized = normalized
    .replace(/\bmanagment\b/g, 'management')
    .replace(/\bmanagement\b/g, 'mgmt')
    .replace(/\bopportunity\b/g, 'oppty')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

function getModelCatalogRowValues(row) {
  if (!row) return {};
  // When using .lean() with Maps, Mongoose converts them to plain objects
  // but sometimes they may still be wrapped, so we handle multiple cases
  if (row.values instanceof Map) {
    console.log('[VALIDATION] Converting Map to object');
    return Object.fromEntries(row.values.entries());
  }
  if (row.values && typeof row.values.toObject === 'function') {
    console.log('[VALIDATION] Converting toObject()');
    return row.values.toObject();
  }
  if (row.values && typeof row.values === 'object') {
    console.log('[VALIDATION] Using row.values as object');
    return { ...row.values };
  }
  if (typeof row.toObject === 'function') {
    console.log('[VALIDATION] Using row.toObject()');
    return row.toObject();
  }
  console.log('[VALIDATION] Using row as object, type:', typeof row, 'keys:', Object.keys(row).slice(0, 5));
  return { ...row };
}

function classifyComponentColumnsAgainstModel({ modelCatalogColumns = [], componentColumns = [] }) {
  // Build normalized list of model catalog column names (strings)
  const catalogColumns = (modelCatalogColumns || []).map((col) => {
    const raw = typeof col === 'string' ? col : col?.sourceColumnName || '';
    return {
      raw,
      norm: getComparableValue(raw),
    };
  }).filter(c => c.norm);

  const matchedModelColumns = [];
  const unmatchedComponentColumns = [];

  for (const componentColumn of componentColumns || []) {
    const compNorm = getComparableValue(componentColumn.sourceColumnName || '');
    if (!compNorm) {
      unmatchedComponentColumns.push(componentColumn);
      continue;
    }

    // Exact match first
    let found = catalogColumns.find(c => c.norm === compNorm);

    // Fallback: model header contains the component base as prefix or separate word (e.g. "l0 component  business unit alignment")
    if (!found) {
      const pattern = new RegExp(`(^|\\W)${escapeRegExp(compNorm)}(\\W|$)`, 'i');
      found = catalogColumns.find(c => pattern.test(c.norm));
    }

    if (found) {
      matchedModelColumns.push({
        ...componentColumn,
        // preserve the model header used for matching so downstream tuple building can reference it
        matchedModelHeader: found.raw,
      });
    } else {
      unmatchedComponentColumns.push(componentColumn);
    }
  }
  try {
    console.log('[VALIDATION TRACE] classifyComponentColumnsAgainstModel: modelCatalogColumnsCount=', (modelCatalogColumns || []).length);
    console.log('[VALIDATION TRACE] classifyComponentColumnsAgainstModel: matched=', matchedModelColumns.map(m => ({ name: m.name, sourceColumnName: m.sourceColumnName, matchedModelHeader: m.matchedModelHeader })));
    if (unmatchedComponentColumns.length) console.log('[VALIDATION TRACE] classifyComponentColumnsAgainstModel: unmatched=', unmatchedComponentColumns.map(u => ({ name: u.name, sourceColumnName: u.sourceColumnName })));
  } catch (e) {
    console.log('[VALIDATION TRACE] classifyComponentColumnsAgainstModel: trace failed', e && e.message);
  }

  return {
    matchedModelColumns,
    unmatchedComponentColumns,
  };
}

function splitUploadColumns(columns) {
  const hierarchyPlan = buildHierarchyColumnPlan(columns);
  
  if (!hierarchyPlan.length) {
    throw createValidationError('Upload must include at least one component column (for example: Application Component)');
  }

  const componentColumns = hierarchyPlan.map((component, index) => ({
    sourceColumnName: component.sourceColumnName,
    name: component.name,
    normalizedName: component.normalizedName,
    parentFactoryName: component.parentFactoryName || '',
    index: component.index ?? index,
    qualifierColumns: (component.qualifierColumns || []).map((qualifier) => ({
      name: qualifier.name,
      sourceColumnName: qualifier.sourceColumnName,
      fieldName: qualifier.fieldName,
    })),
    foreignKeyColumns: (component.foreignKeyColumns || []).map((foreignKey) => ({
      name: foreignKey.name,
      sourceColumnName: foreignKey.sourceColumnName,
      fieldName: foreignKey.fieldName,
      targetReference: foreignKey.targetReference,
      targetGroup: foreignKey.targetGroup,
      targetScope: foreignKey.targetScope,
      targetColumnName: foreignKey.targetColumnName,
      targetColumnNameBase: foreignKey.targetColumnNameBase,
    })),
  }));

  return { componentColumns };
}

function validateUploadRowsAgainstModel({ modelCatalogRows = [], matchedModelColumns = [], uploadRows = [] }) {
  const errorRows = collectValidationErrors({ modelCatalogRows, matchedModelColumns, uploadRows });
  if (errorRows.length) {
    const preview = errorRows.slice(0, 12).map((err) => {
      const values = matchedModelColumns.map((col) => `${col.sourceColumnName}=${err.uploadedValues?.[col.sourceColumnName] || ''}`).join(', ');
      return `row ${err.rowNumber} (${values})`;
    }).join('; ');
    throw createValidationError(`Component upload is incompatible with model data. ${errorRows.length} row(s) did not match model hierarchy. Examples: ${preview}${errorRows.length > 12 ? '; ...' : ''}`);
  }
}

function getDataComponentType(componentName) {
  const normalized = getRequestedLoadTypeName(componentName);
  if (!normalized) return null;

  const compact = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = new Map([
    ['application', 'application'],
    ['applications', 'application'],
    ['app', 'application'],
    ['apps', 'application'],
    ['server', 'server'],
    ['servers', 'server'],
    ['servercomponent', 'server'],
    ['serverscomponent', 'server'],
    ['product', 'product'],
    ['products', 'product'],
    ['actor', 'actor'],
    ['actors', 'actor'],
    ['database', 'databaseinstance'],
    ['databases', 'databaseinstance'],
    ['databaseinstance', 'databaseinstance'],
    ['databaseinstances', 'databaseinstance'],
    ['db', 'databaseinstance'],
    ['dbs', 'databaseinstance'],
    ['dbinstance', 'databaseinstance'],
    ['dbinstances', 'databaseinstance'],
  ]);

  return aliases.get(compact) || compact;
}

function getRequestedLoadTypeName(value) {
  return getNormalizedText(value).replace(/\s+data$/i, '').replace(/\s+component$/i, '').trim();
}

function normalizeDataTypeKey(value) {
  return getDataComponentType(value) || '';
}

function getDataTypeSearchCandidates(value) {
  const requested = getRequestedLoadTypeName(value);
  if (!requested) return [];

  const canonical = normalizeDataTypeKey(requested) || requested.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = new Map([
    ['application', ['application', 'applications', 'app', 'apps']],
    ['server', ['server', 'servers', 'servercomponent', 'serverscomponent']],
    ['product', ['product', 'products']],
    ['actor', ['actor', 'actors']],
    ['databaseinstance', ['database', 'databases', 'databaseinstance', 'databaseinstances', 'db', 'dbs', 'dbinstance', 'dbinstances']],
  ]);

  return Array.from(new Set([
    requested,
    canonical,
    ...(aliases.get(canonical) || []),
  ].filter(Boolean)));
}

function columnMatchesRequestedLoadType(columnName, requestedTypeName) {
  const requested = normalizeDataTypeKey(requestedTypeName);
  if (!requested) return true;

  const columnAlias = normalizeDataTypeKey(columnName);
  if (columnAlias) return requested === columnAlias;

  return getComparableValue(columnName) === getComparableValue(requestedTypeName);
}

function getApplicationCorrelationIdFromUploadRow(row) {
  if (!row || typeof row !== 'object') return '';

  const candidateColumns = [
    'correlation_id',
    'correlation id',
    'correlationid',
    'application correlation id',
    'app correlation id',
    'app_correlation_id',
    'application_correlation_id',
  ];

  for (const columnName of candidateColumns) {
    const candidate = getNormalizedText(getRowValueByColumnName(row, columnName));
    if (candidate) return candidate;
  }

  return '';
}

function getApplicationAcronymFromUploadRow(row, fallbackValue = '') {
  if (!row || typeof row !== 'object') return getNormalizedText(fallbackValue);

  const candidateColumns = [
    'application acronym',
    'app acronym',
    'acronym',
    'application_acronym',
    'app_acronym',
    'app_x_att2_itap_u_appl_acron_nm',
  ];

  for (const columnName of candidateColumns) {
    const candidate = getNormalizedText(getRowValueByColumnName(row, columnName));
    if (candidate) return candidate;
  }

  return getNormalizedText(fallbackValue);
}

async function doesDataComponentExist({ type, value, neighborhoodName, correlationId, acronym }) {
  const trimmedValue = getNormalizedText(value);
  if (!trimmedValue) return true;

  const trimmedCorrelationId = getNormalizedText(correlationId);
  const trimmedAcronym = getNormalizedText(acronym);
  const exactMatchRegex = new RegExp(`^${escapeRegExp(trimmedValue)}$`, 'i');

  if (type === 'application') {
    if (trimmedCorrelationId) {
      const appByCorrelation = await findApplicationByCorrelationId(neighborhoodName, trimmedCorrelationId);
      if (appByCorrelation) return true;
    }

    if (!trimmedAcronym) return false;
    const app = await findApplicationByAcronym(neighborhoodName, trimmedAcronym);
    if (!app) {
      console.log('[VALIDATION TRACE] Missing application reference', {
        type: 'application',
        value: trimmedValue,
        neighborhoodName,
        correlationId: trimmedCorrelationId,
        acronym: trimmedAcronym,
      });
    }
    return Boolean(app);
  }

  if (type === 'product') {
    const [product, productComponent] = await Promise.all([
      Product.findOne({
        name: exactMatchRegex,
        neighborhoodName: { $in: [DEFAULT_NEIGHBORHOOD_NAME, neighborhoodName] },
      }, { _id: 1 }).lean(),
      Component.findOne({
        neighborhoodName,
        name: { $regex: /^product$/i },
        'rows.values.name': exactMatchRegex,
      }, { _id: 1 }).lean(),
    ]);
    if (!product && !productComponent) {
      console.log('[VALIDATION TRACE] Missing product reference', { type: 'product', value: trimmedValue, neighborhoodName, query: { exactMatchRegex: exactMatchRegex.toString() } });
    }
    return Boolean(product || productComponent);
  }

  if (type === 'server') {
    const server = await Server.findOne({ name: exactMatchRegex }, { _id: 1 }).lean();
    if (!server) console.log('[VALIDATION TRACE] Missing server reference', { type: 'server', value: trimmedValue, neighborhoodName, query: { exactMatchRegex: exactMatchRegex.toString() } });
    return Boolean(server);
  }

  if (type === 'databaseInstance') {
    const instance = await DatabaseInstance.findOne(
      { $or: [{ name: exactMatchRegex }, { instanceName: exactMatchRegex }] },
      { _id: 1 }
    ).lean();
    if (!instance) console.log('[VALIDATION TRACE] Missing databaseInstance reference', { type: 'databaseInstance', value: trimmedValue, neighborhoodName, query: { exactMatchRegex: exactMatchRegex.toString() } });
    return Boolean(instance);
  }

  if (type === 'actor') {
    const [actor, actorComponent] = await Promise.all([
      Actor.findOne({
        name: exactMatchRegex,
        neighborhoodName: { $in: [DEFAULT_NEIGHBORHOOD_NAME, neighborhoodName] },
      }, { _id: 1 }).lean(),
      Component.findOne({
        neighborhoodName,
        name: { $regex: /^actor$/i },
        'rows.values.name': exactMatchRegex,
      }, { _id: 1 }).lean(),
    ]);
    if (!actor && !actorComponent) {
      console.log('[VALIDATION TRACE] Missing actor reference', { type: 'actor', value: trimmedValue, neighborhoodName, query: { exactMatchRegex: exactMatchRegex.toString() } });
    }
    return Boolean(actor || actorComponent);
  }

  return true;
}

// Maps a hierarchy component column name (e.g. "channel", "Value Stream") to the
// canonical lineage field key used by diagram generation. Returns null for columns
// that don't correspond to a known lineage level (e.g. Task, Application).
const LINEAGE_FIELD_ALIASES = new Map([
  ['lineofbusiness', 'lineOfBusiness'],
  ['lob', 'lineOfBusiness'],
  ['channel', 'channel'],
  ['product', 'product'],
  ['domain', 'domain'],
  ['l0', 'domain'],
  ['subdomain', 'subdomain'],
  ['l1', 'subdomain'],
  ['valuestream', 'valueStream'],
  ['journey', 'journey'],
  ['businesscapability', 'businessCapability'],
  ['businessprocessflow', 'businessFlow'],
  ['businessflow', 'businessFlow'],
]);

function mapComponentNameToLineageField(componentName) {
  const normalized = String(componentName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return LINEAGE_FIELD_ALIASES.get(normalized) || null;
}

// Captures the literal hierarchy values present on a single source spreadsheet row
// (line of business, channel, product, domain, subdomain, value stream, journey,
// business capability) at upload time — before the row is split apart into separate
// per-component factory rows. This snapshot is the only unambiguous record of which
// exact branch (e.g. which channel) a given row belonged to, because component nodes
// like Value Stream/Business Capability are shared across many hierarchy branches and
// can no longer be traced back to a single source row once merged.
function buildLineageSnapshot(rowComponentValues) {
  const snapshot = {};
  for (const [componentName, value] of rowComponentValues.entries()) {
    if (!value) continue;
    const fieldName = mapComponentNameToLineageField(componentName);
    if (!fieldName) continue;
    snapshot[fieldName] = value;
  }
  return snapshot;
}

async function buildComponentUploadFactories({ neighborhoodName, rows, componentColumns, sourceFileName, owner, createdBy, rowNumberOffset = 0 }) {
  const factoryRowMaps = new Map(componentColumns.map((column) => [column.name, new Map()]));
  const dataExistenceCache = new Map();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rowComponentValues = new Map(componentColumns.map((column) => [column.name, getNormalizedText(getRowValueByColumnName(row, column.sourceColumnName))]));
    const applicationCorrelationId = getApplicationCorrelationIdFromUploadRow(row);
    const lineageSnapshot = buildLineageSnapshot(rowComponentValues);

    for (const column of componentColumns) {
      const componentValue = rowComponentValues.get(column.name) || '';
      if (!componentValue) continue;

      const parentName = column.parentFactoryName ? (rowComponentValues.get(column.parentFactoryName) || '') : '';
      if (column.parentFactoryName && !parentName) {
        throw createValidationError(`Row ${rowNumberOffset + rowIndex + 2}: ${column.name} has value \"${componentValue}\" but parent component ${column.parentFactoryName} is blank`);
      }

      const rowMap = factoryRowMaps.get(column.name);
      const primaryKey = getNormalizedPrimaryKeyValue(componentValue);
      const existingRow = rowMap.get(primaryKey);
      // Per upload policy: skip foreign-key existence checks here.
      // Validation is performed separately by exact tuple membership against the model.
      // Always mark staged for persistence; tuple validation will abort before writes if mismatches are found.
      const rowState = 'staged';
      const qualifierValues = (column.qualifierColumns || []).reduce((acc, qualifier) => {
        acc[qualifier.fieldName] = getNormalizedText(getRowValueByColumnName(row, qualifier.sourceColumnName));
        return acc;
      }, {});
      const foreignKeyValues = (column.foreignKeyColumns || []).reduce((acc, foreignKey) => {
        acc[foreignKey.fieldName] = getNormalizedText(getRowValueByColumnName(row, foreignKey.sourceColumnName));
        return acc;
      }, {});
      
      // Build foreignKeys map for the row (uses sourceColumnName as key for lookup)
      const foreignKeysMap = (column.foreignKeyColumns || []).reduce((acc, foreignKey) => {
        acc[foreignKey.sourceColumnName] = getNormalizedText(getRowValueByColumnName(row, foreignKey.sourceColumnName));
        return acc;
      }, {});

      if (!existingRow) {
        const rowValues = { [PRIMARY_KEY_COLUMN]: componentValue, ...qualifierValues, ...foreignKeyValues };
        if (Object.keys(lineageSnapshot).length) {
          // Keep the original single-snapshot field for backward compatibility, plus a
          // variants array so rows reused under more than one ancestor branch (e.g. the
          // same Business Process Flow name under two different Business Capabilities)
          // can later be matched back to the correct branch instead of only ever using
          // the first row's snapshot.
          rowValues.__lineage = lineageSnapshot;
          rowValues.__lineageVariants = [lineageSnapshot];
        }
        rowMap.set(primaryKey, {
          values: rowValues,
          foreignKeys: foreignKeysMap,
          owner,
          state: rowState,
          sourcedFrom: sourceFileName,
          createdBy,
          updatedBy: createdBy,
          parentFactoryName: column.parentFactoryName,
          parentName,
        });
        continue;
      }

      existingRow.parentName = mergeDistinctQualifierValues(existingRow.parentName || '', parentName || '');
      if (existingRow.state !== 'invalid' && rowState === 'invalid') {
        existingRow.state = 'invalid';
      }
      existingRow.updatedBy = createdBy;
      existingRow.sourcedFrom = sourceFileName;

      if (Object.keys(lineageSnapshot).length) {
        existingRow.values.__lineageVariants = existingRow.values.__lineageVariants || (existingRow.values.__lineage ? [existingRow.values.__lineage] : []);
        const isDuplicate = existingRow.values.__lineageVariants.some(
          (variant) => JSON.stringify(variant) === JSON.stringify(lineageSnapshot)
        );
        if (!isDuplicate) existingRow.values.__lineageVariants.push(lineageSnapshot);
      }

      Object.entries(qualifierValues).forEach(([fieldName, nextValue]) => {
        const currentValue = getNormalizedText(existingRow.values?.[fieldName]);
        if (!currentValue) {
          existingRow.values[fieldName] = nextValue;
          return;
        }
        if (nextValue && currentValue !== nextValue) {
          existingRow.values[fieldName] = mergeDistinctQualifierValues(currentValue, nextValue);
        }
      });

      Object.entries(foreignKeyValues).forEach(([fieldName, nextValue]) => {
        const currentValue = getNormalizedText(existingRow.values?.[fieldName]);
        if (!currentValue) {
          existingRow.values[fieldName] = nextValue;
          return;
        }
        if (nextValue && currentValue !== nextValue) {
          existingRow.values[fieldName] = mergeDistinctQualifierValues(currentValue, nextValue);
        }
      });
      
      // Merge foreignKeys map with sourceColumnName as key
      Object.entries(foreignKeysMap).forEach(([sourceColumnName, fkValue]) => {
        if (fkValue) {
          existingRow.foreignKeys = existingRow.foreignKeys || {};
          existingRow.foreignKeys[sourceColumnName] = fkValue;
        }
      });
    }
  }

  return componentColumns
    .map((column) => {
      const componentType = column.name;
      const columnsArray = [
        PRIMARY_KEY_COLUMN,
        ...(column.qualifierColumns || []).map((qualifier) => qualifier.fieldName),
        ...(column.foreignKeyColumns || []).map((foreignKey) => foreignKey.fieldName),
      ];
      return {
        neighborhoodName,
        name: column.name,
        sourceColumnName: column.sourceColumnName,
        parentFactoryName: column.parentFactoryName,
        componentType: componentType,
        qualifierColumns: (column.qualifierColumns || []).map((qualifier) => ({
          name: qualifier.name,
          sourceColumnName: qualifier.sourceColumnName,
          fieldName: qualifier.fieldName,
        })),
        foreignKeyColumns: (column.foreignKeyColumns || []).map((foreignKey) => ({
          name: foreignKey.name,
          sourceColumnName: foreignKey.sourceColumnName,
          fieldName: foreignKey.fieldName,
          targetReference: foreignKey.targetReference,
          targetGroup: foreignKey.targetGroup,
          targetScope: foreignKey.targetScope,
          targetColumnName: foreignKey.targetColumnName,
        })),
        columns: columnsArray,
        owner,
        createdBy,
        sourceFileName,
        rows: Array.from(factoryRowMaps.get(column.name).values()),
      };
    })
    .filter((factory) => factory.rows.length > 0);
}

function componentRowValuesFromFactoryColumns(columns, uploadedValues) {
  return (columns || []).reduce((acc, column) => {
    if (column === PRIMARY_KEY_COLUMN) {
      acc[column] = getNormalizedText(uploadedValues?.[PRIMARY_KEY_COLUMN]);
      return acc;
    }
    acc[column] = uploadedValues?.[column] ?? '';
    return acc;
  }, {});
}

function mergeColumnMetadata(existingColumns = [], nextColumns = []) {
  const merged = new Map();

  (existingColumns || []).forEach((column) => {
    const key = getComparableValue(column?.fieldName || column?.sourceColumnName || column?.name);
    if (!key) return;
    merged.set(key, { ...column });
  });

  (nextColumns || []).forEach((column) => {
    const key = getComparableValue(column?.fieldName || column?.sourceColumnName || column?.name);
    if (!key) return;
    merged.set(key, {
      ...(merged.get(key) || {}),
      ...column,
    });
  });

  return Array.from(merged.values());
}

function mergeStringColumns(existingColumns = [], nextColumns = []) {
  const merged = [];
  const seen = new Set();

  [...(existingColumns || []), ...(nextColumns || [])].forEach((column) => {
    const normalized = getComparableValue(column);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(column);
  });

  return merged;
}

function mergeUploadedRowsIntoFactory({ existingFactory, uploadedFactory, createdBy, sourceFileName }) {
  const existingRowsByKey = new Map(
    (existingFactory.rows || []).map((row) => [getNormalizedPrimaryKeyValue(row.values?.get(PRIMARY_KEY_COLUMN)), row])
  );

  (uploadedFactory.rows || []).forEach((uploadedRow) => {
    const normalizedPrimaryKey = getNormalizedPrimaryKeyValue(uploadedRow.values?.[PRIMARY_KEY_COLUMN]);
    if (!normalizedPrimaryKey) return;

    const currentRow = existingRowsByKey.get(normalizedPrimaryKey);
    if (!currentRow) {
      existingFactory.rows.push({
        values: componentRowValuesFromFactoryColumns(existingFactory.columns, uploadedRow.values),
        owner: uploadedRow.owner || '',
        state: uploadedRow.state || 'staged',
        sourcedFrom: sourceFileName,
        createdBy,
        updatedBy: createdBy,
        parentFactoryName: uploadedRow.parentFactoryName || existingFactory.parentFactoryName || '',
        parentName: uploadedRow.parentName || '',
      });
      return;
    }

    currentRow.parentName = mergeDistinctQualifierValues(currentRow.parentName || '', uploadedRow.parentName || '');
    if ((currentRow.state || 'staged') !== 'invalid' && uploadedRow.state === 'invalid') {
      currentRow.state = 'invalid';
    } else if ((currentRow.state || 'staged') === 'staged' && uploadedRow.state === 'staged') {
      currentRow.state = 'staged';
    }
    currentRow.updatedBy = createdBy;
    currentRow.sourcedFrom = sourceFileName;
  });

  existingFactory.sourceFileName = sourceFileName;
}

function buildNeighborhoodFactories({ neighborhoodName, rows, definitions, sourceFileName, owner, createdBy, rowState = 'staged' }) {
  const factoryRowMaps = new Map(definitions.map((definition) => [definition.name, new Map()]));

  rows.forEach((row, rowIndex) => {
    const rowFactoryValues = new Map(definitions.map((definition) => [definition.name, getNormalizedText(row[definition.sourceColumnName]) ]));

    definitions.forEach((definition) => {
      const factoryValue = rowFactoryValues.get(definition.name) || '';
      if (!factoryValue) return;

      const parentName = definition.parentFactoryName ? (rowFactoryValues.get(definition.parentFactoryName) || '') : '';
      if (definition.parentFactoryName && !parentName) {
        throw createValidationError(`Row ${rowIndex + 2}: ${definition.name} requires a ${definition.parentFactoryName} parent component value`);
      }

      const qualifierValues = definition.qualifiers.reduce((acc, qualifier) => {
        acc[qualifier.fieldName] = getNormalizedText(row[qualifier.sourceColumnName]);
        return acc;
      }, {});

      const primaryKey = getNormalizedPrimaryKeyValue(factoryValue);
      const rowMap = factoryRowMaps.get(definition.name);
      const existingRow = rowMap.get(primaryKey);

      if (!existingRow) {
        rowMap.set(primaryKey, {
          values: { [PRIMARY_KEY_COLUMN]: factoryValue, ...qualifierValues },
          owner,
          state: rowState,
          sourcedFrom: sourceFileName,
          createdBy,
          updatedBy: createdBy,
          parentFactoryName: definition.parentFactoryName,
          parentName,
        });
        return;
      }

      existingRow.parentName = mergeDistinctQualifierValues(existingRow.parentName || '', parentName || '');

      Object.entries(qualifierValues).forEach(([fieldName, nextValue]) => {
        const currentValue = getNormalizedText(existingRow.values?.[fieldName]);
        if (!currentValue) {
          existingRow.values[fieldName] = nextValue;
          return;
        }
        if (nextValue && currentValue !== nextValue) {
          existingRow.values[fieldName] = mergeDistinctQualifierValues(currentValue, nextValue);
        }
      });
    });
  });

  return definitions.map((definition) => {
    const columns = [PRIMARY_KEY_COLUMN, ...definition.qualifiers.map((qualifier) => qualifier.fieldName)];
    const builtRows = Array.from(factoryRowMaps.get(definition.name).values());
    validateComponentRows(builtRows.map((row) => row.values), columns);
    return {
      neighborhoodName,
      name: definition.name,
      sourceColumnName: definition.sourceColumnName,
      parentFactoryName: definition.parentFactoryName || '',
      columns,
      owner,
      createdBy,
      sourceFileName,
      rows: builtRows,
    };
  });
}

function serializeFactory(factory) {
  const toPlainObject = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value.entries());
    if (typeof value.toObject === 'function') return value.toObject();
    return { ...value };
  };

  return {
    _id: String(factory._id),
    neighborhoodName: factory.neighborhoodName,
    name: factory.name,
    sourceColumnName: factory.sourceColumnName || '',
    parentFactoryName: factory.parentFactoryName || '',
    componentType: factory.componentType || '',
    dataType: factory.dataType || '',
    loadDomain: factory.loadDomain || '',
    columns: factory.columns,
    qualifierColumns: (factory.qualifierColumns || []).map((qualifier) => ({
      name: qualifier.name,
      sourceColumnName: qualifier.sourceColumnName,
      fieldName: qualifier.fieldName,
    })),
    foreignKeyColumns: (factory.foreignKeyColumns || []).map((foreignKey) => ({
      name: foreignKey.name,
      sourceColumnName: foreignKey.sourceColumnName,
      fieldName: foreignKey.fieldName,
      targetReference: foreignKey.targetReference,
      targetGroup: foreignKey.targetGroup,
      targetScope: foreignKey.targetScope,
      targetColumnName: foreignKey.targetColumnName,
    })),
    owner: factory.owner || '',
    createdBy: factory.createdBy || '',
    sourceFileName: factory.sourceFileName || '',
    createdAt: factory.createdAt,
    updatedAt: factory.updatedAt,
    rowCount: Array.isArray(factory.rows) ? factory.rows.length : 0,
    rows: (factory.rows || []).map((row, rowIndex) => ({
      _id: String(row._id || `${factory._id || factory.batchId || factory.name}:${rowIndex}`),
      values: toPlainObject(row.values),
      owner: row.owner || '',
      state: row.state || 'staged',
      sourcedFrom: row.sourcedFrom || '',
      createdBy: row.createdBy || '',
      updatedBy: row.updatedBy || '',
      parentFactoryName: row.parentFactoryName || '',
      parentName: row.parentName || '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  };
}

function serializeModelCatalog(model, page = 1, limit = 50) {
  const toPlainObject = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value.entries());
    if (typeof value.toObject === 'function') return value.toObject();
    return { ...value };
  };

  const allRows = model.modelCatalogRows || [];
  const totalCount = allRows.length;
  const totalPages = Math.ceil(totalCount / limit);
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;
  const paginatedRows = allRows.slice(startIndex, endIndex);

  // Extract all unique column names from row data (including component-added columns like FK_)
  // Model columns may be a subset; actual data may include more columns from component uploads
  const allColumnNames = new Set(model.modelCatalogColumns || []);
  
  console.log('[SERIALIZE_CATALOG] Starting serialization');
  console.log('[SERIALIZE_CATALOG] model.modelCatalogRows count:', allRows.length);
  if (allRows.length > 0) {
    const firstRow = allRows[0];
    console.log('[SERIALIZE_CATALOG] First row raw object:', { hasValues: !!firstRow.values, valuesType: typeof firstRow.values, isMap: firstRow.values instanceof Map });
    console.log('[SERIALIZE_CATALOG] First row.values raw keys:', firstRow.values ? Object.keys(firstRow.values) : []);
    if (firstRow.values instanceof Map) {
      console.log('[SERIALIZE_CATALOG] First row.values is Map, entries:', Array.from(firstRow.values.keys()));
    }
  }
  
  allRows.forEach((row, idx) => {
    const rowValues = toPlainObject(row.values);
    const rowKeys = Object.keys(rowValues);
    if (idx === 0) {
      console.log('[SERIALIZE_CATALOG] First row after toPlainObject keys:', rowKeys.length);
      console.log('[SERIALIZE_CATALOG] First row after toPlainObject keys list:', rowKeys);
    }
    Object.keys(rowValues).forEach((colName) => {
      allColumnNames.add(colName);
    });
  });
  const finalColumns = Array.from(allColumnNames);
  
  console.log('[SERIALIZE_CATALOG] Model:', model.name);
  console.log('[SERIALIZE_CATALOG] Model columns count:', model.modelCatalogColumns?.length);
  console.log('[SERIALIZE_CATALOG] Actual data columns (including FK_ from components):', finalColumns.length);
  console.log('[SERIALIZE_CATALOG] All columns:', finalColumns);
  console.log('[SERIALIZE_CATALOG] FK columns in data:', finalColumns.filter(c => c.toLowerCase().startsWith('fk_')));

  return {
    name: model.name,
    columns: finalColumns,
    rowCount: totalCount,
    rows: paginatedRows.map((row) => ({ values: toPlainObject(row.values) })),
    sourceFileName: model.sourceFileName || '',
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    pagination: {
      currentPage: page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    },
  };
}

function toPlainCatalogValue(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value.toObject === 'function') return value.toObject();
  return { ...value };
}

// Combine a model's static catalog rows with any dynamic component-batch rows
// and compute the full column list. Returns { allRows, finalColumns }.
function combineCatalogRows(model, batches) {
  const allRows = (model.modelCatalogRows || []).map((row) => ({ values: toPlainCatalogValue(row.values) }));
  (batches || []).forEach((batch) => {
    if (Array.isArray(batch.rows)) {
      batch.rows.forEach((row) => {
        allRows.push({ values: toPlainCatalogValue(row) });
      });
    }
  });

  const columnSet = new Set(model.modelCatalogColumns || []);
  allRows.forEach((row) => Object.keys(row.values).forEach((col) => columnSet.add(col)));
  return { allRows, finalColumns: Array.from(columnSet) };
}

// Columns that define the hierarchy: those ending in "component" (case-insensitive),
// preserving the order they appear in the combined column list.
function getTupleColumns(finalColumns) {
  return (finalColumns || []).filter((col) => String(col).toLowerCase().endsWith('component'));
}

function tupleTypeName(col) {
  return String(col).replace(/\s*component\s*$/i, '').trim();
}

// Filter combined rows by a search term across all or a specific column.
function filterCatalogRows(allRows, { search, searchColumn, exact, columns }) {
  const term = String(search || '').trim().toLowerCase();
  if (!term) return allRows;
  const cols = (searchColumn && searchColumn !== '__all__') ? [searchColumn] : columns;
  return allRows.filter((row) => cols.some((col) => {
    const value = String(row.values?.[col] ?? '').toLowerCase().trim();
    return exact ? value === term : value.includes(term);
  }));
}

function serializeModelCatalogWithBatches(model, batches, options = {}) {
  const {
    page = 1,
    limit = 50,
    search = '',
    searchColumn = '__all__',
    exact = false,
  } = options;

  const { allRows, finalColumns } = combineCatalogRows(model, batches);
  const filteredRows = filterCatalogRows(allRows, { search, searchColumn, exact, columns: finalColumns });

  const totalCount = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * limit;
  const paginatedRows = filteredRows.slice(startIndex, startIndex + limit);

  return {
    name: model.name,
    columns: finalColumns,
    rowCount: totalCount,
    unfilteredRowCount: allRows.length,
    rows: paginatedRows.map((row) => ({ values: row.values })),
    sourceFileName: model.sourceFileName || '',
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    pagination: {
      currentPage: safePage,
      limit,
      totalPages,
      hasMore: safePage < totalPages,
      totalCount,
    },
  };
}

// Maximum number of tree nodes to return in a single "full tree" response.
// Beyond this the client falls back to lazy per-level loading.
const MAX_FULL_TREE_NODES = Number(process.env.MAX_FULL_TREE_NODES || 20000);

// Build the complete hierarchy tree from combined rows. Returns null if the
// node count would exceed maxNodes (signal to use lazy mode instead).
function buildFullCatalogTree(allRows, tupleColumns, maxNodes = MAX_FULL_TREE_NODES) {
  const pathToNode = new Map();
  const roots = [];
  let nodeCount = 0;

  for (const row of allRows) {
    const path = [];
    for (let depth = 0; depth < tupleColumns.length; depth++) {
      const raw = row.values?.[tupleColumns[depth]];
      if (raw === null || raw === undefined || String(raw).trim() === '') break;
      const value = String(raw).trim();
      path.push(value);
      const key = path.join('|');

      if (!pathToNode.has(key)) {
        const node = {
          key,
          name: value,
          typeName: tupleTypeName(tupleColumns[depth]),
          depth,
          isLeaf: depth === tupleColumns.length - 1,
          children: [],
        };
        pathToNode.set(key, node);
        nodeCount += 1;
        if (nodeCount > maxNodes) return null;
        if (depth === 0) {
          roots.push(node);
        } else {
          const parent = pathToNode.get(path.slice(0, depth).join('|'));
          if (parent) parent.children.push(node);
        }
      }
    }
  }

  const sortRec = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => {
      n.isLeaf = n.children.length === 0;
      sortRec(n.children);
    });
  };
  sortRec(roots);

  return { roots, nodeCount };
}

// Lazy: return the direct children of a given ancestor path (array of values).
function getCatalogTreeChildren(allRows, tupleColumns, pathValues) {
  const depth = pathValues.length; // children live at this depth
  if (depth >= tupleColumns.length) return [];
  const childCol = tupleColumns[depth];
  const info = new Map(); // value -> hasChildren

  for (const row of allRows) {
    let matchesPrefix = true;
    for (let i = 0; i < depth; i++) {
      if (String(row.values?.[tupleColumns[i]] ?? '').trim() !== pathValues[i]) {
        matchesPrefix = false;
        break;
      }
    }
    if (!matchesPrefix) continue;

    const raw = row.values?.[childCol];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const value = String(raw).trim();
    const hasNext = depth + 1 < tupleColumns.length
      && String(row.values?.[tupleColumns[depth + 1]] ?? '').trim() !== '';
    if (!info.has(value)) info.set(value, hasNext);
    else if (hasNext) info.set(value, true);
  }

  return Array.from(info.entries())
    .map(([value, hasChildren]) => ({
      key: [...pathValues, value].join('|'),
      name: value,
      typeName: tupleTypeName(childCol),
      depth,
      isLeaf: !hasChildren,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Search the tree: return matching full paths (arrays of {name,typeName,depth}).
function searchCatalogTree(allRows, tupleColumns, term, limitPaths = 500) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return [];
  const results = [];
  const seen = new Set();

  for (const row of allRows) {
    const path = [];
    for (let depth = 0; depth < tupleColumns.length; depth++) {
      const raw = row.values?.[tupleColumns[depth]];
      if (raw === null || raw === undefined || String(raw).trim() === '') break;
      path.push({ name: String(raw).trim(), typeName: tupleTypeName(tupleColumns[depth]), depth });
    }
    if (!path.length) continue;
    if (!path.some((node) => node.name.toLowerCase().includes(needle))) continue;
    const key = path.map((node) => node.name).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(path);
    if (results.length >= limitPaths) break;
  }

  return results;
}

router.get('/neighborhoods', async (_req, res) => {
  try {
    await migrateFactoriesToDefaultNeighborhood();
    await ensureNeighborhoodRecordsFromFactories();
    const [neighborhoods, counts, dataCounts] = await Promise.all([
      Model.find({}, { name: 1, owner: 1, createdBy: 1, createdAt: 1, updatedAt: 1, _id: 0 }).sort({ name: 1 }).lean(),
      Component.aggregate([
        { $group: { _id: '$neighborhoodName', componentCount: { $sum: 1 }, updatedAt: { $max: '$updatedAt' } } },
      ]),
      Data.aggregate([
        { $group: { _id: '$neighborhoodName', dataCount: { $sum: 1 }, updatedAt: { $max: '$updatedAt' } } },
      ]),
    ]);
    const countMap = new Map(counts.map((row) => [row._id, row]));
    const dataCountMap = new Map(dataCounts.map((row) => [row._id, row]));
    res.json(neighborhoods.map((neighborhood) => ({
      ...neighborhood,
      factoryCount: (countMap.get(neighborhood.name)?.componentCount || 0) + (dataCountMap.get(neighborhood.name)?.dataCount || 0),
      partCount: countMap.get(neighborhood.name)?.componentCount || 0,
      componentCount: countMap.get(neighborhood.name)?.componentCount || 0,
      dataCount: dataCountMap.get(neighborhood.name)?.dataCount || 0,
      updatedAt: dataCountMap.get(neighborhood.name)?.updatedAt || countMap.get(neighborhood.name)?.updatedAt || neighborhood.updatedAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const neighborhoodName = String(req.query.neighborhoodName || '').trim();
    const loadDomain = String(req.query.loadDomain || '').trim().toLowerCase();

    if (loadDomain === 'data') {
      const dataQuery = (neighborhoodName && neighborhoodName !== '__all__') ? { neighborhoodName } : {};
      const requestedDataType = String(req.query.dataType || '').trim();
      const summaryMode = String(req.query.summary || '').trim().toLowerCase() === 'types';
      const db = mongoose.connection.db;

      if (summaryMode) {
        const summarySources = ['dataBatches', 'dataComponentBatches'];
        const merged = new Map();
        for (const collectionName of summarySources) {
          const docs = await db.collection(collectionName)
            .find({ ...dataQuery, rows: { $ne: [] } }, { projection: { dataType: 1, componentType: 1, name: 1, updatedAt: 1 } })
            .toArray()
            .catch(() => []);

          for (const doc of docs) {
            const resolvedDataType = String(doc?.dataType || '').trim()
              || String(doc?.componentType || '').trim()
              || String(doc?.name || '').trim();
            if (!resolvedDataType) continue;
            const existing = merged.get(resolvedDataType);
            merged.set(resolvedDataType, {
              dataType: resolvedDataType,
              batchCount: (existing?.batchCount || 0) + 1,
              updatedAt: existing?.updatedAt || doc?.updatedAt,
            });
          }
        }

        const summaries = Array.from(merged.values()).sort((left, right) => left.dataType.localeCompare(right.dataType));
        return res.json({ neighborhood: neighborhoodName || null, types: summaries });
      }

      const dataTypeCandidates = getDataTypeSearchCandidates(requestedDataType);
      const dataTypeMatch = dataTypeCandidates.length
        ? {
            $or: dataTypeCandidates.flatMap((candidate) => ([
              { dataType: { $regex: `^${escapeRegExp(candidate)}$`, $options: 'i' } },
              { componentType: { $regex: `^${escapeRegExp(candidate)}$`, $options: 'i' } },
              { name: { $regex: `^${escapeRegExp(candidate)}$`, $options: 'i' } },
            ])),
          }
        : {};
      const typedDataQuery = Object.keys(dataTypeMatch).length
        ? { ...dataQuery, rows: { $ne: [] }, ...dataTypeMatch }
        : { ...dataQuery, rows: { $ne: [] } };

      const batchProjection = {
        neighborhoodName: 1,
        modelName: 1,
        name: 1,
        loadDomain: 1,
        dataType: 1,
        sourceColumnName: 1,
        shortDescription: 1,
        parentFactoryName: 1,
        componentType: 1,
        columns: 1,
        qualifierColumns: 1,
        foreignKeyColumns: 1,
        owner: 1,
        createdBy: 1,
        sourceFileName: 1,
        createdAt: 1,
        updatedAt: 1,
        uploadedAt: 1,
        rows: 1,
      };
      const dataBatchFactories = await db.collection('dataBatches')
        .find(typedDataQuery, { projection: batchProjection })
        .sort({ neighborhoodName: 1, dataType: 1, name: 1, uploadedAt: 1 })
        .toArray()
        .catch(() => []);

      if (dataBatchFactories.length) {
        return res.json(dataBatchFactories.map((factory) => serializeFactory(factory)));
      }

      const dataComponentBatchFactories = await db.collection('dataComponentBatches')
        .find(typedDataQuery, { projection: batchProjection })
        .sort({ neighborhoodName: 1, dataType: 1, name: 1, uploadedAt: 1 })
        .toArray()
        .catch(() => []);

      if (dataComponentBatchFactories.length) {
        return res.json(dataComponentBatchFactories.map((factory) => serializeFactory(factory)));
      }

      const dataFactories = await Data.find({
        ...typedDataQuery,
        $or: [
          { loadDomain: 'data' },
          { modelName: '' },
          { modelName: { $exists: false } },
          { dataType: { $nin: ['', null] } },
          { sourceFileName: { $not: /\bmodel\s+data\.csv$/i } },
        ],
      }, {
        neighborhoodName: 1,
        modelName: 1,
        name: 1,
        dataType: 1,
        sourceColumnName: 1,
        shortDescription: 1,
        parentFactoryName: 1,
        componentType: 1,
        columns: 1,
        qualifierColumns: 1,
        foreignKeyColumns: 1,
        owner: 1,
        createdBy: 1,
        sourceFileName: 1,
        createdAt: 1,
        updatedAt: 1,
        rows: 1,
      })
        .sort({ neighborhoodName: 1, name: 1 })
        .lean();

      return res.json(dataFactories.map((factory) => serializeFactory(factory)));
    }

    const headerModelName = String(req.headers['x-model-name'] || req.headers['X-Model-Name'] || '').trim();
    const query = headerModelName ? { modelName: headerModelName } : (neighborhoodName ? { neighborhoodName } : {});
    const factories = await Component.find(query, { neighborhoodName: 1, modelName: 1, name: 1, owner: 1, createdBy: 1, sourceFileName: 1, columns: 1, createdAt: 1, updatedAt: 1, rows: 1 })
      .sort({ neighborhoodName: 1, name: 1 })
      .lean();
    try {
      console.log('[COMPONENTS] factories query:', query, 'found:', Array.isArray(factories) ? factories.length : typeof factories);
      if (factories && factories.length) {
        console.log('[COMPONENTS] sample factory names:', factories.slice(0,5).map(f => f.name));
      }

      // Inspect dataComponentBatches for the same neighborhood/model to ensure batch rows exist
      const db = mongoose.connection.db;
      const batchQuery = (query.modelName) ? { neighborhoodName: query.modelName } : (query.neighborhoodName ? { neighborhoodName: query.neighborhoodName } : {});
      if (Object.keys(batchQuery).length) {
        const batchesCollection = db.collection('dataComponentBatches');
        const batchCount = await batchesCollection.countDocuments(batchQuery);
        console.log('[COMPONENTS] dataComponentBatches count for', batchQuery, ':', batchCount);
        if (batchCount > 0) {
          const preview = await batchesCollection.find(batchQuery).project({ name: 1, batchId: 1, rows: { $slice: 1 } }).limit(5).toArray();
          console.log('[COMPONENTS] batches preview:', preview.map(b => ({ batchId: b.batchId, name: b.name, rowsSampleKeys: b.rows && b.rows[0] ? Object.keys(b.rows[0]).slice(0,10) : [] })));
        }
      } else {
        console.log('[COMPONENTS] no batchQuery derived from request; skipping batch inspection');
      }
    } catch (e) {
      console.error('[COMPONENTS] Error inspecting batches:', e && e.message);
    }
    // Optional: aggregate dataComponentBatches by name into a columnar view
    const aggregateByName = String(req.query.aggregateByName || '').toLowerCase() === 'true';
    if (aggregateByName) {
      try {
        const db = mongoose.connection.db;
        const batchesCollection = db.collection('dataComponentBatches');
        // Derive batchQuery from request (modelName or neighborhoodName)
        const batchQuery = (query.modelName) ? { neighborhoodName: query.modelName } : (query.neighborhoodName ? { neighborhoodName: query.neighborhoodName } : {});
        const batchDocs = await batchesCollection.find(batchQuery).toArray();
        if (!Array.isArray(batchDocs) || !batchDocs.length) {
          return res.json({ aggregated: true, columns: [], rows: [] });
        }

        const toPlainObject = (value) => {
          if (!value) return {};
          if (value instanceof Map) return Object.fromEntries(value.entries());
          if (typeof value.toObject === 'function') return value.toObject();
          return { ...value };
        };

        // Group batches by componentType so each type becomes a single column
        const primary = PRIMARY_KEY_COLUMN;
        const keySet = new Set();
        const typeMaps = new Map();
        const typeSet = new Set();

        batchDocs.forEach((b) => {
          const type = String(b.componentType || b.name || b.batchId || 'Unknown');
          typeSet.add(type);
          if (!typeMaps.has(type)) typeMaps.set(type, new Map());
          const map = typeMaps.get(type);
          (Array.isArray(b.rows) ? b.rows : []).forEach((r) => {
            const obj = toPlainObject(r.values ? r.values : r);
            const keyVal = String(obj[primary] ?? obj[primary.toLowerCase?.()] ?? '').trim();
            if (!keyVal) return;
            keySet.add(keyVal);
            // accumulate multiple entries per key into an array
            const existing = map.get(keyVal) || [];
            existing.push(obj);
            map.set(keyVal, existing);
          });
        });

        const columns = Array.from(typeSet);
        const rows = Array.from(keySet).sort().map((key) => {
          const values = {};
          for (const type of columns) {
            const map = typeMaps.get(type);
            const arr = map && map.has(key) ? map.get(key) : [];
            // If only one value, return that object; if multiple, return array
            values[type] = arr.length === 1 ? arr[0] : (arr.length ? arr : null);
          }
          return { key, values };
        });

        return res.json({ aggregated: true, columns, rows });
      } catch (e) {
        console.error('[COMPONENTS] aggregation failed:', e && e.message);
        return res.status(500).json({ error: e?.message || 'aggregation failed' });
      }
    }

    // Also include dataComponentBatches documents as factories so Components tab shows data components
    try {
      const db = mongoose.connection.db;
      const batchesCollection = db.collection('dataComponentBatches');
      // Fetch batches for the requested neighborhood/model
      const batchQuery = (query.modelName) ? { neighborhoodName: query.modelName } : (query.neighborhoodName ? { neighborhoodName: query.neighborhoodName } : {});
      const batchDocs = await batchesCollection.find(batchQuery).toArray();
      if (Array.isArray(batchDocs) && batchDocs.length) {
        if (batchDocs && batchDocs.length) {
          const toPlainObject = (value) => {
            if (!value) return {};
            if (value instanceof Map) return Object.fromEntries(value.entries());
            if (typeof value.toObject === 'function') return value.toObject();
            return { ...value };
          };
          // Group batch docs by component `name` to avoid creating one tab per batch
          const grouped = new Map();
          for (const b of batchDocs) {
            const compName = String(b.name || 'Unknown').trim();
            if (!grouped.has(compName)) {
              grouped.set(compName, {
                _id: b._id || b.batchId,
                neighborhoodName: b.neighborhoodName,
                name: compName,
                sourceColumnName: b.sourceColumnName || '',
                parentFactoryName: b.parentFactoryName || '',
                columns: b.columns || [],
                qualifierColumns: b.qualifierColumns || [],
                foreignKeyColumns: b.foreignKeyColumns || [],
                owner: b.owner || '',
                createdBy: b.createdBy || '',
                sourceFileName: b.sourceFileName || '',
                createdAt: b.uploadedAt || b.createdAt,
                updatedAt: b.updatedAt,
                rows: [],
              });
            }
            const group = grouped.get(compName);
            const rows = Array.isArray(b.rows) ? b.rows : [];
            rows.forEach((r, i) => {
              group.rows.push({
                _id: r._id || `${b.batchId || b._id}:${i}`,
                values: r.values ? toPlainObject(r.values) : toPlainObject(r),
                owner: r.owner || '',
                state: r.state || 'staged',
                sourcedFrom: r.sourcedFrom || '',
                createdBy: r.createdBy || b.createdBy || '',
                updatedBy: r.updatedBy || '',
                parentFactoryName: r.parentFactoryName || '',
                parentName: r.parentName || '',
                createdAt: r.createdAt || b.uploadedAt,
                updatedAt: r.updatedAt || b.uploadedAt,
              });
            });
          }

          const converted = Array.from(grouped.values());

          // Merge converted batch factories with DB factories, prefer DB factory metadata and append batch rows
          const byName = new Map(factories.map((f) => [String(f.name), f]));
          for (const conv of converted) {
            const existing = byName.get(conv.name);
            if (existing) {
              // Append rows from batches to existing factory rows
              existing.rows = (existing.rows || []).concat(conv.rows || []);
              // Optionally merge columns/metadata if empty
              existing.columns = existing.columns && existing.columns.length ? existing.columns : conv.columns;
            } else {
              byName.set(conv.name, conv);
            }
          }

          const merged = Array.from(byName.values());
          return res.json(merged.map((factory) => serializeFactory(factory)));
        }
      }
    } catch (e) {
      console.error('[COMPONENTS] Failed to include batch factories:', e && e.message);
    }

    res.json(factories.map((factory) => serializeFactory(factory)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/neighborhoods/:name/catalog', async (req, res) => {
  try {
    await ensureNeighborhoodRecordsFromFactories();
    const name = String(req.params?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Model name is required' });

    // Pagination + server-side search parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit) || 50));
    const search = String(req.query.search || '').trim();
    const searchColumn = String(req.query.searchColumn || '__all__');
    const exact = String(req.query.exact || '').toLowerCase() === 'true';

    const model = await Model.findOne({ name }).lean();
    if (!model) return res.status(404).json({ error: 'Model not found' });

    const db = mongoose.connection.db;
    const batchesCollection = db.collection('dataComponentBatches');
    const batches = await batchesCollection
      .find({ neighborhoodName: name })
      .project({ rows: 1, name: 1, batchId: 1 })
      .toArray();

    res.json(serializeModelCatalogWithBatches(model, batches, { page, limit, search, searchColumn, exact }));
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

// Helper: load a model + its combined rows and tuple columns for tree operations.
async function loadCatalogForTree(name) {
  const model = await Model.findOne({ name }).lean();
  if (!model) return null;
  const db = mongoose.connection.db;
  const batches = await db.collection('dataComponentBatches')
    .find({ neighborhoodName: name })
    .project({ rows: 1, name: 1, batchId: 1 })
    .toArray();
  const { allRows, finalColumns } = combineCatalogRows(model, batches);
  return { model, allRows, tupleColumns: getTupleColumns(finalColumns) };
}

// Full hierarchy tree (with node-count guard). Falls back to lazy mode when too large.
router.get('/neighborhoods/:name/catalog/tree', async (req, res) => {
  try {
    const name = String(req.params?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Model name is required' });
    const requestedMode = String(req.query.mode || '').trim().toLowerCase();

    const data = await loadCatalogForTree(name);
    if (!data) return res.status(404).json({ error: 'Model not found' });
    const { allRows, tupleColumns } = data;

    if (!tupleColumns.length) {
      return res.json({ mode: 'full', tupleColumns: [], nodeCount: 0, roots: [] });
    }

    if (requestedMode === 'lazy') {
      const roots = getCatalogTreeChildren(allRows, tupleColumns, []);
      return res.json({ mode: 'lazy', tupleColumns, nodeCount: roots.length, roots });
    }

    const built = buildFullCatalogTree(allRows, tupleColumns);
    if (built === null) {
      // Too large for a single payload — return roots only for lazy loading.
      const roots = getCatalogTreeChildren(allRows, tupleColumns, []);
      return res.json({ mode: 'lazy', tupleColumns, roots });
    }

    res.json({ mode: 'full', tupleColumns, nodeCount: built.nodeCount, roots: built.roots });
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

// Lazy: direct children of an ancestor path (pipe-delimited values in ?path=).
router.get('/neighborhoods/:name/catalog/tree/children', async (req, res) => {
  try {
    const name = String(req.params?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Model name is required' });

    const data = await loadCatalogForTree(name);
    if (!data) return res.status(404).json({ error: 'Model not found' });
    const { allRows, tupleColumns } = data;

    const rawPath = String(req.query.path || '');
    const pathValues = rawPath ? rawPath.split('|').map((v) => v.trim()).filter((v) => v.length) : [];
    const children = getCatalogTreeChildren(allRows, tupleColumns, pathValues);
    res.json({ path: pathValues, children });
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

// Search the tree: returns matching full paths regardless of tree mode.
router.get('/neighborhoods/:name/catalog/tree/search', async (req, res) => {
  try {
    const name = String(req.params?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Model name is required' });

    const term = String(req.query.term || '').trim();
    const limitPaths = Math.max(1, Math.min(5000, parseInt(req.query.limit) || 500));

    const data = await loadCatalogForTree(name);
    if (!data) return res.status(404).json({ error: 'Model not found' });
    const { allRows, tupleColumns } = data;

    const paths = searchCatalogTree(allRows, tupleColumns, term, limitPaths);
    res.json({ term, tupleColumns, paths, truncated: paths.length >= limitPaths });
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

router.post('/neighborhoods', requireAdminWrite, upload.single('file'), async (req, res) => {
  const name = String(req.body?.name || req.body?.neighborhoodName || '').trim();
  if (!name) return res.status(400).json({ error: 'Model name is required' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'Model CSV file is required' });
  let neighborhood = null;
  try {
    await ensureNeighborhoodRecordsFromFactories();
    const existing = await Model.exists({ name });
    if (existing) return res.status(409).json({ error: 'Model already exists' });

    const owner = getCurrentUserLabel(req);
    const createdBy = getCurrentUserId(req);
    const { columns, rows } = parseModelCatalogWorkbook(req.file.buffer, req.file.originalname);
    console.log('[MODEL CREATE] Parsed workbook:', { columnsCount: columns.length, rowsCount: rows.length });
    console.log('[MODEL CREATE] ALL COLUMNS FROM SPREADSHEET:', columns);
    if (rows.length > 0) {
      console.log('[MODEL CREATE] First row sample:', Object.entries(rows[0]).slice(0, 5));
    }
    
    // Step 1: Identify the tupleType (columns ending in "Component")
    const tupleType = identifyTupleType(columns);
    if (!tupleType.length) {
      throw createValidationError('Model must contain at least one column ending in "Component"');
    }
    
    // Step 2: Build the model catalog hash from rows
    const modelCatalogHashMap = buildModelCatalogHash(rows, tupleType);
    if (!modelCatalogHashMap.size) {
      throw createValidationError('Model catalog has no valid tuple values');
    }

    // Deduplicate rows before storing — use column-sorted JSON key so identical
    // rows with the same data are collapsed regardless of property insertion order.
    const seenRowKeys = new Set();
    const uniqueRows = rows.filter((row) => {
      const key = JSON.stringify(Object.fromEntries(columns.map((col) => [col, row[col] ?? ''])));
      if (seenRowKeys.has(key)) return false;
      seenRowKeys.add(key);
      return true;
    });
    console.log(`[MODEL CREATE] Dedup: ${rows.length} input rows → ${uniqueRows.length} unique rows`);
    
    // Convert Map to plain object for Mongoose
    const modelCatalogHash = Object.fromEntries(modelCatalogHashMap.entries());
    
    const schemaFactories = deriveNeighborhoodSchema(columns);

    neighborhood = await Model.create({
      name,
      owner,
      createdBy,
      sourceFileName: req.file.originalname,
      modelCatalogColumns: columns,
      modelCatalogRows: uniqueRows.map((row) => ({ values: row })),
      tupleType, // Store the tuple type columns
      modelCatalogHash, // Store the hash for validation
      schemaFactories: schemaFactories.map((factory) => ({
        name: factory.name,
        sourceColumnName: factory.sourceColumnName,
        parentFactoryName: factory.parentFactoryName,
        qualifierColumns: factory.qualifiers.map((qualifier) => ({
          name: qualifier.name,
          sourceColumnName: qualifier.sourceColumnName,
          fieldName: qualifier.fieldName,
        })),
        foreignKeyColumns: (factory.foreignKeyColumns || []).map((foreignKey) => ({
          name: foreignKey.name,
          sourceColumnName: foreignKey.sourceColumnName,
          fieldName: foreignKey.fieldName,
          targetReference: foreignKey.targetReference,
          targetGroup: foreignKey.targetGroup,
          targetScope: foreignKey.targetScope,
          targetColumnName: foreignKey.targetColumnName,
        })),
        level: factory.level,
      })),
    });

    console.log('[MODEL CREATE] Model created:', { _id: neighborhood._id, name: neighborhood.name, catalogRowsCount: (neighborhood.modelCatalogRows || []).length, catalogColumnsCount: (neighborhood.modelCatalogColumns || []).length });
    if ((neighborhood.modelCatalogRows || []).length > 0) {
      const firstRow = neighborhood.modelCatalogRows[0];
      console.log('[MODEL CREATE] First row stored:', { hasValues: !!firstRow.values, valuesType: typeof firstRow.values, valuesSample: firstRow.values ? Object.keys(firstRow.values).slice(0, 5) : null });
    }

    res.status(201).json({
      name: neighborhood.name,
      owner: neighborhood.owner,
      createdBy: neighborhood.createdBy,
      factoryCount: 0,
      partCount: 0,
      componentCount: 0,
      createdAt: neighborhood.createdAt,
      updatedAt: neighborhood.updatedAt,
    });
  } catch (err) {
    if (neighborhood?._id) {
      await Promise.all([
        Model.deleteOne({ _id: neighborhood._id }).catch(() => null),
        Component.deleteMany({ neighborhoodName: name }).catch(() => null),
        ComponentSearchIndex.deleteMany({ neighborhoodName: name }).catch(() => null),
      ]);
    }
    if (err?.code === 11000) return res.status(409).json({ error: 'Model already exists' });
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

router.delete('/neighborhoods/:name', requireAdminWrite, async (req, res) => {
  const name = String(req.params?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Model name is required' });

  try {
    const neighborhood = await Model.findOne({ name }, { _id: 1, name: 1 }).lean();
    if (!neighborhood) return res.status(404).json({ error: 'Model not found' });

    const db = mongoose.connection.db;
    const [deletedFactories, deletedNeighborhood, deletedIndex, deletedBatches, deletedCanonical] = await Promise.all([
      Component.deleteMany({ neighborhoodName: name }),
      Model.deleteOne({ _id: neighborhood._id }),
      ComponentSearchIndex.deleteMany({ neighborhoodName: name }),
      db.collection('dataComponentBatches').deleteMany({ neighborhoodName: name }),
      db.collection('canonicalcomponents').deleteMany({ neighborhoodName: name }),
    ]);

    if ((deletedNeighborhood.deletedCount || 0) !== 1) {
      throw createValidationError(`Failed to delete model ${name}`, 500);
    }

    const remainingFactoryCount = await Component.countDocuments({ neighborhoodName: name });
    const remainingBatchCount = await db.collection('dataComponentBatches').countDocuments({ neighborhoodName: name });
    const remainingCanonicalCount = await db.collection('canonicalcomponents').countDocuments({ neighborhoodName: name });

    if (remainingFactoryCount > 0 || remainingBatchCount > 0 || remainingCanonicalCount > 0) {
      throw createValidationError(`Model ${name} still has component data after delete: components=${remainingFactoryCount}, batches=${remainingBatchCount}, canonical=${remainingCanonicalCount}`, 500);
    }

    res.json({
      success: true,
      name,
      deletedNeighborhoodCount: deletedNeighborhood.deletedCount || 0,
      deletedFactoryCount: deletedFactories.deletedCount || 0,
      deletedBatchCount: deletedBatches.deletedCount || 0,
      deletedCanonicalCount: deletedCanonical.deletedCount || 0,
      deletedPartCount: deletedFactories.deletedCount || 0,
      deletedComponentCount: deletedFactories.deletedCount || 0,
    });
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

// DELETE all components and related artifacts for a neighborhood (data + canonical + search index)
router.delete('/neighborhoods/:name/components', requireAdminWrite, async (req, res) => {
  const name = String(req.params?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Model name is required' });
  try {
    const db = mongoose.connection.db;
    const componentDocs = await Component.find({ neighborhoodName: name }, { name: 1, componentType: 1, dataType: 1, sourceColumnName: 1 }).lean();
    const deleteTokens = [...new Set(componentDocs.flatMap((doc) => [doc?.name, doc?.componentType, doc?.dataType, doc?.sourceColumnName]).map((value) => String(value || '').trim()).filter(Boolean))];
    const diagramFilter = deleteTokens.length ? {
      neighborhoodName: name,
      $or: deleteTokens.flatMap((token) => {
        const exact = new RegExp(`^${escapeRegExp(token)}$`, 'i');
        return [
          { businessCapability: exact },
          { valueStream: exact },
          { journey: exact },
          { domain: exact },
          { subdomain: exact },
          { businessFlow: exact },
          { name: exact },
        ];
      }),
    } : { neighborhoodName: name };
    const [deletedFactories, deletedBatches, deletedCanonical, deletedIndex] = await Promise.all([
      Component.deleteMany({ neighborhoodName: name }),
      db.collection('dataComponentBatches').deleteMany({ neighborhoodName: name }),
      db.collection('canonicalcomponents').deleteMany({ neighborhoodName: name }),
      ComponentSearchIndex.deleteMany({ neighborhoodName: name }),
    ]);

    const deletedDiagrams = await Diagram.deleteMany(diagramFilter);

    return res.json({
      success: true,
      neighborhoodName: name,
      deletedFactoryCount: deletedFactories.deletedCount || 0,
      deletedBatchCount: deletedBatches.deletedCount || 0,
      deletedCanonicalCount: deletedCanonical.deletedCount || 0,
      deletedIndexCount: deletedIndex.deletedCount || 0,
      deletedDiagramCount: deletedDiagrams.deletedCount || 0,
    });
  } catch (err) {
    console.error('[DELETE ALL COMPONENTS] error', err && err.message);
    return res.status(500).json({ error: getValidationMessage(err) });
  }
});

// DELETE /api/custom-factories/data/:dataType — delete a single Data type (e.g. Data[Applications])
// without affecting other Data types (e.g. Data[Servers]).
router.get('/data/:dataType/distributions', async (req, res) => {
  const rawType = String(req.params?.dataType || '').trim();
  if (!rawType) return res.status(400).json({ error: 'Data type is required' });
  const neighborhoodName = String(req.query?.neighborhoodName || '').trim();
  try {
    const db = mongoose.connection.db;
    const filter = { dataType: rawType };
    if (neighborhoodName) filter.neighborhoodName = neighborhoodName;
    const doc = await db.collection('dataTypeDistributions').findOne(filter);
    if (!doc) return res.json({ distributions: [], recordCount: 0, computedAt: null });
    return res.json({
      distributions: doc.distributions || [],
      recordCount: doc.recordCount || 0,
      computedAt: doc.computedAt || null,
      aggregateColumns: doc.aggregateColumns || [],
      locationSummary: doc.locationSummary || null,
    });
  } catch (err) {
    console.error('[DISTRIBUTIONS] GET error:', err && err.message);
    return res.status(500).json({ error: 'Failed to load distributions' });
  }
});

router.delete('/data/:dataType', requireAdminWrite, async (req, res) => {
  const rawType = String(req.params?.dataType || '').trim();
  if (!rawType) return res.status(400).json({ error: 'Data type is required' });

  const neighborhoodName = String(req.query?.neighborhoodName || '').trim();
  try {
    const db = mongoose.connection.db;
    const scope = (neighborhoodName && neighborhoodName !== '__all__') ? { neighborhoodName } : {};
    const typeCandidates = getDataTypeSearchCandidates(rawType);
    const typeTerms = typeCandidates.length ? typeCandidates : [rawType];
    const makeExactRegex = (value) => new RegExp(`^${escapeRegExp(value)}$`, 'i');

    const typeMatch = {
      $or: typeTerms.flatMap((candidate) => {
        const typeRegex = makeExactRegex(candidate);
        return ([
          { dataType: typeRegex },
          { componentType: typeRegex },
          { name: typeRegex },
        ]);
      }),
    };
    const batchFilter = { ...scope, ...typeMatch };
    const dataFilter = { ...scope, ...typeMatch };
    const canonicalFilter = { ...scope, $or: typeTerms.map((candidate) => ({ componentType: makeExactRegex(candidate) })) };
    const indexFilter = { ...scope, $or: typeTerms.flatMap((candidate) => {
      const typeRegex = makeExactRegex(candidate);
      return ([{ componentName: typeRegex }, { dataType: typeRegex }]);
    }) };
    const distTypeMatch = { $or: typeTerms.map((t) => ({ dataType: new RegExp(`^${escapeRegExp(t)}$`, 'i') })) };
    const [deletedBatches, , deletedData, deletedCanonicalData, deletedDataIndex] = await Promise.all([
      db.collection('dataBatches').deleteMany(batchFilter).catch(() => ({ deletedCount: 0 })),
      db.collection('dataTypeDistributions').deleteMany({ ...scope, ...distTypeMatch }).catch(() => null),
      Data.deleteMany(dataFilter).catch(() => ({ deletedCount: 0 })),
      CanonicalData.deleteMany(canonicalFilter).catch(() => ({ deletedCount: 0 })),
      DataSearchIndex.deleteMany(indexFilter).catch(() => ({ deletedCount: 0 })),
    ]);

    if (neighborhoodName && neighborhoodName !== '__all__') {
      await rebuildSearchIndex(neighborhoodName, {
        CanonicalModel: CanonicalData,
        SearchIndexModel: DataSearchIndex,
        indexLabel: 'DataSearchIndex',
      }).catch((err) => {
        console.error('[DELETE DATA TYPE] search index rebuild failed', err && err.message);
      });
    }

    return res.json({
      success: true,
      dataType: rawType,
      neighborhoodName: neighborhoodName || null,
      deletedBatchCount: deletedBatches.deletedCount || 0,
      deletedDataCount: deletedData.deletedCount || 0,
      deletedCanonicalDataCount: deletedCanonicalData.deletedCount || 0,
      deletedDataIndexCount: deletedDataIndex.deletedCount || 0,
    });
  } catch (err) {
    console.error('[DELETE DATA TYPE] error', err && err.message);
    return res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

router.post('/upload', requireAdminWrite, handleSpreadsheetUpload, async (req, res) => {
  const requestedNeighborhoodName = String(req.body?.neighborhoodName || '').trim();
  const componentName = String(req.body?.componentName || '').trim();
  const dataType = getRequestedLoadTypeName(req.body?.dataType || req.body?.loadType || componentName);
  const loadDomainRaw = String(req.body?.loadDomain || req.body?.collectionType || '').trim().toLowerCase();
  const loadDomain = loadDomainRaw === 'data' ? 'data' : 'component';
  const batchCollectionName = loadDomain === 'data' ? 'dataBatches' : 'dataComponentBatches';
  const neighborhoodName = loadDomain === 'data' ? DATA_NEIGHBORHOOD_NAME : requestedNeighborhoodName;
  if (!neighborhoodName) return res.status(400).json({ error: 'Model name is required' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'Spreadsheet file is required' });
  if (loadDomain === 'data' && !dataType) return res.status(400).json({ error: 'Data type is required' });

  try {
    const neighborhood = loadDomain === 'data' ? null : await Model.findOne({ name: neighborhoodName }).lean();
    if (loadDomain !== 'data') {
      if (!neighborhood) return res.status(404).json({ error: 'Model not found' });

      if (!Array.isArray(neighborhood.modelCatalogColumns) || !neighborhood.modelCatalogColumns.length || !Array.isArray(neighborhood.modelCatalogRows) || !neighborhood.modelCatalogRows.length) {
        return res.status(409).json({ error: 'Model catalog is missing. Delete and reload the model before loading components.' });
      }

      // Ensure modelCatalogRows have properly structured values
      // When using .lean() with Map fields, Mongoose may not convert them properly
      const normalizedModelRows = (neighborhood.modelCatalogRows || []).map((row) => {
        if (!row.values) {
          console.log('[UPLOAD DEBUG] Row has no values field, attempting to extract from row itself');
          return { values: row };
        }
        // Ensure values is a plain object
        if (row.values instanceof Map) {
          return { values: Object.fromEntries(row.values.entries()) };
        }
        if (typeof row.values === 'object' && row.values !== null) {
          return { values: { ...row.values } };
        }
        return row;
      });
      neighborhood.modelCatalogRows = normalizedModelRows;
    }

    // Parse uploaded file with enhanced error handling
    let uploadColumns, uploadRows;
    try {
      const parsed = parseModelCatalogWorkbook(req.file.buffer, req.file.originalname);
      uploadColumns = parsed.columns;
      uploadRows = parsed.rows;
      console.log('[UPLOAD] File parsed successfully:', { columnCount: uploadColumns.length, rowCount: uploadRows.length });
    } catch (parseErr) {
      console.error('[UPLOAD] File parsing failed:', {
        message: parseErr?.message,
        code: parseErr?.code,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        bufferLength: req.file.buffer?.length,
      });
      throw parseErr;
    }
    
    // NOTE: Data components are completely independent from models
    // No tuple type identification, validation, or model hash needed
    // Proceed directly to processing component columns

    // Deduplicate raw rows before processing — use column-sorted JSON key so identical
    // rows are collapsed regardless of property insertion order.
    const seenComponentRowKeys = new Set();
    const uniqueUploadRows = uploadRows.filter((row) => {
      const key = JSON.stringify(Object.fromEntries(uploadColumns.map((col) => [col, row[col] ?? ''])));
      if (seenComponentRowKeys.has(key)) return false;
      seenComponentRowKeys.add(key);
      return true;
    });
    if (uniqueUploadRows.length !== uploadRows.length) {
      console.log(`[UPLOAD] Dedup: ${uploadRows.length} input rows → ${uniqueUploadRows.length} unique rows`);
    }
    uploadRows = uniqueUploadRows;
    
    const owner = req.currentUser?.displayName || req.currentUser?.userId || '';
    const createdBy = req.currentUser?.userId || '';

    // Split large uploads into batches to avoid BSON serialization limits
    const BATCH_SIZE = 100;
    const rowBatches = [];
    for (let i = 0; i < uploadRows.length; i += BATCH_SIZE) {
      rowBatches.push(uploadRows.slice(i, i + BATCH_SIZE));
    }
    console.log(`[UPLOAD] Split ${uploadRows.length} rows into ${rowBatches.length} batches of ~${BATCH_SIZE} rows`);

    let uploadedFactories = [];

    if (loadDomain === 'data') {
      // Data uploads are flat — no "Component" column hierarchy is required.
      // Store each batch directly as a factory document keyed by the user's dataType.
      const factoryName = dataType;
      for (let batchIdx = 0; batchIdx < rowBatches.length; batchIdx++) {
        const batchRows = rowBatches[batchIdx];
        console.log(`[UPLOAD] Processing data batch ${batchIdx + 1}/${rowBatches.length} with ${batchRows.length} rows`);
        const rowDocs = batchRows.map((row) => ({
          values: { ...row },
          owner,
          state: 'staged',
          sourcedFrom: req.file.originalname,
          createdBy,
          updatedBy: createdBy,
        }));
        uploadedFactories.push({
          neighborhoodName,
          name: factoryName,
          sourceColumnName: factoryName,
          parentFactoryName: '',
          componentType: factoryName,
          qualifierColumns: [],
          foreignKeyColumns: [],
          columns: uploadColumns,
          owner,
          createdBy,
          sourceFileName: req.file.originalname,
          rows: rowDocs,
        });
      }
    } else {
      // Component uploads require "... Component" hierarchy columns.
      const { componentColumns } = splitUploadColumns(uploadColumns);
      const requestedTypeName = componentName;
      const filteredComponentColumns = requestedTypeName
        ? componentColumns.filter((col) => columnMatchesRequestedLoadType(col.name, requestedTypeName))
        : componentColumns;

      const allUploadedFactories = [];
      for (let batchIdx = 0; batchIdx < rowBatches.length; batchIdx++) {
        const batchRows = rowBatches[batchIdx];
        console.log(`[UPLOAD] Processing batch ${batchIdx + 1}/${rowBatches.length} with ${batchRows.length} rows`);
        const batchFactories = await buildComponentUploadFactories({
          neighborhoodName,
          rows: batchRows,
          componentColumns: filteredComponentColumns,
          sourceFileName: req.file.originalname,
          owner,
          createdBy,
          rowNumberOffset: batchIdx * BATCH_SIZE,
        });
        allUploadedFactories.push(...batchFactories);
      }
      uploadedFactories = allUploadedFactories;
    }

    // NOTE: Data components are completely independent from the model
    // No classification, validation, or state checks needed
    // Just process the uploaded factories directly

    // NOTE: Data components are independent from models
    // Each batch is stored as a separate factory - no merging
    
    const rollbackSnapshots = [];
    const rollbackModelSchemaFactories = loadDomain === 'data'
      ? []
      : (Array.isArray(neighborhood?.schemaFactories)
        ? JSON.parse(JSON.stringify(neighborhood.schemaFactories))
        : []);
    const createdFactoryIds = [];
    const savedFactories = [];

    try {
      for (const uploadedFactory of uploadedFactories) {
        // Data components are stored in a dedicated collection for batches
        // Each batch is a separate document to avoid 16MB limit and unique index conflicts
        uploadedFactory.modelName = loadDomain === 'data' ? '' : neighborhoodName;
        uploadedFactory.neighborhoodName = neighborhoodName;
        uploadedFactory.loadDomain = loadDomain;
        uploadedFactory.dataType = loadDomain === 'data' ? dataType : '';
        // Preserve the uploaded header-derived name as the componentType (no alias mapping)
        uploadedFactory.componentType = uploadedFactory.name;
        
        // Get the MongoDB collection directly - use dedicated batch collection
        const db = mongoose.connection.db;
        const collection = db.collection(batchCollectionName);
        
        // Add unique batch ID and timestamps
        const batchId = Date.now() + Math.random().toString(36).substr(2, 9);
        uploadedFactory.batchId = batchId;
        uploadedFactory.uploadedAt = new Date();
        
        console.log(`[UPLOAD] Creating ${loadDomain} batch ${batchId} for ${uploadedFactory.componentType}/${uploadedFactory.name} with ${uploadedFactory.rows?.length || 0} rows`);
        const insertResult = await collection.insertOne(uploadedFactory);
        createdFactoryIds.push({ collection: batchCollectionName, id: insertResult.insertedId });
        
        // Register FK columns in the registry
        (uploadedFactory.foreignKeyColumns || []).forEach((fk) => {
          fkRegistry.registerForeignKey(fk, {
            neighborhoodName,
            modelName: loadDomain === 'data' ? '' : neighborhoodName,
            componentName: uploadedFactory.name,
          });
        });
        
        // Add to saved factories
        const savedFactory = { ...uploadedFactory, _id: insertResult.insertedId };
        if (loadDomain === 'data') {
          savedFactories.push({
            _id: String(insertResult.insertedId),
            neighborhoodName,
            name: uploadedFactory.name,
            sourceColumnName: uploadedFactory.sourceColumnName || '',
            parentFactoryName: uploadedFactory.parentFactoryName || '',
            componentType: uploadedFactory.componentType || '',
            dataType: uploadedFactory.dataType || '',
            loadDomain,
            rowCount: Array.isArray(uploadedFactory.rows) ? uploadedFactory.rows.length : 0,
          });
        } else {
          savedFactories.push(serializeFactory(savedFactory));
        }
      }

      // Component upload complete
      console.log(`[${loadDomain.toUpperCase()}] Upload complete - created`, createdFactoryIds.length, 'factories');

      // Persist column-level value distributions so the client can fetch them instantly
      // without re-scanning all batch rows every page load.
      if (loadDomain === 'data' && uploadedFactories.length > 0) {
        try {
          const SUMMARY_COLUMNS = [
            'APP_BUS_CRTCLTY Qualifier',
            'APP_BUS_UNIT Qualifier',
            'APP_DPTMT Qualifier',
            'APP_INSL_TYPE Qualifier',
            'APP_LIFECYCLE Qualifier',
            'APP_LIFECYCLE_STS Qualifier',
            'APP_BUS_PRPS Qualifier',
            'SVR_CPU_MNFCTR Qualifier',
            'SVR_CPU_NM Qualifier',
            'SVR_CPU_TYPE Qualifier',
            'SVR_DSCVRY_SRC Qualifier',
            'SVR_OS Qualifier',
          ];
          const SVR_LOC_COLUMN = 'SVR_LOC Qualifier';
          const aggregateColumns = Array.from(new Set(uploadColumns
            .map((column) => String(column || '').trim())
            .filter((column) => /aggregate$/i.test(column))));
          const STREET_TOKENS = new Set([
            'ST', 'STREET', 'AVE', 'AV', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE', 'BLVD', 'BOULEVARD',
            'PKWY', 'PARKWAY', 'HWY', 'HIGHWAY', 'LN', 'LANE', 'CT', 'COURT', 'PL', 'PLACE', 'TER',
            'TERRACE', 'CIR', 'CIRCLE', 'WAY', 'TRL', 'TRAIL', 'CTR', 'CENTER', 'SQ', 'SQUARE',
            'LOOP', 'EXPY', 'EXPRESSWAY', 'FWY', 'FREEWAY', 'RTE', 'ROUTE', 'PARK', 'MALL', 'PLZ', 'PLAZA',
          ]);
          const US_STATE_ABBREVS = new Set([
            'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
            'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
            'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
            'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
          ]);
          const extractStateCode = (value) => {
            const normalized = String(value || '').trim().toUpperCase().replace(/\s*-\s*DUPLICATE\s*$/i, '').trim();
            if (!normalized) return '';
            if (US_STATE_ABBREVS.has(normalized)) return normalized;
            const commaState = normalized.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?(?:\s+.*)?$/);
            if (commaState && US_STATE_ABBREVS.has(commaState[1])) return commaState[1];
            const prefixState = normalized.match(/^([A-Z]{2})[-_.\s]/);
            if (prefixState && US_STATE_ABBREVS.has(prefixState[1])) return prefixState[1];
            return '';
          };
          const extractCityName = (value) => {
            const normalized = String(value || '').trim().toUpperCase().replace(/\s*-\s*DUPLICATE\s*$/i, '').trim();
            if (!normalized) return '';

            const base = normalized.split(',')[0].trim();
            const tokens = base.split(/\s+/).filter(Boolean);
            if (!tokens.length) return '';

            let cityStartIndex = -1;
            for (let index = tokens.length - 1; index >= 0; index -= 1) {
              if (STREET_TOKENS.has(tokens[index].replace(/[^A-Z]/g, ''))) {
                cityStartIndex = index + 1;
                break;
              }
            }

            let city = cityStartIndex >= 0 ? tokens.slice(cityStartIndex).join(' ') : tokens.slice(-Math.min(3, tokens.length)).join(' ');
            city = city.replace(/\b(REGION|ZONE|CAMPUS|SITE|CENTER|CENTRE|HUB|DATA CENTER|DATACENTER)\b$/i, '').trim();
            return city;
          };

          const summaryColumns = new Set([...SUMMARY_COLUMNS, ...aggregateColumns, SVR_LOC_COLUMN]);
          const freqMaps = new Map(Array.from(summaryColumns, (column) => [column, new Map()]));
          const cityMap = new Map();
          let distRecordCount = 0;
          for (const factory of uploadedFactories) {
            for (const row of (factory.rows || [])) {
              distRecordCount++;
              const vals = (row.values && typeof row.values === 'object') ? row.values : row;

              for (const col of SUMMARY_COLUMNS) {
                const rawVal = vals?.[col];
                const val = rawVal == null ? '' : String(rawVal).trim();
                if (!val) continue;
                const freq = freqMaps.get(col);
                freq.set(val, (freq.get(val) || 0) + 1);
              }

              for (const col of aggregateColumns) {
                const rawVal = vals?.[col];
                const val = rawVal == null ? '' : String(rawVal).trim();
                if (!val) continue;
                const freq = freqMaps.get(col);
                freq.set(val, (freq.get(val) || 0) + 1);
              }

              const locState = extractStateCode(vals?.[SVR_LOC_COLUMN]);
              if (locState) {
                const freq = freqMaps.get(SVR_LOC_COLUMN);
                freq.set(locState, (freq.get(locState) || 0) + 1);
              }

              const locCity = extractCityName(vals?.[SVR_LOC_COLUMN]);
              if (locCity) {
                cityMap.set(locCity, (cityMap.get(locCity) || 0) + 1);
              }
            }
          }
          const distributions = Array.from(freqMaps.entries()).map(([column, freq]) => ({
            column,
            valueCounts: Array.from(freq.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([value, count]) => ({ value, count })),
          }));
          const locationSummary = {
            stateCounts: Array.from((freqMaps.get(SVR_LOC_COLUMN) || new Map()).entries())
              .sort((a, b) => b[1] - a[1])
              .map(([state, count]) => ({ state, count })),
            cityCounts: Array.from(cityMap.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([city, count]) => ({ city, count })),
          };
          const distDb = mongoose.connection.db;
          await distDb.collection('dataTypeDistributions').replaceOne(
            { neighborhoodName, dataType },
            { neighborhoodName, dataType, computedAt: new Date(), recordCount: distRecordCount, aggregateColumns, distributions, locationSummary },
            { upsert: true }
          );
          console.log(`[DISTRIBUTIONS] Stored ${distributions.length} column distributions for ${dataType} (${distRecordCount} records)`);
        } catch (distErr) {
          console.error('[DISTRIBUTIONS] Failed to store distributions:', distErr && distErr.message);
          // Non-critical — do not fail the upload
        }
      }

      // Trigger materializer in background to populate canonical components from newly created batches
      try {
        // Run materializer synchronously so canonical components are available
        try {
          const batchIds = createdFactoryIds.map((entry) => entry.id);
          console.log('[TRACE] Starting materializeFromBatches...', { neighborhoodName, domain: loadDomain, batchCount: createdFactoryIds.length, batchIds: batchIds.length });
          const matStart = Date.now();
          const matRes = await materializeFromBatches({ neighborhoodName, domain: loadDomain, batchIds });
          console.log('[TRACE] materializeFromBatches done in', Date.now() - matStart, 'ms — processed:', matRes.processed);
        } catch (err) {
          console.error('[MATERIALIZER] error', err);
          // do not fail the upload; surface a warning
        }
      } catch (err) {
        console.error('[MATERIALIZER] trigger failed', err);
      }
      console.log('[TRACE] Materializer block complete, moving to search index rebuild...');
    } catch (writeError) {
      // Rollback: delete created documents from dynamic collections
      if (createdFactoryIds.length) {
        const db = mongoose.connection.db;
        for (const entry of createdFactoryIds) {
          try {
            const collection = db.collection(entry.collection);
            await collection.deleteOne({ _id: entry.id });
            console.log(`[ROLLBACK] Deleted ${entry.collection}/${entry.id}`);
          } catch (e) {
            console.error(`[ROLLBACK] Failed to delete ${entry.collection}/${entry.id}:`, e.message);
          }
        }
      }

      await Promise.all(rollbackSnapshots.map((snapshot) =>
        Component.replaceOne({ _id: snapshot._id }, snapshot, { overwriteDiscriminatorKey: true }).catch(() => null)
      ));

      rollbackModelSchemaFactories.forEach((factory) => {
        const matchingUploadedFactory = uploadedFactories.find((candidate) => getComparableValue(candidate.name) === getComparableValue(factory.name));
        if (!matchingUploadedFactory) return;

        factory.parentFactoryName = matchingUploadedFactory.parentFactoryName || factory.parentFactoryName || '';
        factory.qualifierColumns = mergeColumnMetadata(factory.qualifierColumns || [], matchingUploadedFactory.qualifierColumns || []);
        factory.foreignKeyColumns = mergeColumnMetadata(factory.foreignKeyColumns || [], matchingUploadedFactory.foreignKeyColumns || []);
      });

      if (loadDomain !== 'data') {
        await Model.updateOne(
          { name: neighborhoodName },
          { $set: { schemaFactories: rollbackModelSchemaFactories } }
        ).catch(() => null);
      }

      throw writeError;
    }

    // Rebuild search index after component upload (async, non-blocking)
    // Fire-and-forget: don't await, don't block response
    const rebuildOptions = loadDomain === 'data'
      ? { CanonicalModel: CanonicalData, SearchIndexModel: DataSearchIndex, indexLabel: 'DataSearchIndex' }
      : undefined;
    console.log('[TRACE] Firing rebuildSearchIndex (non-blocking)...');
    rebuildSearchIndex(neighborhoodName, rebuildOptions).catch((err) => {
      console.error(`[INDEX] Failed to rebuild search index after upload: ${err.message}`);
      // Don't fail the upload if index rebuild fails - it can be rebuilt manually
    });

    console.log('[TRACE] Sending 201 response to client...');
    res.status(201).json({
      factories: savedFactories,
      parts: savedFactories,
      components: savedFactories,
      count: savedFactories.length,
      loadDomain,
    });
  } catch (err) {
    console.error('[UPLOAD ERROR] Full error:', {
      message: err?.message,
      code: err?.code,
      stack: err?.stack?.substring(0, 500),
      type: err?.constructor?.name,
    });
    const errorMessage = String(getValidationMessage(err) || 'Upload failed');
    res.status(err?.status || 500).json({
      error: errorMessage.slice(0, 1000),
      code: err?.code ? String(err.code).slice(0, 100) : undefined,
    });
  }
});

router.put('/:factoryId/rows/:rowId', requireAdminWrite, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.factoryId)) return res.status(404).json({ error: 'Component not found' });
    const factory = await Component.findById(req.params.factoryId);
    if (!factory) return res.status(404).json({ error: 'Component not found' });
    const row = factory.rows.id(req.params.rowId);
    if (!row) return res.status(404).json({ error: 'Factory row not found' });

    const nextValues = req.body?.values && typeof req.body.values === 'object' ? req.body.values : {};
    const candidateRows = factory.rows.map((factoryRow) => {
      const values = Object.fromEntries(factory.columns.map((column) => [column, factoryRow.values.get(column) ?? '']));
      if (String(factoryRow._id) === String(row._id)) {
        for (const column of factory.columns) {
          values[column] = nextValues[column] ?? '';
        }
      }
      return values;
    });

    validateComponentRows(candidateRows, factory.columns);

    for (const column of factory.columns) {
      row.values.set(column, nextValues[column] ?? '');
    }
    row.owner = String(req.body?.owner || row.owner || '').trim();
    row.state = String(req.body?.state || row.state || 'staged').trim() || 'staged';
    row.updatedBy = getCurrentUserId(req);

    await factory.save();
    res.json(serializeFactory(factory.toObject()));
  } catch (err) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

router.delete('/:factoryId/rows/:rowId', requireAdminWrite, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.factoryId)) return res.status(404).json({ error: 'Component not found' });
    const factory = await Component.findById(req.params.factoryId);
    if (!factory) return res.status(404).json({ error: 'Component not found' });
    const row = factory.rows.id(req.params.rowId);
    if (!row) return res.status(404).json({ error: 'Component row not found' });
    row.deleteOne();
    await factory.save();
    res.json(serializeFactory(factory.toObject()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:factoryId', requireAdminWrite, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.factoryId)) return res.status(404).json({ error: 'Component not found' });
    const factory = await Component.findById(req.params.factoryId).lean();
    if (!factory) return res.status(404).json({ error: 'Component not found' });

    const neighborhoodName = String(factory.neighborhoodName || '').trim();
    const componentType = String(factory.name || '').trim();

    await Promise.all([
      Component.deleteOne({ _id: factory._id }),
      neighborhoodName && componentType
        ? CanonicalComponent.deleteMany({
            neighborhoodName,
            componentType: { $regex: `^${componentType.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, $options: 'i' },
          })
        : Promise.resolve({ deletedCount: 0 }),
    ]);

    await Model.updateOne(
      { name: factory.neighborhoodName },
      {
        $pull: {
          schemaFactories: {
            $or: [
              { name: factory.name },
              ...(factory.sourceColumnName ? [{ sourceColumnName: factory.sourceColumnName }] : []),
            ],
          },
        },
      }
    );

    if (neighborhoodName) {
      await rebuildSearchIndex(neighborhoodName).catch((err) => {
        console.error('[DELETE FACTORY] search index rebuild failed after delete', err && err.message);
        throw err;
      });
    }

    res.json({ success: true, factoryId: String(factory._id), partId: String(factory._id), componentId: String(factory._id), neighborhoodName: factory.neighborhoodName, name: factory.name });
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

// Rebuild search index for a neighborhood (admin endpoint)
router.post('/search/index/rebuild', async (req, res) => {
  try {
    const neighborhoodName = String(req.query?.neighborhoodName || DEFAULT_NEIGHBORHOOD_NAME).trim();
    
    const result = await rebuildSearchIndex(neighborhoodName);
    res.json({ success: true, message: `Search index rebuilt for ${neighborhoodName}`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Type-ahead search endpoint
router.get('/search/typeahead', async (req, res) => {
  try {
    const neighborhoodName = String(req.query?.neighborhoodName || DEFAULT_NEIGHBORHOOD_NAME).trim();
    const prefix = String(req.query?.prefix || '').trim().toLowerCase();
    const componentName = req.query?.componentName ? String(req.query.componentName).trim() : null;
    const indexModeRaw = String(req.query?.indexMode || req.query?.index || 'component').trim().toLowerCase();
    const indexMode = indexModeRaw === 'data' ? 'data' : 'component';
    const SearchIndexModel = indexMode === 'data' ? DataSearchIndex : ComponentSearchIndex;
    const applicationLikeRegex = /application/i;
    const limit = Math.min(parseInt(req.query?.limit) || 10, 100);
    
    if (!prefix || prefix.length < 1) {
      return res.json({ suggestions: [] });
    }
    
    // Build query for row suggestions
    const query = {
      neighborhoodName,
      searchableTextLower: { $regex: `^${prefix}`, $options: 'i' }
    };
    
    if (componentName) {
      query.componentName = componentName;
    }
    if (indexMode === 'data') {
      const scopeClauses = [];
      if (componentName) {
        scopeClauses.push({ componentName: componentName });
      }
      scopeClauses.push({ componentName: { $regex: applicationLikeRegex } });
      scopeClauses.push({ dataType: { $regex: applicationLikeRegex } });
      query.$or = scopeClauses;
    }
    
    // Find unique suggestions, grouped by value and sorted by frequency
    const suggestions = await SearchIndexModel.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$rowName',
          frequency: { $sum: '$frequency' },
          componentNames: { $addToSet: '$componentName' },
          count: { $sum: 1 }
        }
      },
      { $sort: { frequency: -1, count: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          value: '$_id',
          frequency: 1,
          componentNames: 1,
          count: 1
        }
      }
    ]);

    // Also return matching component types (componentName) so the UI can suggest types
    const typeQuery = {
      neighborhoodName,
      componentName: { $regex: `^${prefix}`, $options: 'i' }
    };
    if (indexMode === 'data') {
      typeQuery.$or = [
        { componentName: { $regex: applicationLikeRegex } },
        { dataType: { $regex: applicationLikeRegex } },
      ];
    }
    const componentTypesAgg = await SearchIndexModel.aggregate([
      { $match: typeQuery },
      { $group: { _id: '$componentName', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
      { $project: { _id: 0, componentName: '$_id', count: 1 } }
    ]);

    res.json({ suggestions, componentTypes: componentTypesAgg, prefix, neighborhoodName, indexMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search using the index (fast search)
router.get('/search/indexed', async (req, res) => {
  try {
    const neighborhoodName = String(req.query?.neighborhoodName || DEFAULT_NEIGHBORHOOD_NAME).trim();
    const rawSearchTerm = String(req.query?.term || '').trim();
    const componentName = req.query?.componentName ? String(req.query.componentName).trim() : null;

    console.log(`[INDEX SEARCH TRACE] Request: neighborhood="${neighborhoodName}", rawTerm="${rawSearchTerm}", componentName="${componentName}"`);

    if (!rawSearchTerm && !componentName) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }

    const exactPrefix = '__exact__:';
    const isExactSearch = rawSearchTerm.startsWith(exactPrefix);
    const searchTerm = isExactSearch ? rawSearchTerm.slice(exactPrefix.length) : rawSearchTerm;
    const normalizeSearchValue = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
    
    // Escape regex special characters
    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    let indexResults = [];
    let searchPattern = '';

    if (isExactSearch) {
      const normalizedSearchTerm = normalizeSearchValue(searchTerm);
      const searchRegex = escapeRegExp(searchTerm);
      // Use word boundaries only for simple word-only terms; otherwise use the raw regex
      const isWordOnly = /^\w+$/.test(searchTerm);
      searchPattern = isWordOnly ? `\\b${searchRegex}\\b` : searchRegex;
      console.log(`[INDEX SEARCH] Exact search for: "${searchTerm}" normalized="${normalizedSearchTerm}" in ${neighborhoodName}`);

      console.log('[INDEX SEARCH TRACE] Executing Mongo find for exact search, pattern=', searchPattern);
      const candidateResults = await ComponentSearchIndex.find({
        neighborhoodName,
        searchableTextLower: { $regex: searchPattern, $options: 'i' }
      }).lean();

      indexResults = candidateResults.filter((doc) => normalizeSearchValue(doc.rowName) === normalizedSearchTerm);
      console.log('[INDEX SEARCH TRACE] Candidate results count (exact):', candidateResults.length, 'filtered->', indexResults.length);
    } else {
      // Use word boundaries for simple word-only searches, otherwise match the raw substring
      const searchRegex = escapeRegExp(searchTerm);
      const isWordOnly = /^\w+$/.test(searchTerm);
      searchPattern = isWordOnly ? `\\b${searchRegex}\\b` : searchRegex;
      console.log(`[INDEX SEARCH] Searching for: "${searchTerm}" with pattern: "${searchPattern}" in ${neighborhoodName}`);

      const findQuery = { neighborhoodName };
      findQuery.searchableTextLower = { $regex: searchPattern, $options: 'i' };
      if (componentName) findQuery.componentName = componentName;

      console.log('[INDEX SEARCH TRACE] Executing Mongo find with query:', JSON.stringify(findQuery));
      indexResults = await ComponentSearchIndex.find(findQuery).lean();
      console.log('[INDEX SEARCH TRACE] Candidate results count:', indexResults.length);
    }
    
    console.log(`[INDEX SEARCH] Found ${indexResults.length} matching rows`);
    
    // Expand cachedHierarchies or cachedLineagePaths: create one result per hierarchy path
    const results = [];
    
    for (const indexDoc of indexResults) {
      // Use new structured hierarchies if available, otherwise fall back to string paths
      let hierarchiesData;
      
      if (indexDoc.cachedHierarchies && indexDoc.cachedHierarchies.length > 0) {
        // New format: array of structured hierarchies
        hierarchiesData = indexDoc.cachedHierarchies.map(h => ({
          nodes: h,
          pathStr: h.map(node => node.rowName).join(' > ')
        }));
      } else {
        // Fallback for old format: parse string paths
        const paths = indexDoc.cachedLineagePaths || [indexDoc.rowName];
        hierarchiesData = paths.map(pathStr => ({
          nodes: pathStr.split(' > ').map((partName, level) => ({
            componentName: level === pathStr.split(' > ').length - 1 ? indexDoc.componentName : 'Unknown',
            componentId: level === pathStr.split(' > ').length - 1 ? indexDoc.componentId : null,
            rowName: partName,
            rowId: level === pathStr.split(' > ').length - 1 ? indexDoc.rowId : null
          })),
          pathStr
        }));
      }
      
      for (const hierarchyData of hierarchiesData) {
        const hierarchy = hierarchyData.nodes.map((node, level) => ({
          componentName: node.componentName,
          rowName: node.rowName,
          componentId: String(node.componentId || ''),
          rowId: String(node.rowId || ''),
          level,
          values: level === hierarchyData.nodes.length - 1 ? indexDoc.fieldByValue : {}
        }));
        
        results.push({
          searchMatchComponentId: String(indexDoc.componentId),
          searchMatchComponentName: indexDoc.componentName,
          searchMatchRowId: String(indexDoc.rowId),
          searchMatchRowName: indexDoc.rowName,
          searchMatchFieldName: 'indexed',
          searchMatchFieldValue: indexDoc.rowName,
          hierarchy,
          hierarchyPath: hierarchyData.pathStr,
          state: 'indexed',
          owner: '',
          createdBy: '',
          updatedBy: '',
          createdAt: indexDoc.updatedAt,
          updatedAt: indexDoc.updatedAt,
        });
      }
    }
    
    console.log(`[INDEX SEARCH] Expanded to ${results.length} results from ${indexResults.length} index entries`);
    
    res.json({
      results,
      totalMatches: results.length,
      searchTerm,
      exact: isExactSearch,
      neighborhoodName,
      source: 'index'
    });
  } catch (err) {
    console.error('[INDEX SEARCH] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Global component search - searches all components in a neighborhood and returns hierarchy paths
// Builds complete lineage paths from search matches up to root
router.get('/search/global', async (req, res) => {
  try {
    const neighborhoodName = String(req.query?.neighborhoodName || '').trim();
    const searchTerm = String(req.query?.term || '').trim();
    
    if (!neighborhoodName) {
      return res.status(400).json({ error: 'neighborhoodName is required' });
    }
    
    if (!searchTerm || searchTerm.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters' });
    }

    // Get all components in the neighborhood
    const components = await Component.find({ neighborhoodName })
      .sort({ name: 1 })
      .lean();

    if (!components.length) {
      return res.json({ results: [], totalMatches: 0 });
    }

    // Create maps for quick lookup
    const componentMap = new Map(components.map(c => [getComparableValue(c.name), c]));
    
    // Search term regex (case-insensitive, word boundaries for whole-word match)
    const searchRegex = new RegExp(`\\b${escapeRegExp(searchTerm)}\\b`, 'i');
    console.log(`[SEARCH DEBUG] Searching for: "${searchTerm}" with regex: ${searchRegex}`);
    console.log(`[SEARCH DEBUG] Found ${components.length} components to search`);
    
    let totalRowsChecked = 0;
    const results = [];
    
    // Search through all components
    components.forEach(component => {
      const rows = component.rows || [];
      totalRowsChecked += rows.length;
      console.log(`[SEARCH DEBUG] Component "${component.name}" has ${rows.length} rows`);
      
      rows.forEach((row, rowIndex) => {
        const rowValues = getModelCatalogRowValues(row);
        
        // Search through ALL field values in the row
        let matchFound = false;
        let matchedFieldName = '';
        let matchedFieldValue = '';
        
        for (const [fieldName, fieldValue] of Object.entries(rowValues)) {
          const fieldValueStr = getNormalizedText(fieldValue);
          if (searchRegex.test(fieldValueStr)) {
            matchFound = true;
            matchedFieldName = fieldName;
            matchedFieldValue = fieldValueStr;
            console.log(`[SEARCH DEBUG] MATCH in "${component.name}": Field="${fieldName}", Value="${matchedFieldValue}"`);
            break;
          }
        }
        
        if (!matchFound) {
          return;
        }
        
        // Handle parentName that might contain multiple values separated by |
        const parentNames = row.parentName 
          ? row.parentName.split('|').map(p => p.trim()).filter(p => p)
          : [];
        
        if (parentNames.length === 0) {
          // No parents - just create a single result for this row
          const rowName = getNormalizedText(rowValues[PRIMARY_KEY_COLUMN] || '');
          const hierarchyPath = [{
            componentName: component.name,
            rowName: rowName,
            componentId: String(component._id),
            rowId: String(row._id),
            level: 0,
            values: rowValues,
          }];
          
          results.push({
            searchMatchComponentId: String(component._id),
            searchMatchComponentName: component.name,
            searchMatchRowId: String(row._id),
            searchMatchRowName: rowName,
            searchMatchFieldName: matchedFieldName,
            searchMatchFieldValue: matchedFieldValue,
            hierarchy: hierarchyPath,
            hierarchyPath: hierarchyPath.map(h => h.rowName).join(' > '),
            state: row.state || 'staged',
            owner: row.owner || '',
            createdBy: row.createdBy || '',
            updatedBy: row.updatedBy || '',
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        } else {
          // Multiple parents - create a result for EACH parent
          // Use simple walk-up approach: for each parent, walk to root following first parent at each level
          parentNames.forEach(parentName => {
            const parentComponent = componentMap.get(getComparableValue(component.parentFactoryName || ''));
            if (!parentComponent) return; // No parent component
            
            const parentRow = parentComponent.rows?.find(r => {
              const pRowValues = getModelCatalogRowValues(r);
              return getComparableValue(pRowValues[PRIMARY_KEY_COLUMN] || '') === getComparableValue(parentName);
            });
            
            if (!parentRow) return; // Parent row not found
            
            // Build hierarchy by walking up from this parent
            const hierarchyPath = [];
            let currentComponent = parentComponent;
            let currentRow = parentRow;
            let level = 0;
            
            // Keep walking up until we run out of parents or hit a loop
            const visitedKeys = new Set();
            
            while (currentComponent && currentRow && level < 20) {
              const currentRowValues = getModelCatalogRowValues(currentRow);
              const currentRowName = getNormalizedText(currentRowValues[PRIMARY_KEY_COLUMN] || '');
              
              // Prevent infinite loops
              const key = `${currentComponent.name}:${currentRowName}`;
              if (visitedKeys.has(key)) break;
              visitedKeys.add(key);
              
              hierarchyPath.unshift({
                componentName: currentComponent.name,
                rowName: currentRowName,
                componentId: String(currentComponent._id),
                rowId: String(currentRow._id),
                level: 0, // We'll adjust levels after building
                values: currentRowValues,
              });
              
              // Get first parent (if multiple, take only the first one)
              const parentNames = currentRow.parentName
                ? currentRow.parentName.split('|').map(p => p.trim()).filter(p => p)
                : [];
              
              if (parentNames.length === 0) break; // No more parents
              
              const nextParentComponent = componentMap.get(getComparableValue(currentComponent.parentFactoryName || ''));
              if (!nextParentComponent) break;
              
              const nextParentRow = nextParentComponent.rows?.find(r => {
                const pRowValues = getModelCatalogRowValues(r);
                return getComparableValue(pRowValues[PRIMARY_KEY_COLUMN] || '') === getComparableValue(parentNames[0]); // Take FIRST parent only
              });
              
              if (!nextParentRow) break;
              
              currentComponent = nextParentComponent;
              currentRow = nextParentRow;
              level++;
            }
            
            // Adjust levels
            hierarchyPath.forEach((node, idx) => {
              node.level = idx;
            });
            
            // Add the matched row at the end
            const rowName = getNormalizedText(rowValues[PRIMARY_KEY_COLUMN] || '');
            hierarchyPath.push({
              componentName: component.name,
              rowName: rowName,
              componentId: String(component._id),
              rowId: String(row._id),
              level: hierarchyPath.length,
              values: rowValues,
            });
            
            results.push({
              searchMatchComponentId: String(component._id),
              searchMatchComponentName: component.name,
              searchMatchRowId: String(row._id),
              searchMatchRowName: rowName,
              searchMatchFieldName: matchedFieldName,
              searchMatchFieldValue: matchedFieldValue,
              hierarchy: hierarchyPath,
              hierarchyPath: hierarchyPath.map(h => h.rowName).join(' > '),
              state: row.state || 'staged',
              owner: row.owner || '',
              createdBy: row.createdBy || '',
              updatedBy: row.updatedBy || '',
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
          });
        }
      });
    });
    
    // Deduplicate results by hierarchyPath (same path = same result)
    const uniqueResults = new Map();
    results.forEach(result => {
      const key = result.hierarchyPath;
      if (!uniqueResults.has(key)) {
        uniqueResults.set(key, result);
      }
    });
    
    const deduplicatedResults = Array.from(uniqueResults.values());
    
    console.log(`[SEARCH DEBUG] Total rows checked: ${totalRowsChecked}`);
    console.log(`[SEARCH DEBUG] Total results before dedup: ${results.length}`);
    console.log(`[SEARCH DEBUG] Total results after dedup: ${deduplicatedResults.length}`);
    
    res.json({
      results: deduplicatedResults.sort((a, b) => a.hierarchyPath.localeCompare(b.hierarchyPath)),
      totalMatches: deduplicatedResults.length,
      searchTerm,
      neighborhoodName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/validation-errors-report', requireAdminWrite, async (req, res) => {
  try {
    const { neighborhoodName, errorRows = [], matchedModelColumns = [] } = req.body;
    
    if (!neighborhoodName) return res.status(400).json({ error: 'Model name is required' });
    if (!Array.isArray(errorRows) || !errorRows.length) {
      return res.status(400).json({ error: 'Error rows data is required' });
    }

    // Build spreadsheet data
    const headers = ['Row Number', 'Match Score'];
    const columnNames = matchedModelColumns.map((col) => col.sourceColumnName || col);
    
    headers.push(...columnNames.map((col) => `${col} (Uploaded)`));
    headers.push(...columnNames.map((col) => `${col} (Model)`));

    const rows = errorRows.map((error) => {
      const row = [error.rowNumber, error.matchScore];
      columnNames.forEach((col) => {
        row.push(error.uploadedValues?.[col] || '');
      });
      columnNames.forEach((col) => {
        row.push(error.closestModelMatch?.[col] || '');
      });
      return row;
    });

    // Create workbook
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Failed Rows');

    // Set column widths
    const colWidths = headers.map(() => 20);
    worksheet['!cols'] = colWidths;

    // Return Excel file
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="validation-errors-${neighborhoodName}-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    res.status(err?.status || 500).json({ error: getValidationMessage(err) });
  }
});

// GET /api/custom-factories/leaf-component — Get the leaf component name for a neighborhood
router.get('/leaf-component', async (req, res) => {
  try {
    const neighborhoodName = String(req.query?.neighborhoodName || DEFAULT_NEIGHBORHOOD_NAME).trim();
    
    // Get all components for this neighborhood
    const components = await Component.find({ neighborhoodName }).select('name parentFactoryName').lean();
    
    if (!components.length) {
      return res.json({ leafComponent: 'Application' }); // fallback
    }
    
    // Find the leaf component = the one that is NO ONE's parent
    // (i.e., no other component has this as its parentFactoryName)
    const componentNames = new Set(components.map(c => c.name));
    const parentReferences = new Set(
      components
        .filter(c => c.parentFactoryName && componentNames.has(c.parentFactoryName))
        .map(c => c.parentFactoryName)
    );
    
    // Leaf components are those NOT referenced as parents by anyone
    const leafComponents = components.filter(c => !parentReferences.has(c.name));
    const leafComponent = leafComponents.length > 0 ? leafComponents[0].name : 'Application';
    
    res.json({ leafComponent });
  } catch (error) {
    console.error('[LEAF] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/custom-factories/hierarchies/tree — Get component hierarchies from ComponentSearchIndex
router.get('/hierarchies/tree', async (req, res) => {
  try {
    const neighborhoodName = String(req.query?.neighborhoodName || DEFAULT_NEIGHBORHOOD_NAME).trim();
    const componentName = String(req.query?.componentName || 'Application').trim();
    const compact = String(req.query?.compact || '').trim().toLowerCase() === 'true';

    const entries = await ComponentSearchIndex.find(compact
      ? { neighborhoodName }
      : {
          neighborhoodName,
          componentName: { $regex: new RegExp(`^${escapeRegExp(componentName)}$`, 'i') },
        })
    .sort({ rowName: 1 })
    .lean();
    
    // Extract unique hierarchies that contain the requested component
    const hierarchyMap = new Map();
    const allPaths = [];
    
    entries.forEach((entry) => {
      const hierarchies = entry.cachedHierarchies || [];

      const selectedHierarchies = compact
        ? Array.from(new Map(hierarchies.map((hierarchy) => {
            const parentNode = hierarchy.length > 1 ? hierarchy[hierarchy.length - 2] : null;
            const currentNode = hierarchy[hierarchy.length - 1] || null;
            const relationshipKey = parentNode
              ? `${parentNode.componentName}:${parentNode.rowId || parentNode.rowName}->${currentNode?.componentName}:${currentNode?.rowId || currentNode?.rowName}`
              : `root:${currentNode?.componentName}:${currentNode?.rowId || currentNode?.rowName}`;
            return [relationshipKey, hierarchy];
          })).values())
        : hierarchies;
      selectedHierarchies.forEach((hierarchy) => {
        const containsComponent = hierarchy.some(
          (node) => compact || String(node.componentName || '').trim().toLowerCase() === componentName.toLowerCase()
        );
        
        if (!containsComponent) return;
        
        const pathKey = hierarchy.map(node => node.rowName).join('|');
        
        if (!hierarchyMap.has(pathKey)) {
          hierarchyMap.set(pathKey, hierarchy);
          allPaths.push({
            pathKey,
            nodes: hierarchy,
            pathStr: hierarchy.map(node => node.rowName).join(' > '),
            fieldValues: entry.fieldByValue || {},
            rowId: entry.rowId,
            componentId: entry.componentId,
          });
        }
      });
    });
    
    res.json({
      totalPaths: allPaths.length,
      uniqueCount: hierarchyMap.size,
      paths: allPaths,
    });
  } catch (error) {
    console.error('[HIERARCHIES] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Foreign Key Resolution Endpoints
// ============================================================================

// GET /fk-registry: View all registered FK mappings (admin/debug)
router.get('/fk-registry/status', async (_req, res) => {
  try {
    const stats = fkRegistry.getStats();
    res.json({
      success: true,
      registry: stats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fk-resolve: Resolve a single FK value to its target record
// Body: { targetGroup, targetScope, targetIdField, fkValue }
router.post('/fk-resolve', async (req, res) => {
  try {
    const { targetGroup, targetScope, targetIdField, fkValue } = req.body || {};

    if (!targetGroup || !targetScope || !targetIdField || !fkValue) {
      return res.status(400).json({
        error: 'Required fields: targetGroup, targetScope, targetIdField, fkValue',
      });
    }

    const fkMetadata = {
      targetGroup,
      targetScope,
      targetIdField,
    };

    const resolved = await fkResolver.resolveForeignKey(fkMetadata, fkValue);

    if (!resolved) {
      return res.status(404).json({
        error: `FK value "${fkValue}" not found in ${targetGroup}/${targetScope}`,
        fkValue,
        target: { targetGroup, targetScope, targetIdField },
      });
    }

    res.json({
      success: true,
      fkValue,
      target: { targetGroup, targetScope, targetIdField },
      resolved,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /fk-validate: Validate that FK values exist (batch validation)
// Body: { validations: [{ targetGroup, targetScope, targetIdField, fkValue }, ...] }
router.post('/fk-validate', async (req, res) => {
  try {
    const { validations } = req.body || {};

    if (!Array.isArray(validations) || !validations.length) {
      return res.status(400).json({
        error: 'Required: validations array with FK metadata objects',
      });
    }

    const results = await Promise.all(
      validations.map(async (validation) => {
        const { targetGroup, targetScope, targetIdField, fkValue } = validation;
        
        const fkMetadata = {
          targetGroup,
          targetScope,
          targetIdField,
        };

        const exists = await fkResolver.validateForeignKeyExists(fkMetadata, fkValue, {
          throwOnMissing: false,
        });

        return {
          fkValue,
          target: { targetGroup, targetScope, targetIdField },
          exists,
        };
      })
    );

    const allValid = results.every(r => r.exists);
    const invalidResults = results.filter(r => !r.exists);

    res.json({
      success: allValid,
      allValid,
      validatedCount: results.length,
      invalidCount: invalidResults.length,
      results,
      invalidResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /components/:componentId/fk-enriched: Get component with resolved FK data
router.get('/components/:componentId/fk-enriched', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.componentId)) return res.status(404).json({ error: 'Component not found' });
    const component = await Component.findById(req.params.componentId).lean();
    if (!component) return res.status(404).json({ error: 'Component not found' });

    const enriched = await fkResolver.enrichComponentWithResolvedForeignKeys(component);
    res.json({
      success: true,
      component: serializeFactory(enriched),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /components/:componentId/fk-references: Get all components referenced by FK columns
router.get('/components/:componentId/fk-references', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.componentId)) return res.status(404).json({ error: 'Component not found' });
    const component = await Component.findById(req.params.componentId);
    if (!component) return res.status(404).json({ error: 'Component not found' });

    const referencedComponents = await fkResolver.getReferencedComponents(component);

    res.json({
      success: true,
      componentName: component.name,
      referencedComponentsCount: referencedComponents.length,
      referencedComponents: referencedComponents.map((ref) => ({
        fieldName: ref.fieldName,
        targetGroup: ref.targetGroup,
        targetScope: ref.targetScope,
        targetComponentId: String(ref.targetComponent._id),
        targetComponentName: ref.targetComponent.name,
        targetComponentRowCount: (ref.targetComponent.rows || []).length,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /components/:componentId/fk-validate: Validate all FK values in a component
router.post('/components/:componentId/fk-validate', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.componentId)) return res.status(404).json({ error: 'Component not found' });
    const component = await Component.findById(req.params.componentId);
    if (!component) return res.status(404).json({ error: 'Component not found' });

    const validation = await fkResolver.validateComponentForeignKeys(component);

    const statusCode = validation.valid ? 200 : 400;
    res.status(statusCode).json({
      success: validation.valid,
      componentName: component.name,
      valid: validation.valid,
      errorCount: validation.errors.length,
      errors: validation.errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fk-registry/targets: List all registered FK targets
router.get('/fk-registry/targets', async (_req, res) => {
  try {
    const targets = fkRegistry.getAllTargets();
    res.json({
      success: true,
      targetCount: targets.length,
      targets,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /fk-registry/targets/:targetGroup/:targetScope/sources: Get components that reference a target
router.get('/fk-registry/targets/:targetGroup/:targetScope/sources', async (req, res) => {
  try {
    const { targetGroup, targetScope } = req.params;
    const sources = fkRegistry.getSourceComponentsForTarget(targetGroup, targetScope);

    if (!sources || sources.length === 0) {
      return res.status(404).json({
        error: `No components reference target ${targetGroup}/${targetScope}`,
      });
    }

    res.json({
      success: true,
      targetGroup,
      targetScope,
      sourceComponentCount: sources.length,
      sourceComponents: sources,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic component fetch by ID - must be last to not shadow specific routes
router.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();

    // If the client is requesting a synthetic canonical-backed id like "<neighborhood>:<componentType>
    // resolve it directly from canonicalcomponents to avoid ObjectId cast errors and return
    // a legacy-shaped factory.
    if (id.includes(':')) {
      const idParts = id.split(':');
      const possibleMatches = [];
      for (let splitIndex = 1; splitIndex < idParts.length; splitIndex += 1) {
        possibleMatches.push({
          neighborhoodName: idParts.slice(0, splitIndex).join(':'),
          componentType: idParts.slice(splitIndex).join(':'),
        });
      }
      try {
        let docs = [];
        let neighborhoodFromId = '';
        let componentTypeFromId = '';
        for (const match of possibleMatches) {
          docs = await CanonicalComponent.find({ neighborhoodName: match.neighborhoodName, componentType: match.componentType }).sort({ primaryKey: 1 }).limit(1000).lean();
          if (Array.isArray(docs) && docs.length) {
            neighborhoodFromId = match.neighborhoodName;
            componentTypeFromId = match.componentType;
            break;
          }
        }
        if (Array.isArray(docs) && docs.length) {
          // Derive column list from canonical values
          const columnsSet = new Set();
          docs.forEach((d) => {
            if (d.values && typeof d.values === 'object') Object.keys(d.values).forEach((k) => columnsSet.add(k));
          });
          const db = mongoose.connection.db;
          const batchDocs = await db.collection('dataComponentBatches')
            .find({
              neighborhoodName: neighborhoodFromId,
              $or: [
                { componentType: { $regex: `^${escapeRegExp(componentTypeFromId)}$`, $options: 'i' } },
                { name: { $regex: `^${escapeRegExp(componentTypeFromId)}$`, $options: 'i' } },
              ],
            })
            .project({ foreignKeyColumns: 1 })
            .toArray();
          const fkByField = new Map();
          batchDocs.forEach((doc) => {
            (doc.foreignKeyColumns || []).forEach((fk) => {
              const key = String(fk.fieldName || fk.sourceColumnName || fk.name || '').trim().toLowerCase();
              if (!key || fkByField.has(key)) return;
              fkByField.set(key, fk);
            });
          });
          const converted = {
            _id: id,
            neighborhoodName: neighborhoodFromId,
            name: componentTypeFromId,
            sourceColumnName: componentTypeFromId,
            parentFactoryName: '',
            columns: Array.from(columnsSet),
            qualifierColumns: [],
            foreignKeyColumns: Array.from(fkByField.values()),
            owner: '',
            createdBy: '',
            sourceFileName: '',
            createdAt: null,
            updatedAt: null,
            rows: docs.map((d) => ({ _id: String(d._id), values: d.values || {}, owner: '', state: 'staged', sourcedFrom: 'canonical', createdBy: '', updatedBy: '', parentFactoryName: '', parentName: '', createdAt: d.createdAt, updatedAt: d.updatedAt })),
            rowCount: docs.length,
          };
          return res.json(serializeFactory(converted));
        }
      } catch (err) {
        console.error('[COMPONENT GET] Error resolving canonical fallback for', id, err && err.message);
        // fallthrough to regular resolution
      }
    }

    let factory = null;
    // Only call findById when id is a valid ObjectId to avoid Cast errors
    if (mongoose.Types.ObjectId.isValid(id)) {
      factory = await Component.findById(id).lean();
    } else {
      // Non-ObjectId synthetic ids such as "Domain:SubDomain_Name" must not be queried
      // against _id, because Mongoose will still attempt to cast and throw.
      factory = await Component.findOne({ name: id }).lean();
    }
    if (!factory) {
      // Try to resolve from dataComponentBatches if not found in Component collection
      try {
        const db = mongoose.connection.db;
        const batches = db.collection('dataComponentBatches');
        let batch = null;
        const { ObjectId } = require('mongodb');
        // Try ObjectId lookup
        try {
          batch = await batches.findOne({ _id: new ObjectId(id) });
        } catch (e) {
          // ignore invalid ObjectId errors
        }
        // Try batchId or string _id match
        if (!batch) batch = await batches.findOne({ batchId: id }) || await batches.findOne({ _id: id });
        if (batch) {
          const toPlainObject = (value) => {
            if (!value) return {};
            if (value instanceof Map) return Object.fromEntries(value.entries());
            if (typeof value.toObject === 'function') return value.toObject();
            return { ...value };
          };

          const converted = {
            _id: batch._id || batch.batchId,
            neighborhoodName: batch.neighborhoodName,
            name: batch.name,
            sourceColumnName: batch.sourceColumnName || '',
            parentFactoryName: batch.parentFactoryName || '',
            columns: batch.columns || [],
            qualifierColumns: batch.qualifierColumns || [],
            foreignKeyColumns: batch.foreignKeyColumns || [],
            owner: batch.owner || '',
            createdBy: batch.createdBy || '',
            sourceFileName: batch.sourceFileName || '',
            createdAt: batch.uploadedAt || batch.createdAt,
            updatedAt: batch.updatedAt,
            rows: (Array.isArray(batch.rows) ? batch.rows : []).map((r, i) => ({
              _id: r._id || `${batch.batchId || batch._id}:${i}`,
              values: r.values ? toPlainObject(r.values) : toPlainObject(r),
              owner: r.owner || '',
              state: r.state || 'staged',
              sourcedFrom: r.sourcedFrom || '',
              createdBy: r.createdBy || batch.createdBy || '',
              updatedBy: r.updatedBy || '',
              parentFactoryName: r.parentFactoryName || '',
              parentName: r.parentName || '',
              createdAt: r.createdAt || batch.uploadedAt,
              updatedAt: r.updatedAt || batch.uploadedAt,
            }))
          };
          return res.json(serializeFactory(converted));
        }
      } catch (e) {
        console.error('[COMPONENT GET] Error resolving batch fallback:', e && e.message);
      }

      return res.status(404).json({ error: 'Component not found' });
    }

    res.json(serializeFactory(factory));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: dump dataComponentBatches summary for a neighborhood/model
router.get('/batches/debug/:neighborhood', async (req, res) => {
  try {
    const name = String(req.params?.neighborhood || req.query?.neighborhoodName || req.query?.modelName || '').trim();
    if (!name) return res.status(400).json({ error: 'Neighborhood/model name required' });
    const db = mongoose.connection.db;
    const batchesColl = db.collection('dataComponentBatches');
    const total = await batchesColl.countDocuments({ neighborhoodName: name });
    const distinctNames = await batchesColl.distinct('name', { neighborhoodName: name });
    const sample = await batchesColl.find({ neighborhoodName: name }).project({ batchId: 1, name: 1, rows: { $slice: 3 } }).limit(50).toArray();

    // Collect distinct primary key values across sampled rows (best-effort)
    const PRIMARY = PRIMARY_KEY_COLUMN || 'name';
    const pkSet = new Set();
    const rowKeySamples = [];
    sample.forEach((b) => {
      (Array.isArray(b.rows) ? b.rows : []).forEach((r) => {
        const vals = r.values ? (typeof r.values === 'object' ? r.values : {}) : (typeof r === 'object' ? r : {});
        const keyVal = String(vals[PRIMARY] ?? vals[PRIMARY.toLowerCase?.()] ?? '').trim();
        if (keyVal) pkSet.add(keyVal);
        rowKeySamples.push(Object.keys(vals).slice(0, 10));
      });
    });

    res.json({ neighborhood: name, totalBatches: total, distinctBatchNames: distinctNames.length, batchNames: distinctNames.slice(0, 50), sampleCount: sample.length, sampleRowsKeySamples: rowKeySamples.slice(0, 20), distinctPrimaryKeysInSample: Array.from(pkSet).slice(0, 200) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adapter: Serve legacy-shaped factories/pages from canonicalcomponents
// GET /api/custom-factories/canonical-paged?neighborhoodName=...                        -> list component types and counts
// GET /api/custom-factories/canonical-paged?neighborhoodName=...&componentType=Name&page=1&limit=50 -> factory with paged rows
router.get('/canonical-paged', async (req, res) => {
  try {
    const neighborhood = String(req.query.neighborhoodName || req.headers['x-model-name'] || req.query.modelName || '').trim();
    if (!neighborhood) return res.status(400).json({ error: 'neighborhoodName is required' });

    const componentType = req.query.componentType ? String(req.query.componentType).trim() : null;
    if (!componentType) {
      // return list of component types with counts
      const db = mongoose.connection.db;
      const agg = await db.collection('canonicalcomponents').aggregate([
        { $match: { neighborhoodName: neighborhood } },
        { $group: { _id: '$componentType', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]).toArray();
      const factories = agg.map((r) => ({ name: r._id, rowCount: r.count }));
      return res.json({ neighborhood, factories });
    }

    // componentType provided — return legacy-shaped factory with paged rows
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const filter = { neighborhoodName: neighborhood, componentType };
    const [total, docs] = await Promise.all([
      CanonicalComponent.countDocuments(filter),
      CanonicalComponent.find(filter).sort({ primaryKey: 1 }).skip(skip).limit(limit).lean(),
    ]);

    const rows = docs.map((d) => ({
      _id: String(d._id),
      values: d.values || {},
      sourceBatches: d.sourceBatches || [],
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));

    // Derive columns from returned docs
    const columnsSet = new Set();
    docs.forEach((d) => {
      if (d.values && typeof d.values === 'object') Object.keys(d.values).forEach((k) => columnsSet.add(k));
    });

    const factory = {
      _id: componentType,
      neighborhoodName: neighborhood,
      name: componentType,
      sourceColumnName: componentType,
      columns: Array.from(columnsSet),
      qualifierColumns: [],
      foreignKeyColumns: [],
      owner: '',
      createdBy: '',
      sourceFileName: '',
      createdAt: null,
      updatedAt: null,
      rowCount: total,
      rows,
    };

    return res.json(serializeFactory(factory));
  } catch (err) {
    console.error('[CANONICAL-ADAPTER] error', err && err.message);
    res.status(500).json({ error: err?.message || 'canonical adapter error' });
  }
});

module.exports = router;