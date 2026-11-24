import type { ArmRenderer } from '../../renderer';
import { editFrameRange, frameTable, nearest, parseRecording, resample, sample, splitTrack } from '../../teach';
import type { Frame, Preview, Sample } from '../../teach';
import type { Side } from '../../types';

const DEG = Math.PI / 180;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export class TeachDock {
  readonly panel = document.createElement('aside');
  readonly timeline = document.createElement('div');
  private source: Sample[] = [];
  private tracks: Sample[][] = [];
  private frames: Frame[] = [];
  private undoEdit?: { frames: Frame[]; start: number; end: number; clock: number };
  private times: number[] = [];
  private preview: Preview | null = null;
  private request?: AbortController;
  private socket?: WebSocket;
  private capture: Sample[] | null = null;
  private liveGeometry?: { side: number; model: Preview };
  private liveShape?: { side: number; request: AbortController };
  private truncated = false;
  private start = 0;
  private end = 0;
  private clock = 0;
  private playback = 0;

  constructor(workspace: HTMLElement, root: HTMLElement, private renderer: ArmRenderer) {
    this.panel.className = 'teach-dock';
    this.timeline.className = 'timeline-dock teach-timeline';
    this.panel.hidden = this.timeline.hidden = true;
    this.panel.innerHTML = `
      <h2>HostLink 示教</h2>
      <div class="teach-row">
        <label class="btn btn-primary btn-sm">导入 CSV<input type="file" accept=".csv" data-teach="file"></label>
        <button class="btn btn-secondary btn-sm" data-teach="demo">示例轨迹</button>
      </div>
      <details><summary>实时记录</summary>
        <input class="form-input" aria-label="HostLink WebSocket" data-teach="url" value="ws://127.0.0.1:7601">
        <button class="btn btn-secondary btn-sm" data-teach="record">记录 side, q</button>
        <small data-teach="live"></small>
      </details>
      <div class="teach-fields">
        <label>机械臂<select class="form-select" data-teach="side"><option value="0">左臂 · v0=0</option><option value="1">右臂 · v0=1</option></select></label>
        <label><input type="checkbox" data-teach="swap">交换现场左右叫法</label>
        <label data-teach="segments-label" hidden>录制段<select class="form-select" data-teach="segments"></select></label>
        <label>采样间隔 ms<input class="form-input" type="number" min="1" value="120" data-teach="step"></label>
        <label>Pitch °<input class="form-input" type="number" min="-180" max="180" value="0" data-teach="pitch"></label>
        <label><input type="checkbox" data-teach="safe">首帧用 resetSafe</label>
        <label><input type="checkbox" data-teach="tool" checked>圆柱 Tool</label>
        <button class="btn btn-secondary btn-sm" data-teach="resample">重新采样</button>
      </div>
      <h3>七轴姿态</h3>
      <select class="form-select" aria-label="预览姿态来源" data-teach="pose"><option value="recorded">采样姿态</option><option value="planned">规划姿态</option></select>
      <div class="teach-joints">${Array.from({ length: 7 }, (_, i) => `
        <label>J${i}<input type="range" min="-180" max="270" step="0.1" data-teach="joint-${i}" disabled>
        <output data-teach="angle-${i}">—</output></label>`).join('')}</div>
      <button class="btn btn-primary btn-sm" data-teach="export" disabled>导出 MoveSegment</button>
      <p data-teach="status" role="status">导入 CSV、加载示例，或在 Teach 模式下开始记录。</p>`;
    this.timeline.innerHTML = `
      <div class="timeline-controls-bar">
        <button class="btn btn-primary btn-sm" data-teach="play" disabled>播放</button>
        <input type="range" class="timeline-slider" min="0" max="1" step="0.001" value="0" aria-label="查看轨迹姿态" data-teach="scrub" disabled>
        <span data-teach="timing"></span>
      </div>
      <div class="teach-range">
        <span>选段</span>
        <div class="teach-band" data-teach="band">
          <div class="teach-selected" data-teach="selected"></div>
          <button data-teach="from" aria-label="拖动起点" disabled>‹</button>
          <button data-teach="to" aria-label="拖动终点" disabled>›</button>
        </div>
        <span data-teach="range"></span>
        <label>段时长 ms <input class="form-input" type="number" min="1" data-teach="duration"></label>
        <button class="btn btn-secondary btn-sm" data-teach="apply" disabled>应用时长</button>
      </div>
      <div class="teach-range teach-edit-actions">
        <button class="btn btn-secondary btn-sm" data-teach="crop" title="移除选段以外的帧" disabled>裁切到选段</button>
        <button class="btn btn-secondary btn-sm" data-teach="delete" title="删除选段，至少保留两帧" disabled>删除选段</button>
        <button class="btn btn-ghost btn-sm" data-teach="undo" disabled>撤销编辑</button>
      </div>`;
    this.renderer.onPickTeachFrame = (index) => {
      if (!this.visible || !this.preview) return;
      this.stop();
      this.select('pose').value = 'recorded';
      this.seek(this.times[index]);
    };
    workspace.append(this.panel);
    root.append(this.timeline);
    this.input('file').onchange = () => {
      const input = this.input('file');
      const file = input.files?.[0];
      input.value = '';
      if (file) void file.text().then((text) => {
        const parsed = parseRecording(text);
        this.useSamples(parsed.samples, parsed.truncated);
      }).catch((error: Error) => this.status(error.message, true));
    };
    this.button('demo').onclick = () => this.useSamples([0, 1].flatMap((side) => Array.from({ length: 151 }, (_, i) => {
      const t = i / 150;
      return { side, us: i * 20_000, q: [0.7 * t, -0.8 - 0.35 * Math.sin(Math.PI * t), 0.45 * t, 0.9 + 0.3 * Math.sin(Math.PI * t), -0.25 * t, 0.1 * t, 0.2 * t] };
    })));
    this.button('record').onclick = () => this.toggleRecord();
    this.button('resample').onclick = () => this.prepare();
    this.select('side').onchange = () => { if (!this.capture) this.populateTracks(); };
    this.select('segments').onchange = () => this.prepare();
    this.select('pose').onchange = () => this.drawPose();
    this.input('swap').onchange = () => {
      const swaps = this.input('swap').checked;
      this.select('side').options[0].textContent = `${swaps ? '右臂' : '左臂'} · v0=0`;
      this.select('side').options[1].textContent = `${swaps ? '左臂' : '右臂'} · v0=1`;
    };
    for (const name of ['pitch', 'safe', 'tool']) this.input(name).onchange = () => {
      if (this.capture) {
        this.liveShape?.request.abort();
        this.liveShape = this.liveGeometry = undefined;
      } else this.replan();
    };
    this.input('scrub').oninput = () => { this.stop(); this.seek(this.input('scrub').valueAsNumber); };
    this.button('play').onclick = () => this.togglePlay();
    this.button('apply').onclick = () => this.applyDuration();
    this.button('crop').onclick = () => this.editRange('crop');
    this.button('delete').onclick = () => this.editRange('delete');
    this.button('undo').onclick = () => this.restoreEdit();
    this.button('export').onclick = () => this.export();
    for (const end of [false, true]) this.bindHandle(end);
    for (let i = 0; i < 7; i++) {
      const input = this.input(`joint-${i}`);
      input.oninput = () => {
        const current = this.pose();
        if (!current || current.index < 0) return;
        const q = current.q.slice();
        q[i] = input.valueAsNumber * DEG;
        this.element(`angle-${i}`).textContent = `${input.valueAsNumber.toFixed(1)}°`;
        this.drawArm(q);
      };
      input.onchange = () => {
        const current = this.pose();
        if (!current || current.index < 0) return;
        this.rememberEdit();
        this.frames[current.index].q[i] = input.valueAsNumber * DEG;
        this.replan();
      };
    }
  }

  private element(name: string): HTMLElement {
    return (this.panel.querySelector(`[data-teach="${name}"]`) ??
      this.timeline.querySelector(`[data-teach="${name}"]`)) as HTMLElement;
  }
  private input(name: string): HTMLInputElement { return this.element(name) as HTMLInputElement; }
  private select(name: string): HTMLSelectElement { return this.element(name) as HTMLSelectElement; }
  private button(name: string): HTMLButtonElement { return this.element(name) as HTMLButtonElement; }
  private status(message: string, error = false): void {
    this.element('status').textContent = message;
    this.element('status').dataset.error = String(error);
  }
  get visible(): boolean { return !this.panel.hidden; }
  show(visible: boolean): void {
    this.panel.hidden = this.timeline.hidden = !visible;
    this.stop();
    if (visible) { this.drawPaths(); this.drawPose(); }
    else this.renderer.clearTeach();
  }

  private toggleRecord(): void {
    if (this.socket) {
      const captured = this.capture;
      this.socket.close();
      this.socket = undefined;
      this.capture = null;
      this.liveShape?.request.abort();
      this.liveShape = this.liveGeometry = undefined;
      this.button('record').textContent = '记录 side, q';
      if (captured?.length) this.useSamples(captured);
      else { this.sync(); this.drawPaths(); this.drawPose(); }
      return;
    }
    let socket: WebSocket;
    try { socket = new WebSocket(this.input('url').value.trim()); }
    catch { this.status('HostLink WebSocket 地址无效', true); return; }
    this.socket = socket;
    this.capture = [];
    this.sync();
    this.stop();
    this.request?.abort();
    if (this.visible) this.renderer.clearTeach();
    this.button('record').textContent = '停止记录';
    this.element('live').textContent = '连接中…';
    socket.onopen = () => socket.send(JSON.stringify({ op: 'subscribe', topics: ['watch'], watch: ['side, q'], max_hz: 0 }));
    socket.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== socket || !this.capture) return;
      try {
        const data = JSON.parse(event.data);
        if (data.event !== 'watch' || data.name !== 'side, q' || !Array.isArray(data.values)) return;
        const point = sample(data.mcu_us, data.values[0], data.values.slice(1));
        if (!point) return;
        this.capture.push(point);
        if (point.side === Number(this.select('side').value)) this.showLive(point);
        if (this.capture.length % 25 === 1) this.element('live').textContent = `${this.capture.length} 条`;
        if (this.capture.length >= 60_000) this.toggleRecord();
      } catch { /* Non-watch transport messages can be ignored. */ }
    };
    socket.onclose = () => {
      this.element('live').textContent = '连接已关闭';
      if (this.socket === socket) this.toggleRecord();
    };
  }

  private showLive(point: Sample): void {
    if (!this.visible) return;
    const side: Side = point.side === 0 ? 'left' : 'right';
    const pitch = this.input('pitch').valueAsNumber;
    for (let i = 0; i < 7; i++) {
      this.input(`joint-${i}`).disabled = true;
      this.element(`angle-${i}`).textContent = `${(point.q[i] / DEG).toFixed(1)}°`;
    }
    if (this.liveGeometry?.side === point.side) {
      this.renderer.updateTeach(side, this.liveGeometry.model, point.q, pitch * DEG);
      return;
    }
    if (this.liveShape?.side === point.side) return;
    this.liveShape?.request.abort();
    const request = new AbortController();
    this.liveShape = { side: point.side, request };
    const angles = point.q.join(' ');
    const body = `${point.side} 0 ${Number(this.input('tool').checked)} ${pitch} 2\n120 ${angles}\n0 ${angles}`;
    void fetch('/api/teach-preview', { method: 'POST', body, signal: request.signal }).then(async (response) => {
      if (!response.ok) return;
      const model: Preview = await response.json();
      if (!request.signal.aborted && this.capture) this.liveGeometry = { side: point.side, model };
    }).catch(() => {
      if (!request.signal.aborted) this.status('实时读数可用，机械臂模型加载失败。', true);
    });
  }

  private useSamples(samples: Sample[], truncated = false): void {
    this.source = samples;
    this.truncated = truncated;
    if (!samples.some((entry) => entry.side === Number(this.select('side').value))) {
      this.select('side').value = String(samples[0].side);
    }
    this.populateTracks();
  }
  private populateTracks(): void {
    this.tracks = splitTrack(this.source, Number(this.select('side').value));
    const select = this.select('segments');
    const span = (track: Sample[]) => track[track.length - 1].us - track[0].us;
    let longest = 0;
    select.replaceChildren(...this.tracks.map((track, i) => {
      if (span(track) > span(this.tracks[longest])) longest = i;
      return new Option(`第 ${i + 1} 段 · ${(span(track) / 1e6).toFixed(2)} s`, String(i));
    }));
    select.selectedIndex = select.options.length ? longest : -1;
    this.element('segments-label').hidden = this.tracks.length < 2;
    this.prepare();
  }
  private prepare(): void {
    this.undoEdit = undefined;
    try {
      this.frames = resample(this.tracks[this.select('segments').selectedIndex] ?? [], this.input('step').valueAsNumber);
      this.start = this.clock = 0;
      this.end = this.frames.length - 1;
      this.replan();
    } catch (error) {
      this.stop();
      this.request?.abort();
      this.frames = [];
      this.times = [];
      this.preview = null;
      this.sync();
      this.drawPaths();
      this.drawPose();
      this.status((error as Error).message, true);
    }
  }

  private replan(): void {
    if (this.frames.length < 2) return;
    this.stop();
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    let elapsed = 0;
    this.times = this.frames.map((_, i) => {
      if (i) elapsed += Math.floor(this.frames[i - 1].ms / 2) * 2 + 2;
      return elapsed / 1000;
    });
    this.preview = null;
    this.sync();
    this.status('计算轨迹…');
    const pitch = this.input('pitch').valueAsNumber;
    const body = [
      [this.select('side').value, Number(this.input('safe').checked), Number(this.input('tool').checked), pitch, this.frames.length].join(' '),
      ...this.frames.map((frame) => [frame.ms, ...frame.q].join(' ')),
    ].join('\n');
    void fetch('/api/teach-preview', { method: 'POST', body, signal: request.signal }).then(async (response) => {
      if (!response.ok) throw Error(await response.text());
      const result: Preview = await response.json();
      if (request.signal.aborted) return;
      if (result.model?.length !== 7 || result.tcpBasis?.length !== 3) throw Error('请重新编译原生轨迹预览程序');
      this.preview = result;
      this.clock = clamp(this.clock, 0, this.maxTime());
      this.sync();
      this.drawPaths();
      this.drawPose();
      this.status([
        `${this.frames.length} 帧`,
        this.tracks.length > 1 ? `MCU 时间戳回退，已切成 ${this.tracks.length} 段` : '',
        this.truncated ? '已跳过截断末行' : '',
        result.rejected ? `规划拒绝第 ${result.rejected} 帧，可查看采样姿态` : '',
      ].filter(Boolean).join(' · '), !!result.rejected);
    }).catch((error: Error) => {
      if (!request.signal.aborted) {
        this.drawPaths();
        this.drawPose();
        this.status(error.message, true);
      }
    });
  }

  private maxTime(): number {
    return Math.max(this.times[this.times.length - 1] ?? 0, this.preview?.end ?? 0, 0.001);
  }
  private pose(): { q: number[]; index: number } | null {
    if (!this.preview || this.capture) return null;
    if (this.select('pose').value === 'planned' && this.preview.planned.length) {
      const points = this.preview.planned;
      return { q: points[nearest(points, this.clock, (point) => point[0])][4], index: -1 };
    }
    const index = nearest(this.times, this.clock, (time) => time);
    return { q: this.frames[index].q, index };
  }
  private drawArm(q: number[]): void {
    if (!this.visible || !this.preview) return;
    const side: Side = this.select('side').value === '0' ? 'left' : 'right';
    this.renderer.updateTeach(side, this.preview, q, this.input('pitch').valueAsNumber * DEG);
  }
  private drawPose(): void {
    if (!this.visible) return;
    const current = this.pose();
    if (!current) { this.renderer.clearTeach(); }
    else this.drawArm(current.q);
    for (let i = 0; i < 7; i++) {
      const input = this.input(`joint-${i}`);
      const deg = current ? current.q[i] / DEG : 0;
      input.value = String(deg);
      input.disabled = !current || current.index < 0 || (current.index === 0 && this.input('safe').checked);
      this.element(`angle-${i}`).textContent = current ? `${deg.toFixed(1)}°` : '—';
    }
  }
  private drawPaths(): void {
    if (this.visible && this.preview) this.renderer.setTeachPaths(this.preview, this.start, this.end);
  }
  private sync(): void {
    const ready = !!this.preview;
    const ranged = this.frames.length > 1;
    const selectedCount = this.end - this.start + 1;
    this.button('crop').disabled = !ranged || !!this.capture || selectedCount === this.frames.length;
    this.button('delete').disabled = !ranged || !!this.capture || this.frames.length - selectedCount < 2;
    this.button('undo').disabled = !this.undoEdit || !!this.capture;
    for (const name of ['play', 'apply']) this.button(name).disabled = !ready;
    this.button('export').disabled = !ready || !!this.preview?.rejected;
    this.input('scrub').disabled = !ready;
    this.input('scrub').max = String(this.maxTime());
    this.input('scrub').value = String(this.clock);
    this.element('timing').textContent = this.preview ? `末帧提交 ${Math.round(this.preview.submitted * 1000)} ms${this.preview.rejected ? '' : ` · 规划到达 ${Math.round(this.preview.end * 1000)} ms`}` : '';
    this.button('from').disabled = this.button('to').disabled = !ranged;
    this.element('range').textContent = ranged ? `第 ${this.start + 1}–${this.end + 1} 帧` : '';
    this.input('duration').value = ranged ? String(this.frames.slice(this.start, this.end).reduce((sum, frame) => sum + frame.ms, 0)) : '';
    const start = (this.times[this.start] ?? 0) / this.maxTime() * 100;
    const end = (this.times[this.end] ?? 0) / this.maxTime() * 100;
    this.button('from').style.left = this.element('selected').style.left = `${start}%`;
    this.button('to').style.left = `${end}%`;
    this.element('selected').style.width = `${end - start}%`;
  }
  private seek(time: number): void {
    this.clock = clamp(time, 0, this.maxTime());
    this.input('scrub').value = String(this.clock);
    this.drawPose();
  }
  private bindHandle(end: boolean): void {
    const handle = this.button(end ? 'to' : 'from');
    const update = (i: number) => {
      if (end) this.end = clamp(i, this.start + 1, this.frames.length - 1);
      else this.start = clamp(i, 0, this.end - 1);
      this.seek(this.times[end ? this.end : this.start]);
      this.sync();
      this.drawPaths();
    };
    handle.onpointerdown = (event) => { this.stop(); handle.setPointerCapture(event.pointerId); };
    handle.onpointermove = (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const rect = this.element('band').getBoundingClientRect();
      const time = (event.clientX - rect.left) / rect.width * this.maxTime();
      update(nearest(this.times, time, (value) => value));
    };
    handle.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      this.stop();
      update((end ? this.end : this.start) + (event.key === 'ArrowLeft' ? -1 : 1));
    };
  }
  private rememberEdit(): void {
    this.undoEdit = {
      frames: this.frames.map((frame) => ({ q: frame.q.slice(), ms: frame.ms })),
      start: this.start, end: this.end, clock: this.clock,
    };
  }
  private restoreEdit(): void {
    const previous = this.undoEdit;
    if (!previous || this.capture) return;
    this.undoEdit = undefined;
    this.frames = previous.frames;
    this.start = previous.start;
    this.end = previous.end;
    this.clock = previous.clock;
    this.replan();
  }
  private editRange(operation: 'crop' | 'delete'): void {
    if (this.capture) return;
    try {
      const replacement = editFrameRange(this.frames, this.start, this.end, operation);
      this.rememberEdit();
      this.frames = replacement;
      if (operation === 'crop') {
        this.start = 0;
        this.end = this.frames.length - 1;
      } else {
        this.start = clamp(this.start - 1, 0, this.frames.length - 2);
        this.end = this.start + 1;
      }
      this.clock = 0;
      this.replan();
    } catch (error) {
      this.status((error as Error).message, true);
    }
  }
  private applyDuration(): void {
    const duration = this.input('duration').valueAsNumber;
    const intervals = this.end - this.start;
    const other = this.frames.reduce((sum, frame, i) => sum + (i >= this.start && i < this.end ? 0 : frame.ms), 0);
    if (!Number.isInteger(duration) || duration < intervals || duration + other > 600_000) {
      this.status('每个帧间隔至少 1 ms，整段最多 10 分钟', true);
      return;
    }
    this.rememberEdit();
    for (let i = 0; i < intervals; i++) {
      this.frames[this.start + i].ms = Math.floor((i + 1) * duration / intervals) - Math.floor(i * duration / intervals);
    }
    this.replan();
  }
  private togglePlay(): void {
    if (this.playback) { this.stop(); return; }
    if (this.clock >= this.maxTime()) this.clock = 0;
    const start = performance.now() - this.clock * 1000;
    this.button('play').textContent = '暂停';
    const tick = (now: number) => {
      this.seek((now - start) / 1000);
      if (this.clock >= this.maxTime()) this.stop();
      else this.playback = requestAnimationFrame(tick);
    };
    this.playback = requestAnimationFrame(tick);
  }
  private stop(): void {
    cancelAnimationFrame(this.playback);
    this.playback = 0;
    this.button('play').textContent = '播放';
  }
  private export(): void {
    if (!this.preview || this.preview.rejected) return;
    const url = URL.createObjectURL(new Blob([frameTable(this.frames, this.preview.start)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'taught_frames.hpp';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
