import type { InvestigationRecord } from '../types/spherex';

const DB_NAME = 'urutau_research_notebook';
const DB_VERSION = 1;
const STORE_NAME = 'investigations';
const FALLBACK_KEY = 'urutau_investigations_fallback';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadAllInvestigations(): Promise<InvestigationRecord[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result as InvestigationRecord[]) || [];
        list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      return raw ? (JSON.parse(raw) as InvestigationRecord[]) : [];
    } catch {
      return [];
    }
  }
}

export async function saveInvestigation(record: InvestigationRecord): Promise<void> {
  const updated: InvestigationRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(updated);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    const existing = await loadAllInvestigations();
    const filtered = existing.filter((r) => r.id !== updated.id);
    localStorage.setItem(FALLBACK_KEY, JSON.stringify([updated, ...filtered]));
  }
}

export async function deleteInvestigation(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    const existing = await loadAllInvestigations();
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(existing.filter((r) => r.id !== id)));
  }
}
