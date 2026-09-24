import { readPsd, writePsd } from 'ag-psd';
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

export type PsdExportOptions = { fileName?: string; rasterizeText?: boolean; rebuildTextOnOpen?: boolean };

export const psdFileName = (value: string) => {
  const name = value.replace(/\.psd$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120);
  return `${name || 'untitled'}.psd`;
};

export const psdExportInfo = (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  const artboard = output.artboards[0];
  return {
    name: artboard.name,
    width: Math.max(1, Math.round(artboard.width)),
    height: Math.max(1, Math.round(artboard.height)),
    imageCount: output.layers.filter(layer => layer.kind === 'image' && layer.source).length,
    textCount: output.layers.filter(layer => layer.kind === 'text').length,
  };
};

type CompositeItem = { sourceLayer: LayerNode; displayCanvas: HTMLCanvasElement; left: number; top: number; width: number; height: number };

const composePsdCanvas = (output: DocumentState, items: CompositeItem[], width: number, height: number) => {
  const byId = new Map(output.layers.map(layer => [layer.id, layer]));
  const composite = globalThis.document.createElement('canvas');
  composite.width = width; composite.height = height;
  const context = composite.getContext('2d')!;
  [...items].sort((a, b) => a.sourceLayer.zIndex - b.sourceLayer.zIndex).forEach(item => {
    let opacity = 1;
    let current: LayerNode | undefined = item.sourceLayer;
    while (current) {
      if (!current.visible) return;
      opacity *= current.opacity ?? 1;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!opacity) return;
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, opacity));
    context.translate(item.left, item.top);
    context.rotate(((item.sourceLayer.rotation ?? 0) * Math.PI) / 180);
    context.drawImage(item.displayCanvas, 0, 0, item.width, item.height);
    context.restore();
  });
  return composite;
};

export const renderPsdPreview = async (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  const artboard = output.artboards[0];
  const items = await Promise.all(output.layers.filter(layer => layer.kind === 'text' || layer.kind === 'image' && layer.source).map(async layer => {
    const local = layerToArtboardCoordinates(layer, artboard);
    const width = Math.max(1, Math.round(layer.width)), height = Math.max(1, Math.round(layer.height));
    const displayCanvas = layer.kind === 'text' ? renderTextCanvas(layer, width, height) : toDisplayCanvas(trimFullCanvasTransparency(await toCanvas(layer.source!), width, height), width, height);
    return { sourceLayer: layer, displayCanvas, left: Math.round(local.x), top: Math.round(local.y), width, height };
  }));
  return composePsdCanvas(output, items, Math.max(1, Math.round(artboard.width)), Math.max(1, Math.round(artboard.height))).toDataURL('image/png');
};

export const exportJson = (document: DocumentState, artboardId?: string, groupId?: string) => {
  const output = createExportDocument(document, artboardId, groupId);
  download(`${safeName(output.artboards[0].name)}-layout.json`, new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
};

export const createPsd = async (document: DocumentState, artboardId?: string, groupId?: string, options: PsdExportOptions = {}) => {
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
      ...(!options.rasterizeText ? { text: {
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
      } } : {}),
    };
    return { sourceLayer: layer, displayCanvas: canvas, left, top, width, height, layer: psdLayer };
  });
  // PSD readers and Windows Explorer use the document composite/thumbnail instead of
  // rebuilding every layer. Without this canvas ag-psd writes an empty black composite.
  const composite = composePsdCanvas(output, [...prepared, ...preparedText], exportWidth, exportHeight);
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
  } as never, { invalidateTextLayers: !options.rasterizeText && options.rebuildTextOnOpen !== false });
  return bytes;
};

export const validatePsdExport = async (document: DocumentState, artboardId?: string, groupId?: string, options: PsdExportOptions = {}) => {
  const bytes = await createPsd(document, artboardId, groupId, options);
  const parsed = readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const info = psdExportInfo(document, artboardId, groupId);
  if (parsed.width !== info.width || parsed.height !== info.height) throw new Error('PSD 尺寸回读不一致。');
  const count = (children: typeof parsed.children): number => (children || []).reduce((sum, layer) => sum + (layer.children ? count(layer.children) : 1), 0);
  if (count(parsed.children) !== info.imageCount + info.textCount) throw new Error('PSD 图层回读数量不一致。');
  const textCount = (children: typeof parsed.children): number => (children || []).reduce((sum, layer) => sum + (layer.children ? textCount(layer.children) : layer.text ? 1 : 0), 0);
  const expectedTextCount = options.rasterizeText ? 0 : info.textCount;
  if (textCount(parsed.children) !== expectedTextCount) throw new Error('PSD 可编辑文字图层回读数量不一致。');
  return { bytes: bytes.byteLength, ...info };
};

export const exportPsd = async (document: DocumentState, artboardId?: string, groupId?: string, options: PsdExportOptions = {}) => {
  const info = psdExportInfo(document, artboardId, groupId);
  const bytes = await createPsd(document, artboardId, groupId, options);
  download(psdFileName(options.fileName || info.name), new Blob([bytes], { type: 'application/octet-stream' }));
};
