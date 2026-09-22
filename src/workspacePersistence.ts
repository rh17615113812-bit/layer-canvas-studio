import type { SceneState } from './types';

const DATABASE_NAME = 'layer-canvas-studio';
const STORE_NAME = 'workspace';
const SNAPSHOT_KEY = 'current';
const SNAPSHOT_VERSION = 1;

export type WorkspaceSnapshot = {
  version: number;
  scenes: SceneState[];
  sceneId: string;
  pageId: string;
  view: { x: number; y: number; z: number };
  collapsedGroups: string[];
  collapsedArtboards: string[];
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开浏览器本地存储。'));
  });
}

function runTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('浏览器本地存储操作失败。'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => database.close();
  }));
}

export async function loadWorkspace(): Promise<WorkspaceSnapshot | undefined> {
  const value = await runTransaction('readonly', (store) => store.get(SNAPSHOT_KEY));
  return isWorkspaceSnapshot(value) ? value : undefined;
}

export function saveWorkspace(snapshot: WorkspaceSnapshot) {
  return runTransaction('readwrite', (store) => store.put(snapshot, SNAPSHOT_KEY));
}

export function clearWorkspace() {
  return runTransaction('readwrite', (store) => store.delete(SNAPSHOT_KEY));
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<WorkspaceSnapshot>;
  return snapshot.version === SNAPSHOT_VERSION && Array.isArray(snapshot.scenes) && snapshot.scenes.length > 0 && snapshot.scenes.every((scene) => typeof scene?.id === 'string' && Array.isArray(scene.pages) && scene.pages.length > 0) && typeof snapshot.sceneId === 'string' && typeof snapshot.pageId === 'string' && typeof snapshot.view?.x === 'number' && typeof snapshot.view.y === 'number' && typeof snapshot.view.z === 'number' && Array.isArray(snapshot.collapsedGroups) && Array.isArray(snapshot.collapsedArtboards);
}

export const workspaceSnapshotVersion = SNAPSHOT_VERSION;
