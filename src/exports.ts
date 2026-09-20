import { writePsd } from 'ag-psd';
import { strToU8, zipSync } from 'fflate';
import type { DocumentState, LayerNode } from './types';

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'layer';

const download = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取图层图片'));
    image.src = src;
  });

const toCanvas = async (source: string) => {
  const image = await loadImage(source);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  return canvas;
};

const toDisplayCanvas = (source: HTMLCanvasElement, width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
};

const trimFullCanvasTransparency = (source: HTMLCanvasElement, displayWidth: number, displayHeight: number) => {
  // Older split results may still contain a full-size transparent source. Trim only when it is larger than its recorded display box.
  if (source.width <= displayWidth + 1 && source.height <= displayHeight + 1) return source;
  const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data;
  let left = source.width, top = source.height, right = -1, bottom = -1;
  for (let y = 0; y < source.height; y += 1) for (let x = 0; x < source.width; x += 1) {
    if (pixels[(y * source.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || (left === 0 && top === 0 && right === source.width - 1 && bottom === source.height - 1)) return source;
  const trimmed = document.createElement('canvas');
  trimmed.width = right - left + 1; trimmed.height = bottom - top + 1;
  trimmed.getContext('2d')!.drawImage(source, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
  return trimmed;
};

const guid = (seed: string, tail: string) => {
  const hex = `${seed.replace(/-/g, '')}${'0'.repeat(32)}`.slice(0, 31);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${tail}`;
};

const dataUrlBytes = (dataUrl: string) => {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const exportJson = (document: DocumentState) =>
  download('layer-canvas-layout.json', new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));

export const exportPsd = async (document: DocumentState) => {
  const layers = [...document.layers]
    .filter((layer) => layer.kind === 'image' && layer.source)
    .sort((a, b) => a.zIndex - b.zIndex);
  const prepared = await Promise.all(layers.map(async (layer) => {
    const original = await toCanvas(layer.source!);
    const left = Math.round(layer.x), top = Math.round(layer.y);
    const width = Math.max(1, Math.round(layer.width)), height = Math.max(1, Math.round(layer.height));
    const smartSource = trimFullCanvasTransparency(original, width, height);
    const sourceWidth = smartSource.width, sourceHeight = smartSource.height;
    const linkedId = guid(layer.id, 'a');
    return {
      layer: {
        name: layer.name,
        left, top, hidden: !layer.visible,
        opacity: Math.round((layer.opacity ?? 1) * 255),
        // This is Photoshop's raster preview and is intentionally rendered at the canvas display bounds.
        canvas: toDisplayCanvas(smartSource, width, height),
        // The lossless source PNG is embedded below as a Photoshop Smart Object.
        placedLayer: {
          id: linkedId, placed: guid(layer.id, 'b'), type: 'raster',
          width: sourceWidth, height: sourceHeight,
          transform: [left, top, left + width, top, left + width, top + height, left, top + height],
          resolution: { value: 72, units: 'Density' as const },
        },
      },
      linkedFile: { id: linkedId, name: `${safeName(layer.name)}.png`, type: 'png', data: dataUrlBytes(smartSource.toDataURL('image/png')) },
    };
  }));
  const preparedById = new Map(layers.map((layer, index) => [layer.id, prepared[index].layer]));
  const createChildren = (parentId: string | null): unknown[] => {
    const children: unknown[] = [];
    document.layers.filter(layer => layer.parentId === parentId).sort((a, b) => a.zIndex - b.zIndex).forEach(layer => {
      if (layer.kind === 'group') children.push({ name: layer.name, hidden: !layer.visible, opacity: Math.round((layer.opacity ?? 1) * 255), children: createChildren(layer.id) });
      else {
        const preparedLayer = preparedById.get(layer.id);
        if (preparedLayer) children.push(preparedLayer);
      }
    });
    return children;
  };
  const bytes = writePsd({
    width: document.canvas.width,
    height: document.canvas.height,
    children: createChildren(null),
    linkedFiles: prepared.map(item => item.linkedFile),
  } as never);
  download('layer-canvas.psd', new Blob([bytes], { type: 'application/octet-stream' }));
};

const unityImporter = `using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

public static class LayerCanvasImporter {
  [MenuItem("Tools/Layer Canvas/Import selected layout")]
  public static void Import() {
    var layout = Selection.activeObject as TextAsset;
    if (layout == null) { Debug.LogError("Select layout.json first."); return; }
    var root = new GameObject("Imported UI", typeof(RectTransform));
    var canvas = root.AddComponent<Canvas>(); canvas.renderMode = RenderMode.ScreenSpaceOverlay;
    foreach (var item in JsonUtility.FromJson<Layout>(layout.text).layers) {
      if (item.kind != "image") continue;
      var go = new GameObject(item.name, typeof(RectTransform), typeof(Image));
      go.transform.SetParent(root.transform, false);
      var rect = go.GetComponent<RectTransform>();
      rect.anchorMin = new Vector2(0, 1); rect.anchorMax = new Vector2(0, 1); rect.pivot = new Vector2(0, 1);
      rect.anchoredPosition = new Vector2(item.x, -item.y); rect.sizeDelta = new Vector2(item.width, item.height);
    }
  }
  [System.Serializable] public class Layer { public string name, kind; public float x, y, width, height; }
  [System.Serializable] public class Layout { public Layer[] layers; }
}`;

export const exportUnityZip = (document: DocumentState) => {
  const files: Record<string, Uint8Array> = {
    'layout.json': strToU8(JSON.stringify(document, null, 2)),
    'Assets/LayerCanvas/Editor/LayerCanvasImporter.cs': strToU8(unityImporter),
    'README.txt': strToU8('Import PNG files, select layout.json, then run Tools > Layer Canvas > Import selected layout. Set imported PNG files to Sprite (2D and UI) before binding sprites.'),
  };
  document.layers
    .filter((layer): layer is LayerNode & { source: string } => layer.kind === 'image' && Boolean(layer.source))
    .forEach((layer) => {
      files[`assets/${safeName(layer.name)}-${layer.id.slice(-6)}.png`] = dataUrlBytes(layer.source);
    });
  download('layer-canvas-unity.zip', new Blob([zipSync(files)], { type: 'application/zip' }));
};
