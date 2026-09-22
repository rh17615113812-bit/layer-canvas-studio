import { writePsd } from 'ag-psd';
import { strToU8, zipSync } from 'fflate';
import type { DocumentState, LayerNode } from './types';
import { createArtboardDocument, createGroupDocument, layerToArtboardCoordinates } from './artboards';

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'layer';

const download = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

const createExportDocument = (document: DocumentState, artboardId?: string, groupId?: string) =>
  groupId ? createGroupDocument(document, groupId) : createArtboardDocument(document, artboardId);

export const exportJson = (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  download(`${safeName(output.artboards[0].name)}-layout.json`, new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
};

export const exportPsd = async (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  const artboard = output.artboards[0];
  if (!artboard) throw new Error('当前 Page 中没有可导出的画板。');
  const exportWidth = Math.max(1, Math.round(artboard.width));
  const exportHeight = Math.max(1, Math.round(artboard.height));
  const layers = [...output.layers]
    .filter((layer) => layer.artboardId === artboard.id && layer.kind === 'image' && layer.source)
    .sort((a, b) => a.zIndex - b.zIndex);
  const prepared = await Promise.all(layers.map(async (layer) => {
    const original = await toCanvas(layer.source!);
    const local = layerToArtboardCoordinates(layer, artboard);
    const left = Math.round(local.x), top = Math.round(local.y);
    const width = Math.max(1, Math.round(layer.width)), height = Math.max(1, Math.round(layer.height));
    const smartSource = trimFullCanvasTransparency(original, width, height);
    const sourceWidth = smartSource.width, sourceHeight = smartSource.height;
    const linkedId = guid(layer.id, 'a');
    const displayCanvas = toDisplayCanvas(smartSource, width, height);
    return {
      sourceLayer: layer,
      displayCanvas,
      left,
      top,
      width,
      height,
      layer: {
        name: layer.name,
        left, top, hidden: !layer.visible,
        opacity: Math.round((layer.opacity ?? 1) * 255),
        // This is Photoshop's raster preview and is intentionally rendered at the canvas display bounds.
        canvas: displayCanvas,
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
  const byId = new Map(output.layers.map(layer => [layer.id, layer]));
  const renderedOpacity = (layer: LayerNode) => {
    let opacity = 1;
    let current: LayerNode | undefined = layer;
    while (current) {
      if (!current.visible) return 0;
      opacity *= current.opacity ?? 1;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return Math.max(0, Math.min(1, opacity));
  };
  // PSD readers and Windows Explorer use the document composite/thumbnail instead of
  // rebuilding every layer. Without this canvas ag-psd writes an empty black composite.
  const composite = globalThis.document.createElement('canvas');
  composite.width = exportWidth;
  composite.height = exportHeight;
  const compositeContext = composite.getContext('2d')!;
  prepared.forEach(item => {
    const opacity = renderedOpacity(item.sourceLayer);
    if (!opacity) return;
    compositeContext.save();
    compositeContext.globalAlpha = opacity;
    compositeContext.translate(item.left, item.top);
    compositeContext.rotate(((item.sourceLayer.rotation ?? 0) * Math.PI) / 180);
    compositeContext.drawImage(item.displayCanvas, 0, 0, item.width, item.height);
    compositeContext.restore();
  });
  const thumbnailScale = Math.min(160 / exportWidth, 160 / exportHeight, 1);
  const thumbnail = globalThis.document.createElement('canvas');
  thumbnail.width = Math.max(1, Math.round(exportWidth * thumbnailScale));
  thumbnail.height = Math.max(1, Math.round(exportHeight * thumbnailScale));
  const thumbnailContext = thumbnail.getContext('2d')!;
  const checkerSize = Math.max(6, Math.round(12 * thumbnailScale));
  for (let y = 0; y < thumbnail.height; y += checkerSize) {
    for (let x = 0; x < thumbnail.width; x += checkerSize) {
      thumbnailContext.fillStyle =
        (Math.floor(x / checkerSize) + Math.floor(y / checkerSize)) % 2
          ? '#e9e9e9'
          : '#ffffff';
      thumbnailContext.fillRect(x, y, checkerSize, checkerSize);
    }
  }
  thumbnailContext.drawImage(composite, 0, 0, thumbnail.width, thumbnail.height);
  const preparedById = new Map(layers.map((layer, index) => [layer.id, prepared[index].layer]));
  const createChildren = (parentId: string | null): unknown[] => {
    const children: unknown[] = [];
    output.layers.filter(layer => layer.artboardId === artboard.id && layer.parentId === parentId).sort((a, b) => a.zIndex - b.zIndex).forEach(layer => {
      if (layer.kind === 'group') children.push({ name: layer.name, hidden: !layer.visible, opacity: Math.round((layer.opacity ?? 1) * 255), children: createChildren(layer.id) });
      else {
        const preparedLayer = preparedById.get(layer.id);
        if (preparedLayer) children.push(preparedLayer);
      }
    });
    return children;
  };
  const bytes = writePsd({
    width: exportWidth,
    height: exportHeight,
    canvas: composite,
    imageResources: { thumbnail },
    children: createChildren(null),
    linkedFiles: prepared.map(item => item.linkedFile),
  } as never);
  download(`${safeName(artboard.name)}.psd`, new Blob([bytes], { type: 'application/octet-stream' }));
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

export const exportUnityZip = (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  const files: Record<string, Uint8Array> = {
    'layout.json': strToU8(JSON.stringify(output, null, 2)),
    'Assets/LayerCanvas/Editor/LayerCanvasImporter.cs': strToU8(unityImporter),
    'README.txt': strToU8('Import PNG files, select layout.json, then run Tools > Layer Canvas > Import selected layout. Set imported PNG files to Sprite (2D and UI) before binding sprites.'),
  };
  output.layers
    .filter((layer): layer is LayerNode & { source: string } => layer.kind === 'image' && Boolean(layer.source))
    .forEach((layer) => {
      files[`assets/${safeName(layer.name)}-${layer.id.slice(-6)}.png`] = dataUrlBytes(layer.source);
    });
  download(`${safeName(output.artboards[0].name)}-unity.zip`, new Blob([zipSync(files)], { type: 'application/zip' }));
};
