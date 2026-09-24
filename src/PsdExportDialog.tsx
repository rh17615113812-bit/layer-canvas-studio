import { useEffect, useRef, useState } from 'react';
import type { DocumentState } from './types';
import { exportPsd, psdExportInfo, psdFileName, renderPsdPreview, validatePsdExport } from './exports';

type Props = {
  document: DocumentState;
  artboardId?: string;
  groupId?: string;
  onClose: () => void;
  onExported: (message: string) => void;
};

export default function PsdExportDialog({ document, artboardId, groupId, onClose, onExported }: Props) {
  const info = psdExportInfo(document, artboardId, groupId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState(info.name);
  const [rasterizeText, setRasterizeText] = useState(false);
  const [rebuildTextOnOpen, setRebuildTextOnOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [preview, setPreview] = useState<string>();
  const [previewError, setPreviewError] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const options = { fileName, rasterizeText, rebuildTextOnOpen };

  useEffect(() => {
    inputRef.current?.focus();
    let active = true;
    renderPsdPreview(document, artboardId, groupId)
      .then(value => { if (active) setPreview(value); })
      .catch(error => { if (active) setPreviewError(error instanceof Error ? error.message : '预览生成失败。'); });
    return () => { active = false; };
  }, [document, artboardId, groupId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, busy]);

  const validate = async () => {
    setBusy(true); setResult('正在验证 PSD 结构和图层…');
    try {
      const checked = await validatePsdExport(document, artboardId, groupId, options);
      setResult(`验证通过：${checked.width} × ${checked.height}，${checked.imageCount} 个图片图层、${checked.textCount} 个文字图层，文件约 ${(checked.bytes / 1024 / 1024).toFixed(1)} MB。`);
    } catch (error) {
      setResult(`验证失败：${error instanceof Error ? error.message : '无法生成 PSD。'}`);
    } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setResult('正在生成 PSD…');
    try {
      await exportPsd(document, artboardId, groupId, options);
      onExported(`已导出 ${psdFileName(fileName)}。`);
      onClose();
    } catch (error) {
      setResult(`导出失败：${error instanceof Error ? error.message : '无法生成 PSD。'}`);
    } finally { setBusy(false); }
  };

  return <div className="psd-export-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="psd-export-dialog" role="dialog" aria-modal="true" aria-labelledby="psd-export-title">
      <div className="psd-export-header">
        <span className="psd-export-symbol" aria-hidden="true">⇧</span>
        <div><small>导出</small><strong id="psd-export-title">导出</strong></div>
        <button className="psd-export-close" aria-label="关闭 PSD 导出" disabled={busy} onClick={onClose}>×</button>
      </div>
      <div className="psd-export-body">
        <div className="psd-export-engine"><span>目标引擎</span><b>♧ &nbsp;Photoshop PSD</b></div>
        <section className="psd-export-card">
          <h3>导出目标</h3>
          <p>将导出 1 个文件</p>
          <div className="psd-export-target-head"><span>导出目标</span><span>文件名称</span></div>
          <div className="psd-export-target-row"><b title={info.name}>{info.name}</b><div className="psd-export-name"><input ref={inputRef} aria-label="PSD 文件名称" value={fileName} onChange={event => setFileName(event.target.value)} maxLength={120} /><span>.psd</span></div></div>
        </section>
        <label className="psd-export-option">
          <span><b>文字栅格化（全部像素）</b><small>将全部文字转为像素图层。开启后文字无法在 Photoshop 中继续编辑。</small></span>
          <input type="checkbox" checked={rasterizeText} onChange={event => { setRasterizeText(event.target.checked); setResult(''); }} />
        </label>
        <label className={`psd-export-option${rasterizeText ? ' is-disabled' : ''}`}>
          <span><b>打开时重建文字图层</b><small>仅当关闭“文字栅格化”时生效，让 Photoshop 打开时重建可编辑文字图层。</small></span>
          <input type="checkbox" checked={rebuildTextOnOpen} disabled={rasterizeText} onChange={event => { setRebuildTextOnOpen(event.target.checked); setResult(''); }} />
        </label>
        {result && <p className={`psd-export-result${result.startsWith('验证失败') || result.startsWith('导出失败') ? ' is-error' : ''}`} role="status">{result}</p>}
        <section className="psd-export-card psd-export-preview-card">
          <button className="psd-export-preview-toggle" aria-expanded={previewOpen} onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? '⌄' : '›'} &nbsp;预览</button>
          {previewOpen && <div className="psd-export-preview">
            {preview ? <img src={preview} alt={`${info.name} PSD 导出预览`} /> : <div className="psd-export-preview-status">{previewError || '正在生成预览…'}</div>}
          </div>}
        </section>
      </div>
      <div className="psd-export-footer"><button disabled={busy} onClick={() => void validate()}>验证</button><button className="psd-export-primary" disabled={busy || !fileName.trim()} onClick={() => void save()}>{busy ? '处理中…' : '导出'}</button></div>
    </div>
  </div>;
}
