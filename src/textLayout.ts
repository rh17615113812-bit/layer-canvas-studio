import type { LayerNode } from './types';

let measuringContext: CanvasRenderingContext2D | null | undefined;

/** Program text grows with its contents; the OCR rectangle is only a recognition region. */
export function fitTextLayer(layer: LayerNode): LayerNode {
  if (layer.kind !== 'text') return layer;
  const style = layer.textStyle || {}, fontSize = Math.max(1, style.fontSize || 24);
  const lines = (layer.textContent || '').split(/\r?\n/);
  if (!measuringContext && typeof document !== 'undefined') measuringContext = document.createElement('canvas').getContext('2d');
  const context = measuringContext;
  if (context) context.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontSize}px "${style.fontFamily || 'Arial'}"`;
  const padding = Math.max(0, style.strokeWidth || 0) * 2 + 2;
  const width = Math.ceil(Math.max(1, ...lines.map(line => {
    const characters = [...line];
    const measured = context ? context.measureText(line).width : characters.reduce((sum, character) => sum + fontSize * (/[\u3400-\u9fff]/.test(character) ? 1 : .65), 0);
    return measured + Math.max(0, characters.length - 1) * (style.letterSpacing || 0);
  })) + padding);
  const height = Math.ceil(lines.length * fontSize * Math.max(1, style.lineHeight || 1.2) + padding);
  return layer.width === width && layer.height === height ? layer : { ...layer, width, height };
}
