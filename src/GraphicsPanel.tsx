import { Camera, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { QUALITY, type GraphicsSettings, type GraphicsStats, type Quality } from './rendering/PathTracer';

type Props = {
  settings: GraphicsSettings; stats: GraphicsStats;
  onChange: (change: Partial<GraphicsSettings>) => void;
  onClose: () => void; onTune: () => void; onCapture: () => void; onReport: () => void;
};
const labels: Record<Quality, [string, string]> = {
  economy: ['Economy', '2 bounces · lighter GPU load'],
  balanced: ['Balanced', '4 bounces · interactive'],
  high: ['High', '6 bounces · unclamped HDR'],
  reference: ['Reference', '8 bounces · let it converge'],
};
export default function GraphicsPanel({ settings, stats, onChange, onClose, onTune, onCapture, onReport }: Props) {
  return <aside className="graphics-panel" role="dialog" aria-modal="false" aria-label="Graphics and ray tracing settings">
    <div className="graphics-heading"><div><span className="graphics-kicker">LIGHT TRANSPORT / 01</span><h2>Blackmagic lab<span>.</span></h2></div><button className="icon-button" onClick={onClose} aria-label="Close graphics"><X size={17} /></button></div>
    <p className="graphics-intro">No invented bounce light. Follow the rays.</p>
    <div className="renderer-choice" aria-label="Renderer">
      <button className={settings.mode === 'path' ? 'selected' : ''} disabled={!stats.supported} onClick={() => onChange({ mode: 'path' })}><Sparkles size={16} /><strong>Path traced</strong><small>World-space rays</small></button>
      <button className={settings.mode === 'raster' ? 'selected' : ''} onClick={() => onChange({ mode: 'raster' })}><SlidersHorizontal size={16} /><strong>Fast</strong><small>Raster + shadow maps</small></button>
    </div>
    {stats.reason && <p className="graphics-warning" role="status">{stats.reason}</p>}
    <div className="trace-readout"><div><span className="graphics-kicker">{settings.mode === 'path' ? 'ACCUMULATED SAMPLES / PIXEL' : 'PRESENTED FRAMES / SECOND'}</span><strong>{settings.mode === 'path' ? stats.samples : stats.fps}<small>{settings.mode === 'path' ? ` / ${QUALITY[settings.quality].samples}` : ' fps'}</small></strong></div><span className={'trace-state ' + (stats.samples > 24 ? 'settled' : '')}>{settings.mode === 'raster' ? 'FAST' : stats.samples < 3 ? 'TRACING' : 'CONVERGING'}</span></div>
    <div className="quality-heading"><span>QUALITY PRESET</span><span>{stats.fps} FPS</span></div>
    <div className="quality-grid">{(Object.keys(QUALITY) as Quality[]).map(quality => <button key={quality} className={settings.quality === quality ? 'selected' : ''} aria-pressed={settings.quality === quality} onClick={() => onChange({ quality, ...(quality === 'reference' ? { adaptive: false, denoise: false } : {}) })}><strong>{labels[quality][0]}</strong><small>{labels[quality][1]}</small></button>)}</div>
    <div className="graphics-specs"><span>Internal render <b>{stats.width} × {stats.height}</b></span><span>Scene triangles <b>{stats.triangles.toLocaleString()}</b></span><span>Surface bounces <b>{stats.bounces}</b></span><span>SAH BVH nodes <b>{stats.nodes.toLocaleString()}</b></span><span>Packed BVH / geometry <b>{(stats.packedBytes / 1e6).toFixed(2)} MB</b></span><span>CPU scene preparation <b>{stats.buildMs.toFixed(1)} ms</b></span><span>GPU trace <b>{stats.traceMs === null ? 'Not measured' : `${stats.traceMs.toFixed(2)} ms`}</b></span><span>GPU filter + display <b>{stats.postMs === null ? 'Not measured' : `${stats.postMs.toFixed(2)} ms`}</b></span></div>
    <label className="exposure-label" htmlFor="exposure">EXPOSURE <b>{settings.exposure.toFixed(2)}</b></label>
    <input id="exposure" type="range" min="0.3" max="2.5" step="0.05" value={settings.exposure} onChange={event => onChange({ exposure: Number(event.target.value) })} />
    <label className="graphics-toggle"><span><strong>Spatial denoise</strong><small>At trace resolution; HDR edge-aware upscale. Not GI.</small></span><input type="checkbox" checked={settings.denoise} onChange={e => onChange({ denoise: e.target.checked })} disabled={settings.mode !== 'path'} /></label>
    <label className="graphics-toggle"><span><strong>Adaptive resolution</strong><small>{stats.timingAvailable ? 'Delayed GPU timing. Target budget: 33 ms.' : 'Frame-interval fallback. Target: 30 fps.'}</small></span><input type="checkbox" checked={settings.adaptive} onChange={e => onChange({ adaptive: e.target.checked })} disabled={settings.mode !== 'path' || settings.quality === 'reference'} /></label>
    <div className="graphics-actions"><button onClick={onTune} disabled={!stats.supported || stats.tuning}>{stats.tuning ? 'MEASURING SCENE…' : 'MEASURE / AUTO TUNE'}</button><button onClick={onCapture} aria-label="Save a PNG frame"><Camera size={17} /> PNG</button></div>
    <button className="diagnostics-button" onClick={onReport}>SAVE DIAGNOSTICS JSON</button><p className="graphics-note">Path tracing computes reflections, visibility and indirect light from scene geometry. Stand still to accumulate a cleaner image. Movement resets history rather than smearing old light.</p>
    <div className="graphics-limits">GPU software tracing, not an RTX API. SAH AABB hierarchy, not UBVH. Timing is delayed; memory above excludes atlas and render targets. Up to 8 portal crossings. Economy and Balanced clamp bright outliers; High and Reference do not. Fast mode is not ray-traced GI.</div>
  </aside>;
}
