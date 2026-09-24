import { strToU8, zipSync } from 'fflate';
import type { DocumentState, LayerNode } from './types';
import { buildEngineLayout, hasInterleavedGroups, orderedEngineLayers, type EngineLayout } from './engineExportModel.ts';

type Engine = 'unity' | 'cocos' | 'godot';
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'canvas';
const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.split(',')[1] || ''), char => char.charCodeAt(0));
const quoted = (value: string) => JSON.stringify(value);
const n = (value: number) => Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
const rgba = (hex: string) => {
  const raw = hex.replace(/^#/, '');
  const expanded = raw.length === 3 || raw.length === 4 ? [...raw].map(c => c + c).join('') : raw;
  const value = /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(expanded) ? expanded : 'ffffff';
  return [0, 2, 4, 6].map((start, index) => index === 3 && value.length === 6 ? 1 : n(parseInt(value.slice(start, start + 2), 16) / 255));
};
const godotColor = (hex: string) => `Color(${rgba(hex).join(', ')})`;

async function imagePng(layer: LayerNode): Promise<Uint8Array> {
  const image = new Image();
  image.src = layer.source!;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(layer.width)); canvas.height = Math.max(1, Math.round(layer.height));
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return bytes(canvas.toDataURL('image/png'));
}

// A native Godot 4 text scene. All coordinates are local to the exported artboard.
export function godotScene(layout: EngineLayout): string {
  const layers = orderedEngineLayers(layout);
  const pathById = new Map<string, string>();
  const globalById = new Map(layout.layers.map(layer => [layer.id, layer]));
  const indexById = new Map([...layout.layers].filter(layer => layer.kind !== 'group').sort((a, b) => a.zIndex - b.zIndex).map((layer, index) => [layer.id, index]));
  const resources = layers.filter(layer => layer.asset).map((layer, index) => `[ext_resource type="Texture2D" path="res://images/${encodeURIComponent(layer.id)}.png" id="${index + 1}"]`);
  const resourceId = new Map(layers.filter(layer => layer.asset).map((layer, index) => [layer.id, index + 1]));
  const textResources: string[] = [];
  layers.filter(layer => layer.kind === 'text').forEach((layer, index) => {
    const style = layer.textStyle || {};
    const fontId = `Font_${index + 1}`;
    const spacing = Math.round(style.letterSpacing || 0);
    textResources.push(`[sub_resource type="SystemFont" id="${fontId}"]`, `font_names = PackedStringArray(${quoted(style.fontFamily || 'Arial')})`, `font_weight = ${style.bold ? 700 : 400}`, `font_italic = ${style.italic ? 'true' : 'false'}`, '');
    const activeFont = spacing ? `Spacing_${index + 1}` : fontId;
    if (spacing) textResources.push(`[sub_resource type="FontVariation" id="${activeFont}"]`, `base_font = SubResource("${fontId}")`, `spacing_glyph = ${spacing}`, '');
    const fontSize = Math.max(1, Math.round(style.fontSize || 24));
    textResources.push(`[sub_resource type="LabelSettings" id="Text_${index + 1}"]`, `font = SubResource("${activeFont}")`, `font_size = ${fontSize}`, `font_color = ${godotColor(style.color || '#ffffff')}`, `line_spacing = ${n(((style.lineHeight || 1.2) - 1) * fontSize)}`, `outline_size = ${Math.max(0, Math.round(style.strokeWidth || 0))}`, `outline_color = ${godotColor(style.strokeColor || '#000000')}`, '');
  });
  const textResourceId = new Map(layers.filter(layer => layer.kind === 'text').map((layer, index) => [layer.id, `Text_${index + 1}`]));
  const usedNames = new Map<string, Set<string>>();
  const output = [`[gd_scene load_steps=${resources.length + textResources.filter(line => line.startsWith('[sub_resource')).length + 1} format=3]`, '', ...resources, '', ...textResources, `[node name=${quoted(layout.name)} type="Control"]`, `offset_right = ${n(layout.width)}`, `offset_bottom = ${n(layout.height)}`, 'mouse_filter = 2', 'clip_contents = true'];
  layers.forEach((layer, index) => {
    const parent = layer.parentId ? globalById.get(layer.parentId) : undefined;
    const parentPath = layer.parentId ? pathById.get(layer.parentId) : undefined;
    const parentKey = parentPath || '.';
    const used = usedNames.get(parentKey) ?? new Set<string>();
    usedNames.set(parentKey, used);
    const baseName = (layer.name || 'Layer').replace(/[/:@]/g, '_');
    let name = baseName;
    for (let suffix = 2; used.has(name); suffix++) name = `${baseName} ${suffix}`;
    used.add(name);
    const path = parentPath ? `${parentPath}/${name}` : name;
    pathById.set(layer.id, path);
    const parentSpecifier = parentPath || '.';
    output.push('', `[node name=${quoted(name)} type="${layer.kind === 'group' ? 'Control' : layer.kind === 'text' ? 'Label' : 'TextureRect'}" parent=${quoted(parentSpecifier)}]`);
    output.push(`offset_left = ${n(layer.x - (parent?.x ?? 0))}`, `offset_top = ${n(layer.y - (parent?.y ?? 0))}`);
    output.push(`offset_right = ${n(layer.x - (parent?.x ?? 0) + layer.width)}`, `offset_bottom = ${n(layer.y - (parent?.y ?? 0) + layer.height)}`);
    output.push('mouse_filter = 2');
    if (!layer.visible) output.push('visible = false');
    if (layer.kind !== 'group') {
      if (layer.rotation) output.push(`rotation = ${n(layer.rotation * Math.PI / 180)}`);
      if (layer.opacity !== 1) output.push(`self_modulate = Color(1, 1, 1, ${n(layer.opacity ?? 1)})`);
      output.push(`z_index = ${Math.min(4096, indexById.get(layer.id) ?? 0)}`, 'z_as_relative = false');
      if (layer.kind === 'image') output.push('expand_mode = 1', 'stretch_mode = 0', `texture = ExtResource("${resourceId.get(layer.id)}")`);
      else if (layer.kind === 'text') {
        const style = layer.textStyle || {};
        output.push(`text = ${quoted(layer.textContent || '')}`, `label_settings = SubResource("${textResourceId.get(layer.id)}")`, `horizontal_alignment = ${style.align === 'center' ? 1 : style.align === 'right' ? 2 : 0}`, `vertical_alignment = ${style.verticalAlign === 'middle' ? 1 : style.verticalAlign === 'bottom' ? 2 : 0}`, 'autowrap_mode = 3', 'clip_text = true');
      }
    }
    output.push(`metadata/layer_id = ${quoted(layer.id)}`);
    if (layer.kind === 'text') output.push(`metadata/text_content = ${quoted(layer.textContent || '')}`);
  });
  return output.join('\n') + '\n';
}

