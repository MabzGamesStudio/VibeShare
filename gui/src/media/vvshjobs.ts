// The publishing workspace, kept in the browser's IndexedDB. While a video is being
// encoded and uploaded, the picked file, every finished encoding and the exact progress
// of the job live here — so closing or refreshing the page loses nothing and publishing
// can be picked back up where it stopped (content-addressed uploads are skipped if their
// hash is already recorded). This is only the workbench: once published, the video lives
// on the provider node's storage, and nothing is kept here beyond the last job.
export interface VvshJob {
  id: string;
  name: string;
  totalSeconds: number;
  rows: { id: string; height: number; fps: number; kbps: number; customFps?: boolean; customHeight?: boolean }[];
  chunkSeconds: number;
  previewSplits: number;
  sourceMime: string;
  status: 'working' | 'done' | 'error';
  stage: string;
  pct: number;
  /** Rendition ids whose encoding has finished (their bytes are stored under `enc:<id>`). */
  encoded: string[];
  /** Object hashes already uploaded — a resumed job does not send them again. */
  uploaded: string[];
  cid?: string;
  error?: string;
  updatedAt: number;
}

const DB_NAME = 'vibeshare-vvsh';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available'));
  });
}

async function withStore<T>(store: 'jobs' | 'blobs', mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

export async function loadJob(): Promise<VvshJob | undefined> {
  return withStore('jobs', 'readonly', (store) => store.get('current') as IDBRequest<VvshJob | undefined>);
}

export async function saveJob(job: VvshJob): Promise<void> {
  await withStore('jobs', 'readwrite', (store) => store.put({ ...job, updatedAt: Date.now() }, 'current'));
}

export async function clearJob(): Promise<void> {
  await withStore('jobs', 'readwrite', (store) => store.delete('current'));
  await withStore('blobs', 'readwrite', (store) => store.clear());
}

export async function putBlob(key: string, data: Uint8Array | Blob): Promise<void> {
  const value = data instanceof Blob ? data : new Blob([Uint8Array.from(data)]);
  await withStore('blobs', 'readwrite', (store) => store.put(value, key));
}

export async function getBlob(key: string): Promise<Uint8Array | null> {
  const blob = await withStore('blobs', 'readonly', (store) => store.get(key) as IDBRequest<Blob | undefined>);
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export async function getStoredFile(key: string): Promise<Blob | null> {
  return (await withStore('blobs', 'readonly', (store) => store.get(key) as IDBRequest<Blob | undefined>)) ?? null;
}

/** A fresh job id for one publish. */
export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}