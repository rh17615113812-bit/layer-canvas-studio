import type { DocumentState, SceneState } from './types';

export type HistoryStack = { undo: DocumentState[]; redo: DocumentState[] };
export type EditorState = { scenes: SceneState[]; histories: Record<string, HistoryStack> };
export type EditorAction =
  | { type: 'scenes'; change: SceneState[] | ((scenes: SceneState[]) => SceneState[]); resetHistory?: boolean }
  | { type: 'document'; sceneId: string; pageId: string; change: DocumentState | ((doc: DocumentState) => DocumentState); recordHistory: boolean }
  | { type: 'history'; sceneId: string; pageId: string; direction: 'undo' | 'redo' };

const shallowEqual = (a: object, b: object) => {
  const keys = Object.keys(a) as (keyof typeof a)[];
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
};

// Compare metadata without serializing or copying large immutable image strings.
export function documentsEqual(a: DocumentState, b: DocumentState): boolean {
  return a === b || a.version === b.version && shallowEqual(a.canvas, b.canvas) &&
    a.artboards.length === b.artboards.length && a.artboards.every((board, i) => shallowEqual(board, b.artboards[i])) &&
    a.layers.length === b.layers.length && a.layers.every((layer, i) => {
      const other = b.layers[i];
      return layer === other || shallowEqual({ ...layer, textStyle: undefined }, { ...other, textStyle: undefined }) &&
        (layer.textStyle === other.textStyle || !!layer.textStyle && !!other.textStyle && shallowEqual(layer.textStyle, other.textStyle));
    });
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === 'scenes') {
    const scenes = typeof action.change === 'function' ? action.change(state.scenes) : action.change;
    const keys = new Set(scenes.flatMap(scene => scene.pages.map(page => `${scene.id}:${page.id}`)));
    const histories = action.resetHistory ? {} : Object.fromEntries(Object.entries(state.histories).filter(([key]) => keys.has(key)));
    return { scenes, histories };
  }
  const scene = state.scenes.find(item => item.id === action.sceneId);
  const page = scene?.pages.find(item => item.id === action.pageId);
  if (!page) return state;
  const key = `${action.sceneId}:${action.pageId}`;
  const stack = state.histories[key] ?? { undo: [], redo: [] };
  let next: DocumentState;
  let nextStack = stack;
  if (action.type === 'history') {
    const entries = stack[action.direction];
    if (!entries.length) return state;
    next = entries.at(-1)!;
    nextStack = action.direction === 'undo'
      ? { undo: stack.undo.slice(0, -1), redo: [...stack.redo, page.document].slice(-100) }
      : { undo: [...stack.undo, page.document].slice(-100), redo: stack.redo.slice(0, -1) };
  } else {
    next = typeof action.change === 'function' ? action.change(page.document) : action.change;
    if (documentsEqual(next, page.document)) return state;
    if (action.recordHistory) nextStack = { undo: [...stack.undo, page.document].slice(-100), redo: [] };
  }
  return {
    scenes: state.scenes.map(item => item.id !== action.sceneId ? item : {
      ...item, pages: item.pages.map(item => item.id !== action.pageId ? item : { ...item, document: next }),
    }),
    histories: { ...state.histories, [key]: nextStack },
  };
}
