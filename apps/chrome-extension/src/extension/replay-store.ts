/// <reference types="chrome" />
// Local replay-video storage. Videos are rendered in the browser and kept in
// the extension's IndexedDB — nothing video-related touches the server.
// Keep only the newest few entries so disk usage stays bounded.

const DB_NAME = 'qiyuan-replay';
const STORE = 'videos';
const KEEP_LATEST = 8;

export interface ReplayVideoRow {
  taskId: string;
  createdAt: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'taskId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveReplayVideo(
  taskId: string,
  blob: Blob,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        taskId,
        createdAt: Date.now(),
        blob,
      } satisfies ReplayVideoRow);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Prune: keep only the newest KEEP_LATEST entries.
    const all = await new Promise<ReplayVideoRow[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as ReplayVideoRow[]) || []);
      req.onerror = () => reject(req.error);
    });
    const stale = all
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(KEEP_LATEST);
    if (stale.length) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        for (const row of stale) tx.objectStore(STORE).delete(row.taskId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  } finally {
    db.close();
  }
}

export async function getReplayVideo(taskId: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    const row = await new Promise<ReplayVideoRow | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(taskId);
        req.onsuccess = () => resolve(req.result as ReplayVideoRow | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    return row?.blob ?? null;
  } finally {
    db.close();
  }
}
