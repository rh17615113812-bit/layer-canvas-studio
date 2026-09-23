import { writePsd } from 'ag-psd';
import { strToU8, zipSync } from 'fflate';
import type { DocumentState, LayerNode, TextLayerStyle } from './types';
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

const hexRgb = (value: string) => {
  const raw = value.replace('#', '');
  const expanded = raw.length === 3 ? [...raw].map(char => `${char}${char}`).join('') : raw;
  const number = Number.parseInt(expanded, 16);
  return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
};

const resolvedTextStyle = (layer: LayerNode): TextLayerStyle => ({
  fontFamily: 'Arial', fontSize: 24, color: '#ffffff', ...layer.textStyle,
});

const renderTextCanvas = (layer: LayerNode, width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d')!;
  const style = resolvedTextStyle(layer);
  const fontSize = Math.max(1, style.fontSize || 24);
  context.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontSize}px "${style.fontFamily || 'Arial'}"`;
  context.textBaseline = 'top';
  context.textAlign = style.align || 'left';
  context.fillStyle = style.color || '#ffffff';
  context.strokeStyle = style.strokeColor || '#000000';
  context.lineWidth = style.strokeWidth || 0;
  context.lineJoin = 'round';
  const lines = (layer.textContent || '').split(/\r?\n/);
  const lineHeight = fontSize * (style.lineHeight || 1.2);
  const maxWidth = Math.max(1, width);
  const wrapped = lines.flatMap(line => {
    if (!line) return [''];
    const output: string[] = [];
    let current = '';
    for (const character of [...line]) {
      const candidate = current + character;
      if (current && context.measureText(candidate).width + Math.max(0, candidate.length - 1) * (style.letterSpacing || 0) > maxWidth) {
        output.push(current);
        current = character;
      } else current = candidate;
    }
    if (current) output.push(current);
    return output;
  });
  const totalHeight = wrapped.length * lineHeight;
  const verticalOffset = style.verticalAlign === 'middle' ? Math.max(0, (height - totalHeight) / 2) : style.verticalAlign === 'bottom' ? Math.max(0, height - totalHeight) : 0;
  wrapped.forEach((line, index) => {
    const metrics = context.measureText(line);
    const extraWidth = Math.max(0, line.length - 1) * (style.letterSpacing || 0);
    const startX = style.align === 'center' ? (width - metrics.width - extraWidth) / 2 : style.align === 'right' ? width - metrics.width - extraWidth : 0;
    let x = startX;
    const y = verticalOffset + index * lineHeight;
    for (const character of [...line]) {
      if (style.strokeWidth) context.strokeText(character, x, y);
      context.fillText(character, x, y);
      x += context.measureText(character).width + (style.letterSpacing || 0);
    }
  });
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
    .filter((layer) => layer.artboardId === artboard.id && (layer.kind === 'text' || (layer.kind === 'image' && layer.source)))
    .sort((a, b) => a.zIndex - b.zIndex);
  const imageLayers = layers.filter(layer => layer.kind === 'image' && layer.source);
  const prepared = await Promise.all(imageLayers.map(async (layer) => {
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
  const preparedText = layers.filter(layer => layer.kind === 'text').map(layer => {
    const local = layerToArtboardCoordinates(layer, artboard);
    const left = Math.round(local.x), top = Math.round(local.y);
    const width = Math.max(1, Math.round(layer.width)), height = Math.max(1, Math.round(layer.height));
    const style = resolvedTextStyle(layer);
    const canvas = renderTextCanvas(layer, width, height);
    const psdLayer = {
      name: layer.name,
      left, top, right: left + width, bottom: top + height,
      hidden: !layer.visible,
      opacity: Math.round((layer.opacity ?? 1) * 255),
      canvas,
      text: {
        text: layer.textContent || '',
        transform: [1, 0, 0, 1, left, top],
        left, top, right: left + width, bottom: top + height,
        style: {
          font: { name: style.fontFamily.replace(/\s+/g, '') || 'ArialMT' },
          fontSize: style.fontSize,
          fauxBold: style.bold,
          fauxItalic: style.italic,
          autoLeading: false,
          leading: style.fontSize * (style.lineHeight || 1.2),
          tracking: style.letterSpacing,
          fillColor: hexRgb(style.color || '#ffffff'),
          strokeColor: hexRgb(style.strokeColor || '#000000'),
          strokeFlag: (style.strokeWidth || 0) > 0,
          outlineWidth: style.strokeWidth || 0,
        },
        paragraphStyle: { justification: style.align || 'left' },
      },
    };
    return { sourceLayer: layer, displayCanvas: canvas, left, top, width, height, layer: psdLayer };
  });
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
  const compositeItems = [...prepared, ...preparedText].sort((a, b) => a.sourceLayer.zIndex - b.sourceLayer.zIndex);
  compositeItems.forEach(item => {
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
  const preparedById = new Map([...prepared, ...preparedText].map(item => [item.sourceLayer.id, item.layer]));
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
  } as never, { invalidateTextLayers: true });
  download(`${safeName(artboard.name)}.psd`, new Blob([bytes], { type: 'application/octet-stream' }));
};

const unityImporter = `
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
      if (item.kind != "image" && item.kind != "text") continue;
      var go = new GameObject(item.name, typeof(RectTransform));
      go.transform.SetParent(root.transform, false);
      var rect = go.GetComponent<RectTransform>();
      rect.anchorMin = new Vector2(0, 1); rect.anchorMax = new Vector2(0, 1); rect.pivot = new Vector2(0, 1);
      rect.anchoredPosition = new Vector2(item.x, -item.y); rect.sizeDelta = new Vector2(item.width, item.height);
      if (item.kind == "text") {
        var label = go.AddComponent<Text>();
        var style = item.textStyle ?? new TextStyle();
        label.text = item.textContent ?? "";
        label.font = Resources.GetBuiltinResource<Font>("Arial.ttf");
        if (!string.IsNullOrEmpty(style.fontFamily)) {
          var font = Resources.Load<Font>(style.fontFamily);
          if (font != null) label.font = font;
        }
        label.fontSize = Mathf.Max(1, Mathf.RoundToInt(style.fontSize > 0 ? style.fontSize : 24));
        label.fontStyle = style.bold && style.italic ? FontStyle.BoldAndItalic : style.bold ? FontStyle.Bold : style.italic ? FontStyle.Italic : FontStyle.Normal;
        label.color = ParseColor(style.color, Color.white);
        var horizontal = style.align == "center" ? "center" : style.align == "right" ? "right" : "left";
        var vertical = style.verticalAlign == "top" ? "top" : style.verticalAlign == "bottom" ? "bottom" : "middle";
        label.alignment = vertical == "top" ? (horizontal == "center" ? TextAnchor.UpperCenter : horizontal == "right" ? TextAnchor.UpperRight : TextAnchor.UpperLeft) : vertical == "bottom" ? (horizontal == "center" ? TextAnchor.LowerCenter : horizontal == "right" ? TextAnchor.LowerRight : TextAnchor.LowerLeft) : (horizontal == "center" ? TextAnchor.MiddleCenter : horizontal == "right" ? TextAnchor.MiddleRight : TextAnchor.MiddleLeft);
        label.lineSpacing = style.lineHeight > 0 ? style.lineHeight : 1.2f;
        label.horizontalOverflow = HorizontalWrapMode.Wrap;
        label.verticalOverflow = VerticalWrapMode.Overflow;
        if (style.strokeWidth > 0) {
          var outline = go.AddComponent<Outline>();
          outline.effectColor = ParseColor(style.strokeColor, Color.black);
          outline.effectDistance = new Vector2(style.strokeWidth, -style.strokeWidth);
        }
      } else go.AddComponent<Image>();
      go.transform.SetSiblingIndex(Mathf.Max(0, item.zIndex));
    }
  }
  static Color ParseColor(string value, Color fallback) { if (ColorUtility.TryParseHtmlString(value, out var color)) return color; return fallback; }
  [System.Serializable] public class TextStyle { public string fontFamily, color, align, verticalAlign, strokeColor; public float fontSize, lineHeight, letterSpacing, strokeWidth; public bool bold, italic; }
  [System.Serializable] public class Layer { public string id, name, kind, textContent; public float x, y, width, height; public int zIndex; public TextStyle textStyle; }
  [System.Serializable] public class Layout { public Layer[] layers; }
}`;

const cocosImporter = `import { Color, Label, Node, UITransform } from 'cc';

