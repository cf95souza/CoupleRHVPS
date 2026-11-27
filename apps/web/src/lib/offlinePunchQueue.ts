export interface QueuedOfflinePunch {
  clientUuid: string;
  workerId?: string;
  punchType: 'ENTRY' | 'INTERVAL_START' | 'INTERVAL_END' | 'EXIT';
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  isMockLocation: boolean;
  deviceFingerprint: string;
  deviceTimestamp: string;
  selfieBase64?: string | null;
  selfieMimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
  createdAt: string;
}

const DB_NAME = 'couplerh_ponto_offline_db';
const DB_VERSION = 1;
const STORE_NAME = 'pending_punches';

function openOfflineDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponível neste ambiente.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'clientUuid' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Erro ao abrir IndexedDB offline.'));
  });
}

export async function enqueueOfflinePunch(punch: QueuedOfflinePunch): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(punch);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Fallback em localStorage caso IndexedDB esteja bloqueado
    const raw = localStorage.getItem('@coupleRH:offlinePunches') || '[]';
    const arr = JSON.parse(raw) as QueuedOfflinePunch[];
    if (!arr.some((p) => p.clientUuid === punch.clientUuid)) {
      arr.push(punch);
      localStorage.setItem('@coupleRH:offlinePunches', JSON.stringify(arr));
    }
  }
}

export async function listOfflinePunches(): Promise<QueuedOfflinePunch[]> {
  try {
    const db = await openOfflineDb();
    const list = await new Promise<QueuedOfflinePunch[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result || []) as QueuedOfflinePunch[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return list.sort((a, b) => a.deviceTimestamp.localeCompare(b.deviceTimestamp));
  } catch {
    const raw = localStorage.getItem('@coupleRH:offlinePunches') || '[]';
    return (JSON.parse(raw) as QueuedOfflinePunch[]).sort((a, b) =>
      a.deviceTimestamp.localeCompare(b.deviceTimestamp)
    );
  }
}

export async function removeOfflinePunch(clientUuid: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(clientUuid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    const raw = localStorage.getItem('@coupleRH:offlinePunches') || '[]';
    const arr = (JSON.parse(raw) as QueuedOfflinePunch[]).filter((p) => p.clientUuid !== clientUuid);
    localStorage.setItem('@coupleRH:offlinePunches', JSON.stringify(arr));
  }
}

export async function syncOfflinePunches(
  sender: (punches: QueuedOfflinePunch[]) => Promise<{ results: Array<{ clientUuid: string | null; status: string }> }>
): Promise<{ synced: number; remaining: number }> {
  const pending = await listOfflinePunches();
  if (pending.length === 0) return { synced: 0, remaining: 0 };

  const res = await sender(pending);
  let synced = 0;
  for (const item of res.results || []) {
    if (item.clientUuid && (item.status === 'SYNCED' || item.status === 'DUPLICATE')) {
      await removeOfflinePunch(item.clientUuid);
      synced++;
    }
  }
  const rest = await listOfflinePunches();
  return { synced, remaining: rest.length };
}
