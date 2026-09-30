/** Non-blocking WebGL 2 elapsed-time queries. Results arrive several frames later.
 * No gl.finish(), synchronous readback, or adapter-name performance guesses.
 */
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
export class GpuTimer {
  private extension: TimerExtension | null = null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  milliseconds: number | null = null;
  measurements = 0;

  private gl: WebGL2RenderingContext;
  constructor(gl: WebGL2RenderingContext) { this.gl = gl; this.restore(); }
  get supported() { return this.extension !== null; }
  restore() {
    this.reset();
    this.extension = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  }
  poll() {
    const gl = this.gl, ext = this.extension;
    if (!ext || gl.isContextLost()) { this.reset(); return; }
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { this.reset(); return; }
    while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = this.pending.shift()!;
      const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) * 1e-6;
      gl.deleteQuery(query);
      if (Number.isFinite(ms) && ms >= 0) {
        this.milliseconds = this.milliseconds === null ? ms : this.milliseconds * .8 + ms * .2;
        this.measurements++;
      }
    }
  }
  begin() {
    this.poll();
    if (!this.extension || this.active || this.pending.length >= 4 || this.gl.isContextLost()) return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query); this.active = query;
  }
  end() {
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active); this.active = null;
  }
  reset() {
    if (this.active) {
      if (this.extension && !this.gl.isContextLost()) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active); this.active = null;
    }
    this.pending.forEach(query => this.gl.deleteQuery(query)); this.pending = [];
    this.milliseconds = null; this.measurements = 0;
  }
  dispose() { this.reset(); }
}
