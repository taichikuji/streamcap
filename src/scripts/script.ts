import ysFixWebmDuration from "fix-webm-duration";

const CAPTURE_KEYWORDS = /capture|hdmi|elgato|avermedia|cam\s?link|macrosilicon/i;

const TEST_RESOLUTIONS: [number, number][] = [
  [3840, 2160], [2560, 1440], [1920, 1080], [1280, 720],
  [640, 480], [640, 360],
];

const TEST_FRAMERATES = [144, 120, 60, 30, 25];

interface Settings {
  videoDeviceId: string;
  audioDeviceId: string;
  resolution: string;
  framerate: number;
}

class StreamCap {
  private el = {
    video: document.querySelector("#video") as HTMLVideoElement,
    fullscreen: document.querySelector("#fullscreen") as HTMLButtonElement,
    videoSel: document.querySelector("#videoDeviceSelect") as HTMLSelectElement,
    resolution: document.querySelector("#resolutionSelect") as HTMLSelectElement,
    framerate: document.querySelector("#framerateSelect") as HTMLSelectElement,
    audio: document.querySelector("#audioDeviceSelect") as HTMLSelectElement,
    snapshot: document.querySelector("#snapshot") as HTMLElement,
    record: document.querySelector("#record") as HTMLElement,
    reset: document.querySelector("#reset") as HTMLElement,
    status: document.querySelector("#status-message") as HTMLSpanElement,
  };

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private blobs: Blob[] = [];
  private recStart = 0;
  private recMime = "";

  private videoId = "";
  private audioId = "";
  private resolution = "1920x1080";
  private framerate = 30;
  private recording = false;
  private busy = false;

  // resolution → set of supported fps
  private modes = new Map<string, Set<number>>();

  constructor() {
    this.listen();
    this.init();
  }

  // ── Init ────────────────────────────────────────────────────

  private async init() {
    try {
      this.status("Loading...", "loading");

      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Browser doesn't support media devices");

      this.loadSettings();

      if (!this.videoId || !this.audioId || !(await this.deviceExists(this.videoId))) {
        this.status("Detecting devices...", "loading");
        await this.pickDevices();
      }

      this.status("Probing capabilities...", "loading");
      await this.probe();

      this.status("Starting stream...", "loading");
      await this.startStream();

      this.status("Ready", "success", 2000);
    } catch (e: any) {
      this.status(e.message || String(e), "error");
    }
  }

  // ── Device selection ────────────────────────────────────────

  private async pickDevices() {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // Respect whatever the user chose in the browser permission prompt
    const chosenVideo = tmp.getVideoTracks()[0]?.getSettings().deviceId;
    const chosenAudio = tmp.getAudioTracks()[0]?.getSettings().deviceId;
    tmp.getTracks().forEach((t) => t.stop());

    const all = await navigator.mediaDevices.enumerateDevices();
    const vids = all.filter((d) => d.kind === "videoinput");
    const auds = all.filter((d) => d.kind === "audioinput");

    if (!vids.length) throw new Error("No video devices found");

    // User's browser-level choice first, then capture card keyword, then first available
    this.videoId = chosenVideo
      || vids.find((d) => CAPTURE_KEYWORDS.test(d.label))?.deviceId
      || vids[0].deviceId;

    this.audioId = chosenAudio
      || auds.find((d) => d.deviceId !== "default" && d.deviceId !== "communications")?.deviceId
      || auds[0]?.deviceId || "";

    this.save();
  }

  // ── Capability probing ──────────────────────────────────────
  // Opens a test stream at each resolution to discover actual framerates.