export const unityImporter = `using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

// Drop the exported LayerCanvas folder into Assets. The prefab is rebuilt whenever layout.json changes.
public class LayerCanvasImporter : AssetPostprocessor {
  [Serializable] class Layout { public string name; public float width, height; public Item[] layers; }
  [Serializable] class TextStyle { public string fontFamily, color, align, verticalAlign, strokeColor; public float fontSize, lineHeight, letterSpacing, strokeWidth; public bool bold, italic; }
  [Serializable] class Item { public string id, name, kind, parentId, asset, textContent; public float x, y, width, height, rotation, opacity; public int zIndex; public bool visible, locked; public TextStyle textStyle; }
  static bool importing;
  static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom) {
    if (importing) return;
    foreach (var path in imported) if (path.EndsWith("/layout.json")) { Build(path); break; }
  }
  [MenuItem("Tools/Layer Canvas/Rebuild selected layout")]
  static void Rebuild() { var asset = Selection.activeObject; if (asset != null) Build(AssetDatabase.GetAssetPath(asset)); }
  static void Build(string path) {
    if (!path.EndsWith("/layout.json")) return;
    var json = File.ReadAllText(path);
    var layout = JsonUtility.FromJson<Layout>(json);
    if (layout == null || layout.layers == null) return;
    importing = true;
    try {
      var folder = Path.GetDirectoryName(path).Replace('\\\\', '/');
      var root = new GameObject(layout.name, typeof(RectTransform), typeof(Canvas), typeof(RectMask2D));
      var rect = root.GetComponent<RectTransform>();
      rect.anchorMin = rect.anchorMax = new Vector2(0, 1); rect.pivot = new Vector2(0, 1);
      rect.sizeDelta = new Vector2(layout.width, layout.height);
      root.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;
      var objects = new System.Collections.Generic.Dictionary<string, GameObject>();
      foreach (var item in layout.layers) {
        var go = new GameObject(item.name, typeof(RectTransform));
        objects[item.id] = go;
        var parent = !string.IsNullOrEmpty(item.parentId) && objects.ContainsKey(item.parentId) ? objects[item.parentId] : root;
        go.transform.SetParent(parent.transform, false);
        var r = go.GetComponent<RectTransform>();
        r.anchorMin = r.anchorMax = new Vector2(0, 1); r.pivot = new Vector2(0, 1);
        float px = 0, py = 0;
        foreach (var p in layout.layers) if (p.id == item.parentId) { px = p.x; py = p.y; break; }
        r.anchoredPosition = new Vector2(item.x - px, -item.y + py);
        r.sizeDelta = new Vector2(item.width, item.height);
        if (item.kind != "group") {
          r.localEulerAngles = new Vector3(0, 0, -item.rotation);
          if (item.kind == "text") {
            var style = item.textStyle ?? new TextStyle();
            var label = go.AddComponent<Text>();
            label.text = item.textContent ?? "";
            label.supportRichText = false;
            label.font = FindFont(style.fontFamily);
            label.fontSize = Mathf.Max(1, Mathf.RoundToInt(style.fontSize > 0 ? style.fontSize : 24));
            label.fontStyle = style.bold && style.italic ? FontStyle.BoldAndItalic : style.bold ? FontStyle.Bold : style.italic ? FontStyle.Italic : FontStyle.Normal;
            label.color = ParseColor(style.color, Color.white, item.opacity);
            label.lineSpacing = style.lineHeight > 0 ? style.lineHeight : 1.2f;
            label.horizontalOverflow = HorizontalWrapMode.Wrap;
            label.verticalOverflow = VerticalWrapMode.Truncate;
            label.alignment = Align(style.align, style.verticalAlign);
            label.raycastTarget = false;
            if (style.strokeWidth > 0) {
              var outline = go.AddComponent<Outline>();
              outline.effectColor = ParseColor(style.strokeColor, Color.black, item.opacity);
              outline.effectDistance = new Vector2(style.strokeWidth, -style.strokeWidth);
            }
          } else {
            var image = go.AddComponent<Image>(); image.raycastTarget = false;
            var imagePath = folder + "/" + item.asset;
            var importer = AssetImporter.GetAtPath(imagePath) as TextureImporter;
            if (importer != null && importer.textureType != TextureImporterType.Sprite) {
              importer.textureType = TextureImporterType.Sprite;
              importer.spritePixelsPerUnit = 100;
              importer.SaveAndReimport();
            }
            image.sprite = AssetDatabase.LoadAssetAtPath<Sprite>(imagePath);
            image.color = new Color(1, 1, 1, item.opacity);
          }
          var order = go.AddComponent<Canvas>(); order.overrideSorting = true; order.sortingOrder = Mathf.Clamp(item.zIndex, -32768, 32767);
        }
        go.SetActive(item.visible);
      }
      var prefabPath = folder + "/" + Path.GetFileName(folder) + ".prefab";
      PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
      UnityEngine.Object.DestroyImmediate(root);
      AssetDatabase.ImportAsset(prefabPath);
    } finally { importing = false; }
  }
  static Font FindFont(string family) {
    if (!string.IsNullOrEmpty(family)) foreach (var guid in AssetDatabase.FindAssets("t:Font")) {
      var font = AssetDatabase.LoadAssetAtPath<Font>(AssetDatabase.GUIDToAssetPath(guid));
      if (font != null && string.Equals(font.name, family, StringComparison.OrdinalIgnoreCase)) return font;
    }
    var fallback = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
    return fallback != null ? fallback : Resources.GetBuiltinResource<Font>("Arial.ttf");
  }
  static Color ParseColor(string html, Color fallback, float opacity) {
    if (!string.IsNullOrEmpty(html) && ColorUtility.TryParseHtmlString(html, out var parsed)) fallback = parsed;
    fallback.a *= opacity;
    return fallback;
  }
  static TextAnchor Align(string horizontal, string vertical) {
    if (vertical == "middle") return horizontal == "center" ? TextAnchor.MiddleCenter : horizontal == "right" ? TextAnchor.MiddleRight : TextAnchor.MiddleLeft;
    if (vertical == "bottom") return horizontal == "center" ? TextAnchor.LowerCenter : horizontal == "right" ? TextAnchor.LowerRight : TextAnchor.LowerLeft;
    return horizontal == "center" ? TextAnchor.UpperCenter : horizontal == "right" ? TextAnchor.UpperRight : TextAnchor.UpperLeft;
  }
}`;

