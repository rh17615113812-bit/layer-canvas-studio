import type { SceneState } from './types';

const DATABASE_NAME = 'layer-canvas-studio';
const STORE_NAME = 'workspace';
const ASSET_STORE = 'assets';
const SNAPSHOT_KEY = 'current';
const VIEW_KEY = 'view';
const ASSET_PREFIX = 'layer-canvas-asset:';
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

type StoredSnapshot = WorkspaceSnapshot & { assetsSeparated?: boolean };
let lastSavedScenes: SceneState[] | undefined;
let sourceIds = new Map<string, string>();
let pending: Promise<unknown> = Promise.resolve();
const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      for (const name of [STORE_NAME, ASSET_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开浏览器本地存储。'));
  });
}

/** A successful request is not a committed transaction. */
async function runTransaction<T>(mode: IDBTransactionMode, action: (transaction: IDBTransaction) => () => T): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction([STORE_NAME, ASSET_STORE], mode); }
    catch (error) { database.close(); reject(error); return; }
    const fail = () => {
      database.close();
      reject(transaction.error ?? new Error('浏览器本地存储事务未提交。'));
    };
    transaction.onerror = fail;
    transaction.onabort = fail;
    try {
      const result = action(transaction);
      transaction.oncomplete = () => {
        database.close();
        try { resolve(result()); } catch (error) { reject(error); }
      };
    } catch (error) {
      transaction.abort(); database.close(); reject(error);
    }
  });
}

export function loadWorkspace(): Promise<WorkspaceSnapshot | undefined> {
  return enqueue(async () => {
    const loadedSources = new Map<string, string>();
    const snapshot = await runTransaction('readonly', transaction => {
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(SNAPSHOT_KEY);
      const viewRequest = store.get(VIEW_KEY);
      const assets = new Map<string, string>();
      let stored: StoredSnapshot | undefined;
      let missingAsset = false;
      request.onsuccess = () => {
        stored = request.result;
        if (!stored?.assetsSeparated || !Array.isArray(stored.scenes) || !stored.scenes.every(scene =>
          Array.isArray(scene?.pages) && scene.pages.every(page => Array.isArray(page?.document?.layers)))) return;
        const ids = new Set(stored.scenes.flatMap(scene => scene.pages.flatMap(page => page.document.layers.flatMap(layer =>
          layer.source?.startsWith(ASSET_PREFIX) ? [layer.source.slice(ASSET_PREFIX.length)] : []))));
        for (const id of ids) {
          const assetRequest = transaction.objectStore(ASSET_STORE).get(id);
          assetRequest.onsuccess = () => {
            if (typeof assetRequest.result !== 'string') missingAsset = true;
            else { assets.set(id, assetRequest.result); loadedSources.set(assetRequest.result, id); }
          };
        }
      };
      return () => {
        if (missingAsset) throw new Error('工作区图片资源缺失，无法完整恢复。');
        if (!stored) return undefined;
        const merged = { ...stored, ...(viewRequest.result ?? {}) };
        if (!isWorkspaceSnapshot(merged)) return undefined;
        if (!stored.assetsSeparated) return merged;
        return { ...merged, scenes: merged.scenes.map(scene => ({ ...scene, pages: scene.pages.map(page => ({
          ...page, document: { ...page.document, layers: page.document.layers.map(layer => ({ ...layer,
            ...(layer.source?.startsWith(ASSET_PREFIX) ? { source: assets.get(layer.source.slice(ASSET_PREFIX.length))! } : {}),
          })) },
        })) })) };
      };
    });
    sourceIds = loadedSources;
    // Legacy snapshots must be migrated by the next save.
    lastSavedScenes = loadedSources.size ? snapshot?.scenes : undefined;
    return snapshot;
  });
}

export function saveWorkspace(snapshot: WorkspaceSnapshot): Promise<void> {
  return enqueue(async () => {
    const { scenes, version, ...viewState } = snapshot;
    const documentsChanged = scenes !== lastSavedScenes;
    const nextSources = new Map<string, string>();
    const storedScenes = documentsChanged ? scenes.map(scene => ({ ...scene, pages: scene.pages.map(page => ({
      ...page, document: { ...page.document, layers: page.document.layers.map(layer => {
        if (!layer.source) return layer;
        const id = nextSources.get(layer.source) ?? sourceIds.get(layer.source) ?? crypto.randomUUID();
        nextSources.set(layer.source, id);
        return { ...layer, source: ASSET_PREFIX + id };
      }) },
    })) })) : undefined;
    await runTransaction('readwrite', transaction => {
      const store = transaction.objectStore(STORE_NAME);
      store.put(viewState, VIEW_KEY);
      if (storedScenes) {
        const assets = transaction.objectStore(ASSET_STORE);
        for (const [source, id] of nextSources) if (!sourceIds.has(source)) assets.put(source, id);
        const retained = new Set(nextSources.values());
        const keysRequest = assets.getAllKeys();
        keysRequest.onsuccess = () => keysRequest.result.forEach(key => { if (!retained.has(String(key))) assets.delete(key); });
        store.put({ version, scenes: storedScenes, assetsSeparated: true }, SNAPSHOT_KEY);
      }
      return () => undefined;
    });
    if (documentsChanged) { sourceIds = nextSources; lastSavedScenes = scenes; }
  });
}

export function clearWorkspace(): Promise<void> {
  return enqueue(async () => {
    await runTransaction('readwrite', transaction => {
      transaction.objectStore(STORE_NAME).clear();
      transaction.objectStore(ASSET_STORE).clear();
      return () => undefined;
    });
    sourceIds.clear(); lastSavedScenes = undefined;
  });
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<WorkspaceSnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.scenes) || !snapshot.scenes.length ||
    !snapshot.scenes.every(scene => typeof scene?.id === 'string' && Array.isArray(scene.pages) && scene.pages.length > 0 &&
      scene.pages.every(page => typeof page?.id === 'string' && Array.isArray(page.document?.layers) && Array.isArray(page.document.artboards))) ||
    ![snapshot.view?.x, snapshot.view?.y, snapshot.view?.z].every(value => typeof value === 'number' && Number.isFinite(value)) ||
    !snapshot.view || snapshot.view.z <= 0 || !Array.isArray(snapshot.collapsedGroups) || !Array.isArray(snapshot.collapsedArtboards)) return false;
  return snapshot.scenes.some(scene => scene.id === snapshot.sceneId && scene.pages.some(page => page.id === snapshot.pageId));
}

export const workspaceSnapshotVersion = SNAPSHOT_VERSION;
