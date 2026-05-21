import ysFixWebmDuration from "fix-webm-duration";

const CAPTURE_DEVICE_PATTERN = /(capture|hdmi|elgato|avermedia|cam\s?link|macrosilicon)/i;

const CANDIDATE_RESOLUTIONS: [number, number][] = [
  [1920, 1080],
  [1280, 720],
  [640, 480],
];

const CANDIDATE_FRAMERATES = [60, 30, 25];

const MIME_PREFERENCE = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
];

interface StoredSettings {
  videoDeviceId: string;
  audioDeviceId: string;
  selectedResolution: string;
  selectedFramerate: number;
}

class StreamCap {
  private elements = {
    video: document.querySelector("#video") as HTMLVideoElement,
    fullscreen: document.querySelector("#fullscreen") as HTMLButtonElement,
    resolution: document.querySelector("#resolutionSelect") as HTMLSelectElement,
    framerate: document.querySelector("#framerateSelect") as HTMLSelectElement,
    audioSelector: document.querySelector("#audioDeviceSelect") as HTMLSelectElement,
    snapshot: document.querySelector("#snapshot") as HTMLInputElement,
    record: document.querySelector("#record") as HTMLInputElement,
    reset: document.querySelector("#reset") as HTMLLinkElement,
    statusMessage: document.querySelector("#status-message") as HTMLSpanElement,
  };

  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedBlobs: Blob[] = [];
  private recordingStartTime = 0;
  private recordingMime = "";

  private videoDeviceId = "";
  private audioDeviceId = "";
  private selectedResolution = "1920x1080";
  private selectedFramerate = 60;
  private manualAudioSelection = false;

  private availableResolutions = new Set<string>();
  private availableFramerates = new Set<number>();
  private isRecording = false;
  private statusTimeout: ReturnType<typeof setTimeout> | null = null;
  private streamLock = false;