export const cocosImporter = `import { _decorator, Color, Component, JsonAsset, Label, LabelOutline, Mask, Node, resources, Sprite, SpriteFrame, UITransform, UIOpacity } from 'cc';
const { ccclass, property, executeInEditMode } = _decorator;
type TextStyle = { fontFamily?:string; fontSize?:number; color?:string; bold?:boolean; italic?:boolean; align?:string; verticalAlign?:string; lineHeight?:number; letterSpacing?:number; strokeColor?:string; strokeWidth?:number };
type Item = { id:string; name:string; kind:string; parentId:string|null; asset?:string; textContent?:string; textStyle?:TextStyle; x:number; y:number; width:number; height:number; zIndex:number; visible:boolean; rotation:number; opacity:number };
type Layout = { name:string; width:number; height:number; layers:Item[] };
// Attach this component to an empty node under a Canvas. It builds editable children in the editor.
@ccclass('LayerCanvasImporter')
@executeInEditMode(true)
export class LayerCanvasImporter extends Component {
  @property({ type: String }) public layoutUrl = '__LAYOUT_URL__';
  start() {
    if (this.node.children.length) return;
    resources.load(this.layoutUrl, JsonAsset, (err, asset) => {
      if (err) { console.error(err); return; }
      const layout = asset.json as Layout;
      const roots = new Map<string, Node>();
      const rootTransform = this.node.getComponent(UITransform) || this.node.addComponent(UITransform);
      rootTransform.setContentSize(layout.width, layout.height); rootTransform.setAnchorPoint(0, 1);
      const mask = this.node.getComponent(Mask) || this.node.addComponent(Mask); mask.type = Mask.Type.RECT;
      for (const item of layout.layers) {
        const parent = item.parentId ? roots.get(item.parentId) || this.node : this.node;
        const node = new Node(item.name); node.setParent(parent); node.layer = this.node.layer;
        roots.set(item.id, node);
        const t = node.addComponent(UITransform); t.setContentSize(item.width, item.height); t.setAnchorPoint(0, 1);
        const p = layout.layers.find(l => l.id === item.parentId);
        node.setPosition(item.x - (p?.x || 0), -item.y + (p?.y || 0));
        node.setRotationFromEuler(0, 0, -item.rotation);
        node.active = item.visible;
        if (item.kind !== 'group') node.addComponent(UIOpacity).opacity = Math.round(item.opacity * 255);
        if (item.kind === 'text') {
          const style = item.textStyle || {};
          const label = node.addComponent(Label);
          label.string = item.textContent || '';
          label.useSystemFont = true;
          label.fontFamily = style.fontFamily || 'Arial';
          label.fontSize = Math.max(1, Math.round(style.fontSize || 24));
          label.lineHeight = Math.max(1, Math.round(label.fontSize * (style.lineHeight || 1.2)));
          label.horizontalAlign = style.align === 'center' ? Label.HorizontalAlign.CENTER : style.align === 'right' ? Label.HorizontalAlign.RIGHT : Label.HorizontalAlign.LEFT;
          label.verticalAlign = style.verticalAlign === 'middle' ? Label.VerticalAlign.CENTER : style.verticalAlign === 'bottom' ? Label.VerticalAlign.BOTTOM : Label.VerticalAlign.TOP;
          label.overflow = Label.Overflow.CLAMP;
          label.enableWrapText = true;
          label.isBold = !!style.bold; label.isItalic = !!style.italic;
          label.spacingX = style.letterSpacing || 0;
          label.color = Color.fromHEX(new Color(), style.color || '#ffffff');
          if ((style.strokeWidth || 0) > 0) {
            const outline = node.addComponent(LabelOutline);
            outline.width = Math.max(1, Math.round(style.strokeWidth || 0));
            outline.color = Color.fromHEX(new Color(), style.strokeColor || '#000000');
          }
        } else if (item.kind === 'image' && item.asset) {
          const sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
          const imageUrl = this.layoutUrl.substring(0, this.layoutUrl.lastIndexOf('/') + 1) + item.asset.replace(/\\.png$/, '') + '/spriteFrame';
          resources.load(imageUrl, SpriteFrame, (error, frame) => {
            if (error) { console.error(error); return; }
            sprite.spriteFrame = frame;
          });
        }
      }
    });
  }
}`;

