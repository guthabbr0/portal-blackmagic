import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Box, Check, ChevronLeft, ChevronRight, Crosshair, Expand, MousePointer2, Move, Pause, Play, RotateCcw, Volume2, SlidersHorizontal, Eye, X } from 'lucide-react';
import { Game, LEVELS, type GameEvent } from './Game';
import './index.css';
import GraphicsPanel from './GraphicsPanel';
import { DEFAULT_GRAPHICS, type GraphicsSettings, type GraphicsStats } from './rendering/PathTracer';

type Screen = 'intro' | 'playing' | 'paused' | 'clear' | 'complete' | 'inspect';

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const screenRef = useRef<Screen>('intro');
  const [screen, setScreen] = useState<Screen>('intro');
  const [graphicsOpen, setGraphicsOpen] = useState(false);
  const [graphics, setGraphics] = useState<GraphicsSettings>({ ...DEFAULT_GRAPHICS });
  const [stats, setStats] = useState<GraphicsStats>({ mode: 'path', samples: 0, bounces: 4, width: 0, height: 0, fps: 0, triangles: 0, lights: 0, supported: true, reason: '', tuning: false, scale: .55, traceMs: null, postMs: null, timerSamples: 0, timingAvailable: false, nodes: 0, packedBytes: 0, buildMs: 0 });
  const [bootError, setBootError] = useState('');
  const [level, setLevel] = useState(0);
  const [selectedLevel, setSelectedLevel] = useState(0);
  const [unlocked, setUnlocked] = useState(0);
  const [hint, setHint] = useState(LEVELS[0].hint);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3400);
  };

  const changeScreen = (next: Screen) => { screenRef.current = next; setScreen(next); };

  useEffect(() => {
    if (!viewportRef.current) return;
    const onGameEvent = (event: GameEvent) => {
      if (event.type === 'hint' && event.text) setHint(event.text);
      if (event.type === 'button' && event.text) showToast(event.text);
      if (event.type === 'level' && event.level !== undefined) {
        if (gameRef.current?.won) {
          setUnlocked(v => Math.max(v, event.level!));
          document.exitPointerLock?.();
          changeScreen('clear');
        } else {
          setLevel(event.level); setSelectedLevel(event.level);
          setHint(LEVELS[event.level].hint);
        }
      }
      if (event.type === 'complete') {
        setUnlocked(4);
        document.exitPointerLock?.();
        changeScreen('complete');
      }
    };
    let game: Game;
    try { game = new Game(viewportRef.current, onGameEvent); }
    catch (error) { setBootError(error instanceof Error ? error.message : String(error)); return; }
    gameRef.current = game;
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __portalGame: Game }).__portalGame = game;
    const statsTimer = setInterval(() => { setStats(game.getGraphicsStats()); setGraphics({ ...game.graphics }); }, 500);
    const resize = () => { if (viewportRef.current) game.resize(viewportRef.current.clientWidth, viewportRef.current.clientHeight); };
    const mouseMove = (e: MouseEvent) => game.mouseMove(e.movementX, e.movementY);
    const mouseDown = (e: MouseEvent) => {
      if (screenRef.current !== 'playing') return;
      if (e.button === 0) game.shoot(0);
      if (e.button === 2) game.shoot(1);
    };
    const contextMenu = (e: MouseEvent) => e.preventDefault();
    const keyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (!e.repeat && e.code === 'KeyG') {
        if (['playing', 'paused', 'inspect'].includes(screenRef.current)) {
          game.playing = false; game.keys.clear(); changeScreen('inspect');
          document.exitPointerLock?.();
        }
        setGraphicsOpen(v => !v); return;
      }
      if (!e.repeat && e.code === 'KeyT') {
        game.configureGraphics({ mode: game.graphics.mode === 'path' ? 'raster' : 'path' });
        setGraphics({ ...game.graphics }); setStats(game.getGraphicsStats()); return;
      }
      if (!e.repeat && e.code === 'KeyP') { game.saveFrame(); showToast('FRAME SAVED'); return; }
      if (e.code === 'Escape' && screenRef.current === 'inspect') { setGraphicsOpen(false); changeScreen('paused'); return; }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      game.keys.add(e.code);
      if (e.repeat) return;
      if (e.code === 'KeyE') game.interact();
      if (e.code === 'KeyR' && screenRef.current === 'playing') { game.loadLevel(game.level); showToast('CHAMBER RESTARTED'); }
    };
    const keyUp = (e: KeyboardEvent) => game.keys.delete(e.code);
    const pointerChange = () => {
      game.locked = document.pointerLockElement === game.renderer.domElement;
      if (!game.locked) game.keys.clear();
      if (!game.locked && screenRef.current === 'playing') { game.playing = false; changeScreen('paused'); }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', mouseMove);
    window.addEventListener('mousedown', mouseDown);
    window.addEventListener('contextmenu', contextMenu);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    document.addEventListener('pointerlockchange', pointerChange);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', mouseMove);
      window.removeEventListener('mousedown', mouseDown);
      window.removeEventListener('contextmenu', contextMenu);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      document.removeEventListener('pointerlockchange', pointerChange);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      clearInterval(statsTimer); game.destroy(); gameRef.current = null;
    };
  }, []);

  const acquirePointer = (game: Game) => {
    const failed = () => { game.playing = false; changeScreen('paused'); showToast('Pointer lock was denied. Click Resume in the game window.'); };
    try {
      // Older implementations return void instead of a Promise.
      Promise.resolve(game.renderer.domElement.requestPointerLock()).catch(failed);
    } catch { failed(); }
  };

  const requestPlay = () => {
    const game = gameRef.current;
    if (!game) return;
    if (screenRef.current === 'intro') game.loadLevel(selectedLevel);
    setGraphicsOpen(false);
    game.playing = true;
    changeScreen('playing');
    acquirePointer(game);
  };

  const startLevel = (index: number) => {
    const game = gameRef.current;
    if (!game) return;
    game.loadLevel(index);
    setLevel(index);
    setGraphicsOpen(false);
    game.playing = true;
    changeScreen('playing');
    acquirePointer(game);
  };

  const reset = () => { gameRef.current?.loadLevel(level); showToast('CHAMBER RESTARTED'); };
  const pause = () => document.exitPointerLock?.();
  const inspect = () => {
    if (gameRef.current) {
      if (screenRef.current === 'intro') gameRef.current.loadLevel(selectedLevel);
      gameRef.current.playing = false; gameRef.current.keys.clear();
    }
    changeScreen('inspect'); document.exitPointerLock?.(); setGraphicsOpen(false);
  };
  const changeGraphics = (change: Partial<GraphicsSettings>) => {
    const game = gameRef.current; if (!game) return;
    game.configureGraphics(change); setGraphics({ ...game.graphics }); setStats(game.getGraphicsStats());
  };

  return (
    <div className={`app-shell is-${screen}`}>
      <div className="game-viewport" ref={viewportRef} />
      <div className="viewport-vignette" />

      <header className="topbar">
        <div className="brand" onClick={() => { if (screen !== 'playing') changeScreen('intro'); }}>
          <div className="brand-mark"><span /><span /><span /><span /></div>
          <div className="brand-text"><strong>APERTURE</strong><small>SCIENCE LABORATORIES</small></div>
        </div>
        <div className="topbar-right">
          <div className="system-label"><span className="live-dot" /> {stats.mode === 'path' ? 'WORLD-SPACE PATH TRACING' : 'FAST / SHADOW MAPS'}</div>
          <button className="graphics-open-button" onClick={() => { if (screen === 'playing') inspect(); setGraphicsOpen(v => !v); }} aria-label="Open graphics settings"><SlidersHorizontal size={16} /><span>GRAPHICS</span><kbd>G</kbd></button>
          {screen === 'playing' && <button className="icon-button pause-button" onClick={pause} aria-label="Pause game"><Pause size={17} fill="currentColor" /></button>}
        </div>
      </header>

      {(screen === 'playing' || screen === 'inspect') && <div className="render-badge"><i className={stats.mode === 'path' ? 'rt' : ''} /><strong>{stats.mode === 'path' ? 'PATH TRACED' : 'RASTER'}</strong><span>{stats.mode === 'path' ? `${stats.bounces} BOUNCES · ${stats.samples} SPP` : 'SHADOW MAPS'}</span><span>{stats.fps} FPS</span></div>}
      {screen === 'playing' && (
        <>
          <div className="crosshair"><span /><span /><span /><span /><i /></div>
          <div className="hud-top"><span className="hud-eyebrow">TEST CHAMBER {String(level + 1).padStart(2, '0')} / 05</span><h2>{LEVELS[level].name}</h2></div>
          <div className="hud-left"><span className="hud-index">0{level + 1}</span><span className="hud-rule" /><span className="hud-objective">{LEVELS[level].objective}</span></div>
          <div className="hud-bottom">
            <div className="hud-controls"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> MOVE</span><span><kbd>SPACE</kbd> JUMP</span><span><kbd>E</kbd> PICK UP / DROP</span><span><kbd>R</kbd> RESTART</span><span><kbd>T</kbd> COMPARE RENDERERS</span><span><kbd>G</kbd> GRAPHICS</span></div>
            <div className="portal-controls"><span><i className="portal-dot blue" /> LEFT CLICK <b>BLUE</b></span><span><i className="portal-dot orange" /> RIGHT CLICK <b>ORANGE</b></span></div>
          </div>
          <div className="help-text">{hint}</div>
          {toast && <div className="toast"><span className="toast-indicator" />{toast}</div>}
        </>
      )}

      {screen === 'intro' && (
        <main className="screen intro-screen">
          <div className="intro-content">
            <div className="eyebrow"><span className="eyebrow-line" /> BLACKMAGIC / LIGHT TRANSPORT <span className="eyebrow-number">/ 001 - 005</span></div>
            <h1>Think with<br /><em>portals.</em></h1>
            <p className="intro-description">Five chambers. One portal device. Real traced light. Bend the space, follow the reflections, and find your way out.</p>
            <div className="intro-actions"><button className="primary-button" onClick={requestPlay}><Play size={16} fill="currentColor" /> BEGIN TESTING <ArrowUpRight size={18} /></button><span className="action-aside">HEADPHONES RECOMMENDED <Volume2 size={15} /></span></div>
            <button className="inspect-link" onClick={inspect}><Eye size={16} /> INSPECT THE LIGHTING <span>Pause. Let the rays converge.</span></button>
          </div>
          <div className="intro-bottom">
            <div className="level-picker">
              <div className="picker-label">SELECT TEST CHAMBER <span>{String(selectedLevel + 1).padStart(2, '0')} / 05</span></div>
              <div className="picker-controls">
                <button onClick={() => setSelectedLevel(v => Math.max(0, v - 1))} disabled={selectedLevel === 0} aria-label="Previous chamber"><ChevronLeft size={18} /></button>
                <div className="picker-title"><span>{LEVELS[selectedLevel].tag}</span><strong>{LEVELS[selectedLevel].name}</strong></div>
                <button onClick={() => setSelectedLevel(v => Math.min(4, v + 1))} disabled={selectedLevel === 4} aria-label="Next chamber"><ChevronRight size={18} /></button>
              </div>
            </div>
            <span className="intro-footnote">A FIRST-PERSON PUZZLE EXPERIMENT<br />BUILT FOR THE BROWSER</span>
          </div>
          <div className="intro-vertical">C H A M B E R &nbsp; / &nbsp; {String(selectedLevel + 1).padStart(2, '0')}</div>
        </main>
      )}

      {screen === 'paused' && (
        <main className="screen modal-screen">
          <div className="modal-content">
            <div className="eyebrow"><span className="eyebrow-line" /> TESTING SUSPENDED</div>
            <h1>On pause<span className="title-period">.</span></h1>
            <p>Chamber {String(level + 1).padStart(2, '0')}: {LEVELS[level].name}. Your progress in this chamber is right where you left it.</p>
            <div className="modal-actions"><button className="primary-button" onClick={requestPlay}><Play size={16} fill="currentColor" /> RESUME TESTING <ArrowRight size={18} /></button><button className="text-button" onClick={reset}><RotateCcw size={16} /> RESTART CHAMBER</button></div>
            <button className="inspect-link" onClick={inspect}><Eye size={16} /> INSPECT LIGHTING / CLEAN VIEW</button>
            <div className="instruction-grid"><div><Move size={19} /><span>WASD to move<br />SPACE to jump</span></div><div><MousePointer2 size={19} /><span>Left / right click<br />to fire portals</span></div><div><Box size={19} /><span>E to pick up<br />or drop objects</span></div><div><Crosshair size={19} /><span>Aim at white<br />portalable panels</span></div></div>
          </div>
          <button className="close-button" onClick={requestPlay} aria-label="Resume"><X size={20} /></button>
        </main>
      )}

      {screen === 'clear' && (
        <main className="screen modal-screen success-screen">
          <div className="modal-content">
            <div className="eyebrow"><span className="eyebrow-line" /> TEST RESULT / SUCCESS</div>
            <div className="result-symbol"><Check size={31} strokeWidth={1.5} /></div>
            <h1>Chamber<br /><em>complete.</em></h1>
            <p>Excellent work. Your ability to follow simple instructions has been noted.</p>
            <div className="modal-actions"><button className="primary-button" onClick={() => startLevel(Math.min(4, level + 1))}>NEXT CHAMBER <ArrowRight size={18} /></button><button className="text-button" onClick={() => startLevel(level)}><RotateCcw size={16} /> REPLAY CHAMBER</button></div>
            <span className="result-counter">{String(level + 1).padStart(2, '0')} / 05 CHAMBERS COMPLETE</span>
          </div>
        </main>
      )}

      {screen === 'complete' && (
        <main className="screen modal-screen success-screen">
          <div className="modal-content"><div className="eyebrow"><span className="eyebrow-line" /> ALL TESTS CONCLUDED</div><div className="result-symbol"><Check size={31} strokeWidth={1.5} /></div><h1>You made<br /><em>it through.</em></h1><p>Five chambers completed. Space was bent. Momentum was preserved. The companion cube appreciates your service.</p><div className="modal-actions"><button className="primary-button" onClick={() => startLevel(0)}>TEST AGAIN <ArrowRight size={18} /></button><button className="text-button" onClick={() => { setSelectedLevel(0); changeScreen('intro'); }}>BACK TO START</button></div><span className="result-counter">05 / 05 CHAMBERS COMPLETE</span></div>
        </main>
      )}

      {screen === 'inspect' && <div className="inspect-toolbar"><div><span className="graphics-kicker">SIMULATION PAUSED</span><strong>{stats.mode === 'path' ? 'Let there be light.' : 'Fast-renderer comparison.'}</strong><small>{stats.mode === 'path' ? 'No temporal smearing. Samples restart when the scene changes.' : 'Shadow maps and a small readability fill. Not ray-traced GI.'}</small></div><button className="text-button" onClick={() => setGraphicsOpen(v => !v)}><SlidersHorizontal size={16} /> GRAPHICS</button><button className="primary-button" onClick={requestPlay}><Play size={14} /> RESUME</button></div>}
      {graphicsOpen && <GraphicsPanel settings={graphics} stats={stats} onChange={changeGraphics} onClose={() => setGraphicsOpen(false)} onTune={() => gameRef.current?.autoTune()} onCapture={() => gameRef.current?.saveFrame()} onReport={() => gameRef.current?.saveDiagnostics()} />}
      {bootError && <div className="boot-error" role="alert"><h2>The renderer could not start.</h2><p>This game needs a desktop browser with WebGL 2 and graphics acceleration enabled.</p><pre>{bootError}</pre><p><a href="?renderer=raster">Retry with the Fast renderer</a> · <a href="/gpu-check.html">Run the independent GPU check</a></p></div>}
      {screen !== 'playing' && screen !== 'inspect' && <footer className="global-footer"><span><Expand size={13} /> IMMERSIVE BROWSER EXPERIENCE</span><span>© APERTURE TESTING INITIATIVE <span className="footer-separator">/</span> ORIGINAL FAN-MADE EXPERIMENT</span></footer>}
      <span className="mobile-note">DESKTOP AND KEYBOARD REQUIRED FOR TESTING</span>
      <div className="sr-only">Unlocked chambers: {unlocked + 1}</div>
    </div>
  );
}