  constructor() {
    this.setupEventListeners();
    this.initialize();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  private async initialize() {
    try {
      this.showStatus("StreamCap Loading...", "loading");

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Browser doesn't support MediaDevices API");
      }

      this.loadSettings();

      if (!this.videoDeviceId || !this.audioDeviceId) {
        this.showStatus("First time setup...", "loading");
        if (!(await this.setupDevices())) return;
        this.persistSettings();
      } else {
        await this.detectCapabilities();
      }

      this.showStatus("Starting stream...", "loading");
      if (!(await this.acquireStream())) return;

      this.showStatus("Stream ready", "success", 2000);
    } catch (e) {
      this.showStatus(
        `Error: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  }

  // ── Settings persistence ────────────────────────────────────

  private getSettings(): StoredSettings {
    return {
      audioDeviceId: this.audioDeviceId,
      videoDeviceId: this.videoDeviceId,
      selectedResolution: this.selectedResolution,
      selectedFramerate: this.selectedFramerate,
    };
  }

  private loadSettings() {
    const raw = localStorage.getItem("settings");
    if (!raw) return;
    try {
      const data: StoredSettings = JSON.parse(raw);
      this.videoDeviceId = data.videoDeviceId || "";
      this.audioDeviceId = data.audioDeviceId || "";
      this.selectedResolution = data.selectedResolution || "1920x1080";
      this.selectedFramerate = data.selectedFramerate || 60;
    } catch {
      localStorage.removeItem("settings");
    }
  }

  private persistSettings() {
    localStorage.setItem("settings", JSON.stringify(this.getSettings()));
  }

  // ── Status display ──────────────────────────────────────────

  private showStatus(
    message: string,
    type: "loading" | "error" | "success" = "loading",
    timeout = 0,
  ) {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }

    const el = this.elements.statusMessage;
    el.textContent = message;
    el.className = type;
    el.style.display = "inline";

    if (timeout > 0) {
      this.statusTimeout = setTimeout(() => {
        el.textContent = "";
        el.style.display = "none";
      }, timeout);
    }
  }

  // ── Error classification ────────────────────────────────────

  private classifyMediaError(err: unknown): string {
    if (!(err instanceof DOMException)) {
      return err instanceof Error ? err.message : String(err);
    }
    switch (err.name) {
      case "NotAllowedError":
        return "Permission denied — allow camera/microphone access and reload";
      case "NotFoundError":
        return "Device not found — check connections and reload";
      case "NotReadableError":
        return "Device is busy or unavailable — close other apps using it";
      case "OverconstrainedError":
        return "Requested resolution/framerate not supported by device";
      case "AbortError":
        return "Device access was interrupted — try again";
      default:
        return err.message || err.name;
    }
  }

  private handleError(context: string, error: unknown): false {
    const message = this.classifyMediaError(error);
    console.error(`${context}:`, error);
    this.showStatus(`${context}: ${message}`, "error");
    return false;
  }

  // ── Device discovery ────────────────────────────────────────

  private async setupDevices(): Promise<boolean> {
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      permissionStream.getTracks().forEach((t) => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      const audioDevices = devices.filter((d) => d.kind === "audioinput");

      if (videoDevices.length === 0)
        throw new Error("No video devices found");

      this.pickVideoDevice(videoDevices);
      this.pickAudioDevice(audioDevices, videoDevices);

      await this.detectCapabilities();
      return true;
    } catch (e) {
      return this.handleError("Device setup failed", e);
    }
  }

  private pickVideoDevice(videoDevices: MediaDeviceInfo[]) {
    const captureDevice = videoDevices.find((d) =>
      CAPTURE_DEVICE_PATTERN.test(d.label),
    );
    this.videoDeviceId = captureDevice?.deviceId || videoDevices[0].deviceId;
  }

  private pickAudioDevice(
    audioDevices: MediaDeviceInfo[],
    videoDevices: MediaDeviceInfo[] = [],
  ) {
    const isVirtual = (d: MediaDeviceInfo) =>
      d.deviceId === "default" ||
      d.deviceId === "communications" ||
      /\b(microphone|mic|línea)\b/i.test(d.label);

    const physical = audioDevices.filter((d) => !isVirtual(d));

    const videoLabel = this.videoDeviceId
      ? videoDevices
          .find((d) => d.deviceId === this.videoDeviceId)
          ?.label?.toLowerCase() || ""
      : "";

    const matchingAudio = videoLabel
      ? physical.find((a) =>
          a.label.toLowerCase().includes(videoLabel.split(" ")[0]),
        )
      : undefined;

    this.audioDeviceId =
      matchingAudio?.deviceId ||
      physical[0]?.deviceId ||
      (audioDevices.length > 1
        ? audioDevices[1].deviceId
        : audioDevices[0]?.deviceId || "");
  }

  // ── Capability detection ────────────────────────────────────

  private async detectCapabilities() {
    this.availableResolutions.clear();
    this.availableFramerates.clear();

    try {
      const testStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: this.videoDeviceId } },
        audio: false,
      });

      const track = testStream.getVideoTracks()[0];

      if (track.getCapabilities) {
        this.extractFromCapabilities(
          track.getCapabilities(),
          track.getSettings(),
        );
      } else {
        this.extractFromSettings(track.getSettings());
      }

      testStream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      console.warn("Capability detection failed:", e);
    }

    this.ensureFallbacks();
  }

  private extractFromCapabilities(
    caps: MediaTrackCapabilities,
    settings: MediaTrackSettings,
  ) {
    if (caps.width && caps.height) {
      for (const [w, h] of CANDIDATE_RESOLUTIONS) {
        if (
          caps.width.min! <= w &&
          caps.width.max! >= w &&
          caps.height.min! <= h &&
          caps.height.max! >= h
        ) {
          this.availableResolutions.add(`${w}x${h}`);
        }
      }
      if (settings.width && settings.height) {
        this.availableResolutions.add(
          `${settings.width}x${settings.height}`,
        );
      }
    }

    if (caps.frameRate) {
      for (const fps of CANDIDATE_FRAMERATES) {
        if (caps.frameRate.min! <= fps && caps.frameRate.max! >= fps) {
          this.availableFramerates.add(fps);
        }
      }
      if (settings.frameRate) {
        this.availableFramerates.add(Math.round(settings.frameRate));
      }
    }
  }

  private extractFromSettings(settings: MediaTrackSettings) {
    if (settings.width && settings.height) {
      this.availableResolutions.add(
        `${settings.width}x${settings.height}`,
      );
    }
    if (settings.frameRate) {
      this.availableFramerates.add(Math.round(settings.frameRate));
    }
  }

  private ensureFallbacks() {
    this.availableResolutions.add("1280x720");
    this.availableResolutions.add("640x480");
    this.availableFramerates.add(30);
  }

  // ── Constraint building & staged fallback ───────────────────

  private buildConstraints(
    width: number,
    height: number,
    fps: number,
  ): MediaStreamConstraints {
    return {
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
        deviceId: { exact: this.videoDeviceId },
      },
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        deviceId: { exact: this.audioDeviceId },
      },
    };
  }

  private buildReducedConstraints(): MediaStreamConstraints {
    return {
      video: {
        deviceId: { exact: this.videoDeviceId },
      },
      audio: {
        deviceId: { exact: this.audioDeviceId },
      },
    };
  }

  private buildMinimalConstraints(): MediaStreamConstraints {
    return {
      video: { deviceId: { exact: this.videoDeviceId } },
      audio: true,
    };
  }

  private async tryGetUserMedia(
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // ── Stream acquisition ──────────────────────────────────────

  private async acquireStream(): Promise<boolean> {
    if (this.streamLock) return false;
    this.streamLock = true;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.validateDevicePresence(devices);

      const [width, height] = this.selectedResolution
        .split("x")
        .map(Number);
      const fps = this.selectedFramerate;

      let stream: MediaStream | null = null;
      let downgraded = false;

      // Stage 1: preferred constraints
      try {
        stream = await this.tryGetUserMedia(
          this.buildConstraints(width, height, fps),
        );
      } catch (e1) {
        console.warn("Preferred constraints failed:", e1);

        // Stage 2: device-only, let browser pick resolution/fps
        try {
          stream = await this.tryGetUserMedia(
            this.buildReducedConstraints(),
          );
          downgraded = true;
        } catch (e2) {
          console.warn("Reduced constraints failed:", e2);

          // Stage 3: minimal — no exact audio device
          try {
            stream = await this.tryGetUserMedia(
              this.buildMinimalConstraints(),
            );
            downgraded = true;
          } catch (e3) {
            throw e3;
          }
        }
      }

      this.teardownStream();
      this.stream = stream;

      const videoTrack = stream.getVideoTracks()[0];
      const actualSettings = videoTrack.getSettings();
      this.selectedResolution = `${actualSettings.width}x${actualSettings.height}`;
      this.selectedFramerate = actualSettings.frameRate
        ? Math.round(actualSettings.frameRate)
        : this.selectedFramerate;

      const metadataReady = new Promise<void>((resolve) => {
        this.elements.video.onloadedmetadata = () => resolve();
      });
      this.elements.video.srcObject = stream;
      await metadataReady;
      this.elements.video.muted = false;

      this.setupMediaRecorder();
      this.updateUIControls();

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack && !this.manualAudioSelection) {
        const id = audioTrack.getSettings().deviceId;
        if (id) this.audioDeviceId = id;
      }

      this.persistSettings();

      if (downgraded) {
        this.showStatus(
          `Stream started at ${this.selectedResolution} @ ${this.selectedFramerate}fps (adjusted)`,
          "success",
          4000,
        );
      }

      return true;
    } catch (e) {
      return this.handleError("Stream failed", e);
    } finally {
      this.streamLock = false;
    }
  }

  private validateDevicePresence(devices: MediaDeviceInfo[]) {
    if (
      !devices.some(
        (d) =>
          d.kind === "videoinput" && d.deviceId === this.videoDeviceId,
      )
    ) {
      throw new DOMException(
        "Video device not found or disconnected",
        "NotFoundError",
      );
    }

    if (
      !devices.some(
        (d) =>
          d.kind === "audioinput" && d.deviceId === this.audioDeviceId,
      )
    ) {
      const fallback = devices.find((d) => d.kind === "audioinput");
      if (!fallback) {
        throw new DOMException("No audio device found", "NotFoundError");
      }
      this.audioDeviceId = fallback.deviceId;
    }

    if (
      !this.manualAudioSelection &&
      ["default", "communications"].includes(this.audioDeviceId)
    ) {
      const better = devices.find(
        (d) =>
          d.kind === "audioinput" &&
          !["default", "communications"].includes(d.deviceId),
      );
      if (better) this.audioDeviceId = better.deviceId;
    }
  }

  private teardownStream() {
    if (!this.stream) return;
    this.elements.video.srcObject = null;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async restartStream() {
    if (this.isRecording) {
      this.showStatus(
        "Stop recording before changing settings",
        "error",
        3000,
      );
      return;
    }

    this.showStatus("Restarting stream...", "loading");
    this.teardownStream();
    const ok = await this.acquireStream();
    if (ok) this.showStatus("Stream restarted", "success", 2000);
  }

  // ── MediaRecorder setup ─────────────────────────────────────

  private setupMediaRecorder() {
    if (!this.stream) return;

    try {
      const mimeType =
        MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const options: MediaRecorderOptions = { videoBitsPerSecond: 8_000_000 };
      if (mimeType) options.mimeType = mimeType;

      this.recordingMime = mimeType;
      this.mediaRecorder = new MediaRecorder(this.stream, options);

      this.mediaRecorder.ondataavailable = (evt) => {
        if (evt.data?.size > 0) this.recordedBlobs.push(evt.data);
      };

      this.mediaRecorder.onstop = () => this.finalizeRecording();

      this.mediaRecorder.onerror = (evt) => {
        console.error("MediaRecorder error:", evt);
        this.showStatus("Recording error occurred", "error");
        this.isRecording = false;
        this.elements.record.classList.remove("recording");
      };
    } catch (e) {
      console.error("MediaRecorder setup failed:", e);
      this.mediaRecorder = null;
    }
  }

  // ── Recording lifecycle ─────────────────────────────────────

  private toggleRecording() {
    if (this.isRecording) this.stopRecording();
    else this.startRecording();
  }

  private startRecording() {
    if (!this.mediaRecorder || !this.stream) {
      this.showStatus("Cannot record: no active stream", "error");
      return;
    }

    if (this.mediaRecorder.state !== "inactive") {
      this.setupMediaRecorder();
      if (!this.mediaRecorder) {
        this.showStatus("Cannot record: recorder init failed", "error");
        return;
      }
    }

    this.recordedBlobs = [];
    this.recordingStartTime = Date.now();

    try {
      this.mediaRecorder.start(500);
      this.isRecording = true;
      this.elements.record.classList.add("recording");
      this.showStatus("Recording started", "success", 2000);
    } catch (e) {
      this.showStatus(
        `Recording error: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  }

  private stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== "recording") {
      return;
    }

    this.mediaRecorder.stop();
    this.isRecording = false;
    this.elements.record.classList.remove("recording");
    this.showStatus("Processing recording...", "loading");
  }