export async function buildEngineFiles(documentState: DocumentState, engine: Engine, artboardId?: string, groupId?: string): Promise<{ files: Record<string, Uint8Array>; name: string }> {
  const { output, layout } = buildEngineLayout(documentState, artboardId, groupId);
  if (engine === 'cocos' && hasInterleavedGroups(layout)) throw new Error('Cocos 画板中有分组图层与组外图层交错，当前导出无法同时保留层级与绘制顺序。请先调整图层顺序。');
  layout.layers = orderedEngineLayers(layout);
  [...layout.layers].filter(layer => layer.kind !== 'group').sort((a, b) => a.zIndex - b.zIndex).forEach((layer, index) => { layer.zIndex = index; });
  const files: Record<string, Uint8Array> = { 'layout.json': strToU8(JSON.stringify(layout, null, 2)) };
  for (const layer of output.layers) {
    if (layer.kind === 'image' && layer.source) files[`images/${encodeURIComponent(layer.id)}.png`] = await imagePng(layer);
  }
  if (engine === 'godot') {
    files[`${safeName(layout.name)}.tscn`] = strToU8(godotScene(layout));
    files['README.txt'] = strToU8('Godot 4: extract this folder into the project root, then drag the .tscn scene into your main scene. Keep images/ at the project root. Text layers are editable Label nodes with SystemFont and LabelSettings. Install the named font on the target system or replace the font resource in the editor for exact typography.');
  } else if (engine === 'unity') {
    const importerName = `LayerCanvasImporter_${(groupId || output.artboards[0].id).replace(/[^a-zA-Z0-9_]/g, '_')}`;
    files[`Editor/${importerName}.cs`] = strToU8(unityImporter.replaceAll('LayerCanvasImporter', importerName));
    files['README.txt'] = strToU8('Unity: extract the complete folder under Assets. Unity builds a prefab automatically from layout.json. Drag the generated prefab into a scene. Text layers are editable UI.Text components. Import matching Font assets into the project before rebuilding for exact typography. Canvas Scaler/reference resolution is controlled by your project; use the exported width and height for pixel reference.');
  } else {
    const packageName = `layercanvas_${(groupId || output.artboards[0].id).replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const importerName = `LayerCanvasImporter_${(groupId || output.artboards[0].id).replace(/[^a-zA-Z0-9_]/g, '_')}`;
    files[`${importerName}.ts`] = strToU8(cocosImporter.replaceAll('LayerCanvasImporter', importerName).replace('__LAYOUT_URL__', `${packageName}/layout`));
    files['README.txt'] = strToU8(`Cocos Creator 3.8: put layout.json and images/ under assets/resources/${packageName}; put ${importerName}.ts under assets. Add the component to an empty node under Canvas. The hierarchy and editable Label nodes are built in editor mode; after images resolve, drag the root node into Assets to save a prefab. Install the named system fonts on the target system or replace them with project font assets for exact typography.`);
  }
  return { files, name: `${safeName(layout.name)}-${engine}.zip` };
}

export async function exportEngineZip(documentState: DocumentState, engine: Engine, artboardId?: string, groupId?: string): Promise<void> {
  const { files, name } = await buildEngineFiles(documentState, engine, artboardId, groupId);
  const blob = new Blob([zipSync(files)], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
