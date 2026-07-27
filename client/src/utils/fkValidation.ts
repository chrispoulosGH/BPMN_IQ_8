import type { CustomFactory, CustomFactoryRow } from '../types';
import { getDataFactories } from '../api';

export interface FkColumnTarget {
  targetTab: string;
  targetSubtab: string;
  targetField: string;
}

const validationCache = new Map<string, Promise<Set<string>>>();

export function normalizeFkToken(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normalizeFkValue(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

export function parseFkColumnHeader(column: string): FkColumnTarget | null {
  const match = String(column || '').trim().match(/^FK_([^\[]+)\[([^\]]+)\]\.(.+)$/i);
  if (!match) return null;
  return {
    targetTab: match[1].trim(),
    targetSubtab: match[2].trim(),
    targetField: match[3].trim(),
  };
}

function getRowValues(row: CustomFactoryRow) {
  const values = row?.values;
  return values && typeof values === 'object' ? values : row;
}

function buildValueSet(factories: CustomFactory[], targetField: string) {
  const normalizedTargetField = normalizeFkToken(targetField);
  const values = new Set<string>();

  for (const factory of factories) {
    for (const row of factory.rows || []) {
      const rowValues = getRowValues(row as CustomFactoryRow) as Record<string, unknown>;
      for (const [key, rawValue] of Object.entries(rowValues || {})) {
        if (normalizeFkToken(key) !== normalizedTargetField) continue;
        const normalizedValue = normalizeFkValue(rawValue);
        if (normalizedValue) values.add(normalizedValue);
      }
    }
  }

  return values;
}

export async function loadFkValidationValues(targetTab: string, targetSubtab: string, targetField: string): Promise<Set<string>> {
  const cacheKey = [normalizeFkToken(targetTab), normalizeFkToken(targetSubtab), normalizeFkToken(targetField)].join('|');
  const cached = validationCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const neighborhoodName = String(targetTab || '').trim();
    const subtabName = String(targetSubtab || '').trim();
    if (!neighborhoodName || !subtabName || !targetField) return new Set<string>();

    const factories = await getDataFactories(neighborhoodName, subtabName).catch(() => [] as CustomFactory[]);
    return buildValueSet(factories, targetField);
  })();

  validationCache.set(cacheKey, promise);
  return promise;
}