  private finalizeRecording() {
    const duration = Date.now() - this.recordingStartTime;
    const mime = this.recordingMime || "video/webm";
    const isWebm = mime.includes("webm");
    const extension = isWebm ? "webm" : "mp4";

    const blob = new Blob(this.recordedBlobs, { type: mime });
    const filename = `recording_${Date.now()}.${extension}`;

    if (isWebm) {
      try {
        ysFixWebmDuration(blob, duration, (fixed: Blob) => {
          this.downloadFile(URL.createObjectURL(fixed), filename);
          this.showStatus("Recording saved", "success", 2000);
        });
        return;
      } catch (e) {
        console.warn("WebM duration fix failed:", e);
      }
    }

    this.downloadFile(URL.createObjectURL(blob), filename);
    this.showStatus("Recording saved", "success", 2000);
  }

  // ── UI Controls ─────────────────────────────────────────────

  private updateUIControls() {
    const { resolution, framerate, audioSelector } = this.elements;

    this.populateSelector(
      resolution,
      Array.from(this.availableResolutions)
        .sort((a, b) => {
          const [wA] = a.split("x").map(Number);
          const [wB] = b.split("x").map(Number);
          return wB - wA;
        }),
      this.selectedResolution,
    );

    this.populateSelector(
      framerate,
      Array.from(this.availableFramerates)
        .sort((a, b) => b - a)
        .map(String),
      String(this.selectedFramerate),
    );

    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const audioDevices = devices.filter(
          (d) => d.kind === "audioinput",
        );
        const currentAudioId =
          this.stream?.getAudioTracks()[0]?.getSettings().deviceId ||
          this.audioDeviceId;

        const opts = audioDevices.map((d) => ({
          value: d.deviceId,
          label:
            d.label || `Audio device (${d.deviceId.substring(0, 8)}...)`,
          selected: d.deviceId === currentAudioId,
        }));

        this.populateSelector(audioSelector, opts);
      })
      .catch((e) => console.warn("Audio device enumeration failed:", e));
  }

  private populateSelector(
    el: HTMLSelectElement,
    options:
      | string[]
      | Array<{ value: string; label: string; selected?: boolean }>,
    selectedValue?: string,
  ) {
    el.innerHTML = "";

    for (const opt of options) {
      if (typeof opt === "string") {
        const o = new Option(opt, opt);
        if (selectedValue === opt) o.selected = true;
        el.add(o);
      } else {
        const o = new Option(opt.label, opt.value);
        if (opt.selected) o.selected = true;
        el.add(o);
      }
    }
  }

  // ── Screenshot ──────────────────────────────────────────────

  private createScreenshot() {
    const { video } = this.elements;

    if (!video.videoWidth) {
      this.showStatus("Screenshot error: No video playing", "error");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");

    if (ctx) {
      ctx.drawImage(video, 0, 0);
      this.downloadFile(
        canvas.toDataURL("image/png"),
        `screenshot_${Date.now()}.png`,
      );
      this.showStatus("Screenshot saved", "success", 2000);
    } else {
      this.showStatus("Screenshot error: Canvas unavailable", "error");
    }
  }

  // ── Download helper ─────────────────────────────────────────

  private downloadFile(url: string, fileName: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ── Fullscreen compat ─────────────────────────────────────

  private enterFullscreen(el: HTMLElement): Promise<void> {
    const fn =
      el.requestFullscreen ||
      (el as any).webkitRequestFullscreen ||
      (el as any).mozRequestFullScreen ||
      (el as any).msRequestFullscreen;
    return fn
      ? fn.call(el)
      : Promise.reject(new Error("Fullscreen not supported"));
  }

  private leaveFullscreen(): Promise<void> {
    const fn =
      document.exitFullscreen ||
      (document as any).webkitExitFullscreen ||
      (document as any).mozCancelFullScreen ||
      (document as any).msExitFullscreen;
    return fn
      ? fn.call(document)
      : Promise.reject(new Error("Fullscreen not supported"));
  }

  private get isFullscreen(): boolean {
    return !!(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement
    );
  }

  // ── Device-change recovery ──────────────────────────────────

  private onDeviceChange = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();

    const videoStillPresent = devices.some(
      (d) => d.kind === "videoinput" && d.deviceId === this.videoDeviceId,
    );

    if (!videoStillPresent) {
      this.showStatus("Video device disconnected", "error");
      this.teardownStream();

      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      if (videoDevices.length > 0) {
        this.pickVideoDevice(videoDevices);
        this.pickAudioDevice(
          devices.filter((d) => d.kind === "audioinput"),
          videoDevices,
        );
        this.showStatus("Reconnecting to available device...", "loading");
        await this.detectCapabilities();
        await this.acquireStream();
      }
      return;
    }

    const audioStillPresent = devices.some(
      (d) => d.kind === "audioinput" && d.deviceId === this.audioDeviceId,
    );

    if (!audioStillPresent && !this.isRecording) {
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      if (audioDevices.length > 0) {
        this.pickAudioDevice(
          audioDevices,
          devices.filter((d) => d.kind === "videoinput"),
        );
        this.showStatus("Audio device changed, restarting...", "loading");
        await this.restartStream();
      }
    }

    this.updateUIControls();
  };

  // ── Event listeners ─────────────────────────────────────────

  private setupEventListeners() {
    const {
      resolution,
      framerate,
      audioSelector,
      fullscreen,
      video,
      snapshot,
      record,
      reset,
    } = this.elements;

    resolution.addEventListener("change", (e) => {
      this.selectedResolution = (e.target as HTMLSelectElement).value;
      this.persistSettings();
      this.restartStream();
    });

    framerate.addEventListener("change", (e) => {
      this.selectedFramerate = parseInt(
        (e.target as HTMLSelectElement).value,
        10,
      );
      this.persistSettings();
      this.restartStream();
    });

    audioSelector.addEventListener("change", (e) => {
      this.audioDeviceId = (e.target as HTMLSelectElement).value;
      this.manualAudioSelection = true;
      this.persistSettings();
      this.restartStream();
    });

    fullscreen.addEventListener("click", () =>
      this.enterFullscreen(video).catch((e) =>
        console.error("Fullscreen error:", e),
      ),
    );

    video.addEventListener("dblclick", () => {
      if (!this.isFullscreen) {
        this.enterFullscreen(video).catch((e) =>
          console.error("Fullscreen error:", e),
        );
      } else {
        this.leaveFullscreen().catch((e) =>
          console.error("Exit fullscreen error:", e),
        );
      }
    });

    snapshot.addEventListener("click", () => this.createScreenshot());
    record.addEventListener("click", () => this.toggleRecording());

    reset.addEventListener("click", (e) => {
      e.preventDefault();
      if (
        confirm("Reset all settings? This will clear your device preferences.")
      ) {
        localStorage.clear();
        window.location.reload();
      }
    });

    navigator.mediaDevices?.addEventListener(
      "devicechange",
      this.onDeviceChange,
    );
  }
}

new StreamCap();
