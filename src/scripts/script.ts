import ysFixWebmDuration from "fix-webm-duration";

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
    statusMessage: document.querySelector("#status-message") as HTMLSpanElement
  };

  private stream: MediaStream;
  private mediaRecorder: MediaRecorder;
  private recordedBlobs: Blob[] = [];
  private startTime: number;
  private videoDeviceId: string;
  private audioDeviceId: string;
  private selectedResolution = "1920x1080";
  private selectedFramerate = 60;
  private manualAudioSelection = false;
  private availableResolutions = new Set<string>();
  private availableFramerates = new Set<number>();
  private isRecording = false;
  private statusTimeout: number | null = null;

  constructor() {
    this.setupEventListeners();
    this.initialize();
  }

  private async initialize() {
    try {
      this.showStatus('StreamCap Loading...', 'loading');
      
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Browser doesn't support MediaDevices API");
      }
      
      this.loadSettings();
      
      if (!this.videoDeviceId || !this.audioDeviceId) {
        this.showStatus('First time setup...', 'loading');
        if (!await this.setupDevices()) return;
        localStorage.setItem("settings", JSON.stringify(this.getSettings()));
      } else {
        await this.detectCapabilities();
      }
      
      this.showStatus('Starting stream...', 'loading');
      if (!await this.loadStream()) return;
      
      this.showStatus('Stream ready', 'success', 2000);
    } catch (e) {
      this.showStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  private showStatus(message: string, type: 'loading' | 'error' | 'success' = 'loading', timeout = 0) {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    
    const { statusMessage } = this.elements;
    statusMessage.textContent = message;
    statusMessage.className = type;
    statusMessage.style.display = 'inline';
    
    if (timeout > 0) {
      this.statusTimeout = setTimeout(() => {
        statusMessage.textContent = '';
        statusMessage.style.display = 'none';
      }, timeout) as number;
    }
  }

  private handleError(context: string, error: any) {
    console.error(`${context}:`, error);
    this.showStatus(`${context}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    return false;
  }

  private getSettings() {
    return { 
      audioDeviceId: this.audioDeviceId, 
      videoDeviceId: this.videoDeviceId, 
      selectedResolution: this.selectedResolution, 
      selectedFramerate: this.selectedFramerate 
    };
  }

  private loadSettings() {
    const settings = localStorage.getItem("settings");
    if (settings) {
      const data = JSON.parse(settings);
      this.videoDeviceId = data.videoDeviceId;
      this.audioDeviceId = data.audioDeviceId;
      this.selectedResolution = data.selectedResolution || "1920x1080";
      this.selectedFramerate = data.selectedFramerate || 60;
    }
  }

  private downloadFile(url, fileName) {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  private async setupDevices() {
    try {
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      const audioDevices = devices.filter(d => d.kind === 'audioinput');
      
      if (videoDevices.length === 0) throw new Error("No video devices found");
      
      const captureDevice = videoDevices.find(d => 
        d.label.toLowerCase().match(/(capture|hdmi|elgato|avermedia|cam link)/)
      );
      this.videoDeviceId = captureDevice?.deviceId || videoDevices[0].deviceId;
      
      const nonDefaultAudio = audioDevices.filter(d => 
        d.deviceId !== 'default' && 
        d.deviceId !== 'communications' &&
        !d.label.toLowerCase().match(/(microphone|mic|línea)/)
      );
      
      const videoName = (captureDevice?.label || "").toLowerCase();
      const matchingAudio = nonDefaultAudio.find(a => 
        videoName && a.label.toLowerCase().includes(videoName.split(' ')[0])
      );
      
      this.audioDeviceId = matchingAudio?.deviceId || 
                      nonDefaultAudio[0]?.deviceId || 
                      (audioDevices.length > 1 ? audioDevices[1].deviceId : audioDevices[0]?.deviceId);
      
      await this.detectCapabilities();
      return true;
    } catch (e) {
      return this.handleError("Device setup error", e);
    }
  }

  private async detectCapabilities() {
    try {
      const testStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: this.videoDeviceId } },
        audio: false
      });
      
      const videoTrack = testStream.getVideoTracks()[0];
      
      if (videoTrack.getCapabilities) {
        this.extractResolutionsAndFramerates(videoTrack.getCapabilities(), videoTrack.getSettings());
      } else {
        this.extractFromSettings(videoTrack.getSettings());
      }
      
      testStream.getTracks().forEach(t => t.stop());
    } catch (e) { console.warn("Failed to detect capabilities:", e); }
    
    this.addFallbackValues();
  }
  
  private extractResolutionsAndFramerates(capabilities, settings) {
    if (capabilities.width && capabilities.height) {
      [[1920, 1080], [1280, 720], [640, 480]].forEach(([w, h]) => {
        if (capabilities.width.min <= w && capabilities.width.max >= w && 
            capabilities.height.min <= h && capabilities.height.max >= h) {
          this.availableResolutions.add(`${w}x${h}`);
        }
      });
      
      if (settings.width && settings.height) {
        this.availableResolutions.add(`${settings.width}x${settings.height}`);
      }
    }
    
    if (capabilities.frameRate) {
      [60, 30, 25].forEach(fps => {
        if (capabilities.frameRate.min <= fps && capabilities.frameRate.max >= fps) {
          this.availableFramerates.add(fps);
        }
      });
      
      if (settings.frameRate) {
        this.availableFramerates.add(Math.round(settings.frameRate));
      }
    }
  }
  
  private extractFromSettings(settings) {
    if (settings.width && settings.height) {
      this.availableResolutions.add(`${settings.width}x${settings.height}`);
    }
    
    if (settings.frameRate) {
      this.availableFramerates.add(Math.round(settings.frameRate));
    }
  }
  
  private addFallbackValues() {
    this.availableResolutions.add('1280x720');
    this.availableResolutions.add('640x480');
    this.availableFramerates.add(30);
    
    if (this.availableResolutions.size === 0) this.availableResolutions.add("640x480");
    if (this.availableFramerates.size === 0) this.availableFramerates.add(30);
  }

  private async loadStream() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      
      if (!devices.some(d => d.kind === 'videoinput' && d.deviceId === this.videoDeviceId)) {
        throw new Error("Video device not found or disconnected");
      }
      
      if (!devices.some(d => d.kind === 'audioinput' && d.deviceId === this.audioDeviceId)) {
        const audioDevice = devices.find(d => d.kind === 'audioinput');
        if (audioDevice) {
          this.audioDeviceId = audioDevice.deviceId;
        } else {
          throw new Error("No audio device found");
        }
      }
      
      if (!this.manualAudioSelection && ['default', 'communications'].includes(this.audioDeviceId)) {
        const betterAudio = devices.find(d => 
          d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId)
        );
        if (betterAudio) this.audioDeviceId = betterAudio.deviceId;
      }
      
      const [width, height] = this.selectedResolution.split('x').map(Number);
      const streamConstraints = {
        video: { 
          width: {ideal: width}, height: {ideal: height}, 
          frameRate: {ideal: this.selectedFramerate}, 
          deviceId: {exact: this.videoDeviceId} 
        },
        audio: { 
          echoCancellation: false, autoGainControl: false, 
          noiseSuppression: false, deviceId: {exact: this.audioDeviceId} 
        }
      };
      
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(streamConstraints);
      } catch (streamError) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: {exact: this.videoDeviceId} },
            audio: { deviceId: {exact: this.audioDeviceId} }
          });
        } catch (minimalError) {
          const errorMsg = minimalError.toString().toLowerCase();
          if (errorMsg.includes("in use")) {
            throw new Error("Device is in use by another application");
          } else if (errorMsg.includes("not found")) {
            throw new Error("Device not found or disconnected");
          }
          throw minimalError;
        }
      }
      
      const videoTrack = this.stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      this.selectedResolution = `${settings.width}x${settings.height}`;
      this.selectedFramerate = settings.frameRate ? Math.round(settings.frameRate) : this.selectedFramerate;
      
      this.elements.video.srcObject = this.stream;
      await new Promise(resolve => this.elements.video.onloadedmetadata = resolve);
      this.setupMediaRecorder();
      this.updateUIControls();
      
      const audioTrack = this.stream.getAudioTracks()[0];
      if (audioTrack && !this.manualAudioSelection) {
        const deviceId = audioTrack.getSettings().deviceId;
        if (deviceId) {
          this.audioDeviceId = deviceId;
          localStorage.setItem("settings", JSON.stringify(this.getSettings()));
        }
      }
      
      return true;
    } catch (e) { 
      return this.handleError("Stream loading error", e); 
    }
  }

  private async restartStream() {
    this.showStatus("Restarting stream...", "loading");
    
    if (this.stream) {
      const audioTrack = this.stream.getAudioTracks()[0];
      if (audioTrack && !this.manualAudioSelection) {
        const deviceId = audioTrack.getSettings().deviceId;
        if (deviceId) { this.audioDeviceId = deviceId; }
      }
      
      this.elements.video.srcObject = null;
      this.stream.getTracks().forEach(track => track.stop());
    }
    
    const result = await this.loadStream();
    if (result) this.showStatus("Stream restarted", "success", 2000);
    return result;
  }

  private setupMediaRecorder() {
    try {
      const mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4'
      ];
      
      const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
      const options = { videoBitsPerSecond: 8000000 };
      if (mimeType) options['mimeType'] = mimeType;
      
      this.mediaRecorder = new MediaRecorder(this.stream, options);
      this.mediaRecorder.ondataavailable = evt => {
        if (evt.data?.size > 0) this.recordedBlobs.push(evt.data);
      };
    } catch (e) {
      console.error("MediaRecorder error:", e);
    }
  }

  private updateUIControls() {
    const { resolution, framerate, audioSelector } = this.elements;
    
    resolution.innerHTML = framerate.innerHTML = audioSelector.innerHTML = "";
    
    this.populateSelector(resolution, 
      Array.from(this.availableResolutions)
        .sort((a, b) => {
          const [widthA] = a.split('x').map(Number);
          const [widthB] = b.split('x').map(Number);
          return widthB - widthA;
        }),
      this.selectedResolution
    );
    
    this.populateSelector(framerate, 
      Array.from(this.availableFramerates)
        .sort((a, b) => b - a)
        .map(fps => fps.toString()),
      this.selectedFramerate.toString()
    );
    
    navigator.mediaDevices.enumerateDevices()
      .then(devices => {
        const audioDevices = devices.filter(d => d.kind === 'audioinput');
        const currentAudioId = this.stream?.getAudioTracks()[0]?.getSettings().deviceId || this.audioDeviceId;
        
        const options = audioDevices.map(device => ({
          value: device.deviceId,
          label: device.label || `Audio device (${device.deviceId.substring(0, 8)}...)`,
          selected: device.deviceId === currentAudioId
        }));
        
        this.populateSelector(audioSelector, options);
      })
      .catch(e => console.warn("Could not enumerate audio devices:", e));
  }
  
  private populateSelector(selectElement: HTMLSelectElement, options: string[] | Array<{value: string, label: string, selected?: boolean}>, selectedValue?: string) {
    selectElement.innerHTML = "";
    
    options.forEach(opt => {
      if (typeof opt === 'string') {
        const option = new Option(opt, opt);
        if (selectedValue === opt) option.selected = true;
        selectElement.add(option);
      } else {
        const option = new Option(opt.label, opt.value);
        if (opt.selected) option.selected = true;
        selectElement.add(option);
      }
    });
  }

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
      this.downloadFile(canvas.toDataURL("image/png"), `screenshot_${Date.now()}.png`);
      this.showStatus("Screenshot saved", "success", 2000);
    } else {
      this.showStatus("Screenshot error: Canvas context error", "error");
    }
  }

  private toggleRecording() {
    if (this.isRecording) this.stopRecording();
    else this.startRecording();
  }

  private startRecording() {
    if (!this.mediaRecorder) {
      this.showStatus("Recording error: Media recorder not initialized", "error");
      return;
    }
    
    this.recordedBlobs = [];
    this.startTime = Date.now();
    
    try {
      this.mediaRecorder.start(500);
      this.isRecording = true;
      this.elements.record.classList.add("recording");
      this.showStatus("Recording started", "success", 2000);
    } catch (e) { 
      this.showStatus(`Recording error: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  private stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== "recording") {
      console.warn("Cannot stop recording - not currently recording");
      return;
    }
    
    this.mediaRecorder.stop();
    this.isRecording = false;
    this.elements.record.classList.remove("recording");
    this.showStatus("Processing recording...", "loading");
    
    const duration = Date.now() - this.startTime;
    const blob = new Blob(this.recordedBlobs, { 
      type: this.mediaRecorder.mimeType || "video/webm" 
    });
    
    try {
      ysFixWebmDuration(blob, duration, fixed => {
        this.downloadFile(URL.createObjectURL(fixed), `recording_${Date.now()}.webm`);
        this.showStatus("Recording saved", "success", 2000);
      });
    } catch (e) {
      console.warn("Could not fix WebM duration:", e);
      this.downloadFile(URL.createObjectURL(blob), `recording_${Date.now()}.webm`);
      this.showStatus("Recording saved (without duration fix)", "success", 2000);
    }
  }

  private setupEventListeners() {
    const { resolution, framerate, audioSelector, fullscreen, video, snapshot, record, reset } = this.elements;
    
    resolution.addEventListener("change", e => {
      this.selectedResolution = (e.target as HTMLSelectElement).value;
      localStorage.setItem("settings", JSON.stringify(this.getSettings()));
      this.restartStream();
    });
    
    framerate.addEventListener("change", e => {
      this.selectedFramerate = parseInt((e.target as HTMLSelectElement).value, 10);
      localStorage.setItem("settings", JSON.stringify(this.getSettings()));
      this.restartStream();
    });
    
    audioSelector.addEventListener("change", e => {
      this.audioDeviceId = (e.target as HTMLSelectElement).value;
      this.manualAudioSelection = true;
      localStorage.setItem("settings", JSON.stringify(this.getSettings()));
      this.restartStream();
    });
    
    fullscreen.addEventListener("click", () => 
      video.requestFullscreen().catch(e => console.error("Fullscreen error:", e)));
    
    video.addEventListener("dblclick", () => {
      if (!document.fullscreenElement) {
        video.requestFullscreen().catch(e => console.error("Fullscreen error:", e));
      } else {
        document.exitFullscreen().catch(e => console.error("Exit fullscreen error:", e));
      }
    });
    
    snapshot.addEventListener("click", () => this.createScreenshot());
    record.addEventListener("click", () => this.toggleRecording());
    
    reset.addEventListener("click", e => {
      e.preventDefault();
      if (confirm("Reset all settings? This will clear your device preferences.")) {
        localStorage.clear();
        window.location.reload();
      }
    });
  }
}

new StreamCap();