type TextStyle = {
  fontFamily?: string; fontSize?: number; color?: string; bold?: boolean; italic?: boolean;
  align?: 'left' | 'center' | 'right'; verticalAlign?: 'top' | 'middle' | 'bottom';
  lineHeight?: number; letterSpacing?: number; strokeColor?: string; strokeWidth?: number;
};
type TextLayer = { name: string; x: number; y: number; width: number; height: number; textContent?: string; textStyle?: TextStyle };

/** Cocos Creator 3.x helper: call createText for each kind:"text" item in layout.json. */
export class LayerCanvasImporter {
  static createText(item: TextLayer, parent: Node): Node {
    const style = item.textStyle ?? {};
    const node = new Node(item.name || 'Text');
    node.layer = parent.layer;
    node.setParent(parent);
    const transform = node.addComponent(UITransform);
    transform.setContentSize(item.width, item.height);
    transform.setAnchorPoint(0, 1);
    node.setPosition(item.x, -item.y, 0);
    const label = node.addComponent(Label);
    label.string = item.textContent ?? '';
    label.useSystemFont = true;
    label.fontFamily = style.fontFamily || 'Arial';
    label.fontSize = Math.max(1, Math.round(style.fontSize || 24));
    label.lineHeight = Math.round(label.fontSize * (style.lineHeight || 1.2));
    label.spacingX = style.letterSpacing || 0;
    label.isBold = !!style.bold;
    label.isItalic = !!style.italic;
    label.horizontalAlign = style.align === 'center' ? Label.HorizontalAlign.CENTER : style.align === 'right' ? Label.HorizontalAlign.RIGHT : Label.HorizontalAlign.LEFT;
    label.verticalAlign = style.verticalAlign === 'middle' ? Label.VerticalAlign.CENTER : style.verticalAlign === 'bottom' ? Label.VerticalAlign.BOTTOM : Label.VerticalAlign.TOP;
    label.color = Color.fromHEX(new Color(), style.color || '#ffffff');
    if ((style.strokeWidth || 0) > 0) {
      label.enableOutline = true;
      label.outlineColor = Color.fromHEX(new Color(), style.strokeColor || '#000000');
      label.outlineWidth = Math.max(1, Math.round(style.strokeWidth || 0));
    }
    return node;
  }
}`;

export const exportUnityZip = (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  const files: Record<string, Uint8Array> = {
    'layout.json': strToU8(JSON.stringify(output, null, 2)),
    'Assets/LayerCanvas/Editor/LayerCanvasImporter.cs': strToU8(unityImporter),
    'README.txt': strToU8('Import layout.json and LayerCanvasImporter.cs into Unity. Select layout.json and run Tools > Layer Canvas > Import selected layout. Text layers become native Unity UI Text objects. Put font assets under Resources using the matching textStyle.fontFamily resource path to use non-default fonts.'),
  };
  output.layers
    .filter((layer): layer is LayerNode & { source: string } => layer.kind === 'image' && Boolean(layer.source))
    .forEach((layer) => {
      files[`assets/${safeName(layer.name)}-${layer.id.slice(-6)}.png`] = dataUrlBytes(layer.source);
    });
  download(`${safeName(output.artboards[0].name)}-unity.zip`, new Blob([zipSync(files)], { type: 'application/zip' }));
};

export const exportCocosZip = (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  const files: Record<string, Uint8Array> = {
    'layout.json': strToU8(JSON.stringify(output, null, 2)),
    'LayerCanvasImporter.ts': strToU8(cocosImporter),
    'README.txt': strToU8('Cocos Creator 3.x: copy LayerCanvasImporter.ts into your project. For each layout.json layer whose kind is "text", call LayerCanvasImporter.createText(layer, parentNode). Import the desired font assets and set their compatible system family in textStyle.fontFamily when using bitmap/native custom fonts.'),
  };
  output.layers
    .filter((layer): layer is LayerNode & { source: string } => layer.kind === 'image' && Boolean(layer.source))
    .forEach(layer => { files[`assets/${safeName(layer.name)}-${layer.id.slice(-6)}.png`] = dataUrlBytes(layer.source); });
  download(`${safeName(output.artboards[0].name)}-cocos.zip`, new Blob([zipSync(files)], { type: 'application/zip' }));
};