  private async probe() {
    this.modes.clear();

    for (const [w, h] of TEST_RESOLUTIONS) {
      let s: MediaStream | null = null;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: this.videoId }, width: { exact: w }, height: { exact: h } },
          audio: false,
        });
        const track = s.getVideoTracks()[0];
        const fps = new Set<number>();

        if (track.getCapabilities) {
          const cap = track.getCapabilities();
          if (cap.frameRate) {
            for (const f of TEST_FRAMERATES) {
              if (cap.frameRate.min! <= f && cap.frameRate.max! >= f) fps.add(f);
            }
          }
        }

        const actual = track.getSettings();
        if (actual.frameRate) fps.add(Math.round(actual.frameRate));
        if (fps.size === 0) fps.add(30);

        this.modes.set(`${w}x${h}`, fps);
      } catch { /* resolution not supported */ }
      finally { s?.getTracks().forEach((t) => t.stop()); }
    }

    if (this.modes.size === 0) this.modes.set("640x480", new Set([30]));
  }

  // ── Stream lifecycle ────────────────────────────────────────

  private async startStream(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;

    try {
      const [w, h] = this.resolution.split("x").map(Number);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: this.videoId },
          width: { ideal: w }, height: { ideal: h },
          frameRate: { ideal: this.framerate },
        },
        audio: {
          deviceId: { exact: this.audioId },
          echoCancellation: false, autoGainControl: false, noiseSuppression: false,
        },
      });

      this.stop();
      this.stream = stream;

      const settings = stream.getVideoTracks()[0].getSettings();
      this.resolution = `${settings.width}x${settings.height}`;
      this.framerate = settings.frameRate ? Math.round(settings.frameRate) : this.framerate;

      const ready = new Promise<void>((r) => { this.el.video.onloadedmetadata = () => r(); });
      this.el.video.srcObject = stream;
      await ready;
      this.el.video.muted = false;

      this.setupRecorder();
      this.updateUI();
      this.save();
      return true;
    } finally {
      this.busy = false;
    }
  }

  private stop() {
    if (!this.stream) return;
    this.el.video.srcObject = null;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async restart() {
    if (this.recording) {
      this.status("Stop recording first", "error", 3000);
      return;
    }
    try {
      this.status("Restarting...", "loading");
      this.stop();
      if (await this.startStream()) {
        this.status("Stream restarted", "success", 2000);
      } else {
        this.status("Stream busy, try again", "error", 3000);
      }
    } catch (e: any) {
      this.status(e.message || "Restart failed", "error");
    }
  }

  // ── Recording ───────────────────────────────────────────────

  private setupRecorder() {
    if (!this.stream) return;
    try {
      const mime = [
        "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus",
        "video/webm", "video/mp4",
      ].find((t) => MediaRecorder.isTypeSupported(t)) || "";

      this.recMime = mime;
      const opts: MediaRecorderOptions = { videoBitsPerSecond: 8_000_000 };
      if (mime) opts.mimeType = mime;

      this.recorder = new MediaRecorder(this.stream, opts);
      this.recorder.ondataavailable = (e) => { if (e.data?.size) this.blobs.push(e.data); };
      this.recorder.onstop = () => this.finishRecording();
      this.recorder.onerror = () => {
        this.recording = false;
        this.el.record.classList.remove("recording");
        this.status("Recording error", "error");
      };
    } catch (e) {
      console.warn("MediaRecorder setup failed:", e);
      this.recorder = null;
    }
  }

  private toggleRecord() {
    if (this.recording) {
      if (this.recorder?.state === "recording") this.recorder.stop();
      this.recording = false;
      this.el.record.classList.remove("recording");
      this.status("Processing...", "loading");
    } else {
      if (!this.recorder || !this.stream) return;
      if (this.recorder.state !== "inactive") this.setupRecorder();
      this.blobs = [];
      this.recStart = Date.now();
      this.recorder!.start(500);
      this.recording = true;
      this.el.record.classList.add("recording");
      this.status("Recording", "success", 2000);
    }
  }

  private finishRecording() {
    const dur = Date.now() - this.recStart;
    const mime = this.recMime || "video/webm";
    const ext = mime.includes("webm") ? "webm" : "mp4";
    const blob = new Blob(this.blobs, { type: mime });
    const name = `recording_${Date.now()}.${ext}`;

    if (mime.includes("webm")) {
      try {
        ysFixWebmDuration(blob, dur, (fixed: Blob) => {
          this.download(URL.createObjectURL(fixed), name);
          this.status("Saved", "success", 2000);
        });
        return;
      } catch { /* fall through */ }
    }
    this.download(URL.createObjectURL(blob), name);
    this.status("Saved", "success", 2000);
  }

  // ── UI ──────────────────────────────────────────────────────

  private updateUI() {
    const allRes = TEST_RESOLUTIONS.map(([w, h]) => {
      const key = `${w}x${h}`;
      return { value: key, label: key, selected: key === this.resolution, disabled: !this.modes.has(key) };
    });
    this.fill(this.el.resolution, allRes);

    const fps = this.modes.get(this.resolution);
    const allFps = TEST_FRAMERATES.map((f) => ({
      value: String(f), label: `${f} fps`, selected: f === this.framerate, disabled: !fps?.has(f),
    }));
    this.fill(this.el.framerate, allFps);

    if (fps && !fps.has(this.framerate)) {
      this.framerate = this.bestFps(this.resolution);
    }

    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const vids = devs.filter((d) => d.kind === "videoinput");
      this.fill(
        this.el.videoSel,
        vids.map((d) => ({ value: d.deviceId, label: this.deviceLabel(d), selected: d.deviceId === this.videoId })),
      );

      const auds = devs.filter((d) => d.kind === "audioinput");
      const cur = this.stream?.getAudioTracks()[0]?.getSettings().deviceId || this.audioId;
      this.fill(
        this.el.audio,
        auds.map((d) => ({ value: d.deviceId, label: this.deviceLabel(d), selected: d.deviceId === cur })),
      );
    }).catch(() => {});
  }

  private fill(
    sel: HTMLSelectElement,
    opts: string[] | { value: string; label: string; selected?: boolean; disabled?: boolean }[],
    selected?: string,
  ) {
    sel.innerHTML = "";
    for (const o of opts) {
      if (typeof o === "string") {
        const el = new Option(o, o);
        if (o === selected) el.selected = true;
        sel.add(el);
      } else {
        const el = new Option(o.label, o.value);
        if (o.selected) el.selected = true;
        if (o.disabled) el.disabled = true;
        sel.add(el);
      }
    }
  }

  // ── Screenshot ──────────────────────────────────────────────

  private screenshot() {
    const v = this.el.video;
    if (!v.videoWidth) { this.status("No video", "error"); return; }
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    this.download(c.toDataURL("image/png"), `screenshot_${Date.now()}.png`);
    this.status("Screenshot saved", "success", 2000);
  }

  // ── Helpers ─────────────────────────────────────────────────

  private async deviceExists(deviceId: string): Promise<boolean> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.some((d) => d.kind === "videoinput" && d.deviceId === deviceId);
    } catch { return false; }
  }

  private bestFps(res: string): number {
    const fps = this.modes.get(res);
    return fps?.size ? Math.max(...fps) : 30;
  }

  private deviceLabel(d: MediaDeviceInfo): string {
    return d.label || d.deviceId.slice(0, 8);
  }

  private download(url: string, name: string) {
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  private status(msg: string, type: "loading" | "error" | "success", ms = 0) {
    const el = this.el.status;
    el.textContent = msg; el.className = type; el.style.display = "inline";
    if (ms > 0) setTimeout(() => { el.textContent = ""; el.style.display = "none"; }, ms);
  }

  private save() { localStorage.setItem("settings", JSON.stringify(this.getSettings())); }

  private getSettings(): Settings {
    return { videoDeviceId: this.videoId, audioDeviceId: this.audioId, resolution: this.resolution, framerate: this.framerate };
  }

  private loadSettings() {
    try {
      const s: Settings = JSON.parse(localStorage.getItem("settings") || "");
      this.videoId = s.videoDeviceId || "";
      this.audioId = s.audioDeviceId || "";
      this.resolution = s.resolution || "1920x1080";
      this.framerate = s.framerate || 30;
    } catch { /* no stored settings */ }
  }

  private fs(el: HTMLElement) {
    const f = el.requestFullscreen || (el as any).webkitRequestFullscreen;
    f?.call(el);
  }

  // ── Events ──────────────────────────────────────────────────

  private listen() {
    this.el.resolution.addEventListener("change", (e) => {
      this.resolution = (e.target as HTMLSelectElement).value;
      if (!this.modes.get(this.resolution)?.has(this.framerate))
        this.framerate = this.bestFps(this.resolution);
      this.save();
      this.restart();
    });

    this.el.framerate.addEventListener("change", (e) => {
      this.framerate = +((e.target as HTMLSelectElement).value);
      this.save();
      this.restart();
    });

    this.el.videoSel.addEventListener("change", async (e) => {
      if (this.recording) { this.status("Stop recording first", "error", 3000); return; }
      try {
        this.videoId = (e.target as HTMLSelectElement).value;
        this.save();
        this.status("Probing new device...", "loading");
        this.stop();
        await this.probe();
        this.resolution = this.modes.keys().next().value || "1920x1080";
        this.framerate = this.bestFps(this.resolution);
        await this.startStream();
        this.status("Device changed", "success", 2000);
      } catch (err: any) {
        this.status(err.message || "Device switch failed", "error");
      }
    });

    this.el.audio.addEventListener("change", (e) => {
      this.audioId = (e.target as HTMLSelectElement).value;
      this.save();
      this.restart();
    });

    this.el.fullscreen.addEventListener("click", () => this.fs(this.el.video));
    this.el.video.addEventListener("dblclick", () => {
      document.fullscreenElement ? document.exitFullscreen() : this.fs(this.el.video);
    });

    this.el.snapshot.addEventListener("click", () => this.screenshot());
    this.el.record.addEventListener("click", () => this.toggleRecord());

    this.el.reset.addEventListener("click", (e) => {
      e.preventDefault();
      if (confirm("Reset all settings?")) { localStorage.clear(); location.reload(); }
    });

    navigator.mediaDevices?.addEventListener("devicechange", async () => {
      if (this.busy) return;
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (!devs.some((d) => d.kind === "videoinput" && d.deviceId === this.videoId)) {
          this.status("Device disconnected", "error");
          this.stop();
          await this.pickDevices();
          await this.probe();
          await this.startStream();
        }
        this.updateUI();
      } catch (e: any) {
        this.status(e.message || "Device recovery failed", "error");
      }
    });
  }
}

new StreamCap();
