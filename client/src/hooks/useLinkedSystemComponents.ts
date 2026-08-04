import { useEffect, useRef, useState } from 'react';
import {
  getSystemComponentLinkedTypes,
  getSystemComponentRecordsLinkedToApplication,
  type LinkedSystemComponentRecord,
} from '../api';

export interface LinkedRecordsModalState {
  open: boolean;
  componentType: string;
  appName: string;
  loading: boolean;
  records: LinkedSystemComponentRecord[];
}

const CLOSED_STATE: LinkedRecordsModalState = {
  open: false,
  componentType: '',
  appName: '',
  loading: false,
  records: [],
};

// Shared across any view that lets a user right-click an Application and see
// what System Components data (Servers, Software, or any future type) links
// to it. `linkedComponentTypes` is discovered from the data itself — see
// discoverComponentTypesLinkedToTarget() server-side — so this hook never
// needs to know the type names in advance.
export function useLinkedSystemComponents(target: string = 'Applications') {
  const [linkedComponentTypes, setLinkedComponentTypes] = useState<string[]>([]);
  const linkedComponentTypesRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getSystemComponentLinkedTypes(target)
      .then((types) => {
        if (cancelled) return;
        setLinkedComponentTypes(types);
        linkedComponentTypesRef.current = types;
      })
      .catch(() => {
        if (cancelled) return;
        setLinkedComponentTypes([]);
        linkedComponentTypesRef.current = [];
      });
    return () => { cancelled = true; };
  }, [target]);

  const [modalState, setModalState] = useState<LinkedRecordsModalState>(CLOSED_STATE);

  const loadLinkedRecords = async (componentType: string, appDisplayName: string, correlationId: string | null | undefined) => {
    setModalState({ open: true, componentType, appName: appDisplayName, loading: true, records: [] });
    try {
      const rows = correlationId
        ? await getSystemComponentRecordsLinkedToApplication(componentType, correlationId)
        : [];
      setModalState((current) => ({ ...current, loading: false, records: rows }));
    } catch {
      setModalState((current) => ({ ...current, loading: false, records: [] }));
    }
  };

  const closeModal = () => setModalState((current) => ({ ...current, open: false }));

  return { linkedComponentTypes, linkedComponentTypesRef, modalState, loadLinkedRecords, closeModal };
}
