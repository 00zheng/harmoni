const startTabBtn = document.getElementById("startTab");
const stopTabBtn = document.getElementById("stopTab");
const fileInput = document.getElementById("fileInput");
const copyBtn = document.getElementById("copyBtn");
const bpmEl = document.getElementById("bpm");
const keyEl = document.getElementById("key");
const statusEl = document.getElementById("status");

let audioCtx = null;
let processor = null;
let stream = null;
let recording = false;
let sampleRate = 44100;
let recorded = [];
let recordedLength = 0;
let maxSeconds = 20;

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

function resetResults() {
  bpmEl.textContent = "—";
  keyEl.textContent = "—";
  copyBtn.disabled = true;
}

function applyResults(result) {
  const bpmText = result.bpm ? result.bpm.toFixed(1) : null;
  const keyText = result.key || null;

  bpmEl.textContent = bpmText || "—";
  keyEl.textContent = keyText || "—";
  copyBtn.disabled = !(bpmText || keyText);
}

function getCopyText() {
  const bpmText = bpmEl.textContent !== "—" ? bpmEl.textContent : null;
  const keyText = keyEl.textContent !== "—" ? keyEl.textContent : null;
  if (!bpmText && !keyText) return null;
  return `BPM: ${bpmText || "N/A"}\nKey: ${keyText || "N/A"}`;
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function stopCapture() {
  recording = false;
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (stream) {
    const tracks = stream.getTracks();
    tracks.forEach((t) => t.stop());
    stream = null;
  }
  stopTabBtn.disabled = true;
  startTabBtn.disabled = false;
}

function startCapture() {
  resetResults();
  setStatus("Capturing audio... hold for about 15-20 seconds.");
  const ctx = ensureAudioContext();

  chrome.tabCapture.capture({ audio: true, video: false }, (capturedStream) => {
    if (chrome.runtime.lastError) {
      setStatus(`Capture failed: ${chrome.runtime.lastError.message}`);
      return;
    }

    stream = capturedStream;
    const source = ctx.createMediaStreamSource(capturedStream);

    recorded = [];
    recordedLength = 0;
    sampleRate = ctx.sampleRate;

    processor = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(ctx.destination);

    recording = true;
    const maxSamples = Math.floor(sampleRate * maxSeconds);

    processor.onaudioprocess = (e) => {
      if (!recording) return;
      const input = e.inputBuffer.getChannelData(0);
      recorded.push(new Float32Array(input));
      recordedLength += input.length;

      if (recordedLength >= maxSamples) {
        stopCapture();
        analyzeRecorded();
      }
    };

    stopTabBtn.disabled = false;
    startTabBtn.disabled = true;
  });
}

function analyzeRecorded() {
  if (!recordedLength) {
    setStatus("No audio captured.");
    return;
  }

  setStatus("Analyzing audio...");
  const buffer = flattenChunks(recorded, recordedLength);
  const result = analyzeBuffer(buffer, sampleRate);
  applyResults(result);
  setStatus("Done.");
}

function flattenChunks(chunks, totalLength) {
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function analyzeFile(file) {
  resetResults();
  setStatus("Decoding file...");
  const arrayBuffer = await file.arrayBuffer();
  const ctx = ensureAudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const channelData = audioBuffer.getChannelData(0);
  const maxSamples = Math.min(channelData.length, Math.floor(audioBuffer.sampleRate * maxSeconds));
  const slice = channelData.subarray(0, maxSamples);

  setStatus("Analyzing audio...");
  const result = analyzeBuffer(slice, audioBuffer.sampleRate);
  applyResults(result);
  setStatus("Done.");
}

function analyzeBuffer(samples, sr) {
  const bpm = estimateBpm(samples, sr);
  const key = estimateKey(samples, sr);
  return { bpm, key };
}

function estimateBpm(samples, sr) {
  const frameSize = 1024;
  const hop = 512;
  const energies = [];

  let prevEnergy = 0;
  for (let i = 0; i + frameSize <= samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = samples[i + j];
      sum += s * s;
    }
    const energy = sum / frameSize;
    const diff = Math.max(0, energy - prevEnergy);
    energies.push(diff);
    prevEnergy = energy;
  }

  const minBpm = 60;
  const maxBpm = 200;
  const minLag = Math.floor((60 * sr) / (hop * maxBpm));
  const maxLag = Math.floor((60 * sr) / (hop * minBpm));

  let bestLag = 0;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = lag; i < energies.length; i++) {
      corr += energies[i] * energies[i - lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (!bestLag) return null;
  const bpm = (60 * sr) / (hop * bestLag);
  return bpm;
}

function estimateKey(samples, sr) {
  const fftSize = 4096;
  const hop = 1024;
  const window = hannWindow(fftSize);

  const chroma = new Float32Array(12);
  let frames = 0;

  for (let i = 0; i + fftSize <= samples.length; i += hop) {
    const frame = samples.subarray(i, i + fftSize);
    const mags = fftMagnitudes(frame, window);

    for (let k = 1; k < mags.length; k++) {
      const freq = (k * sr) / fftSize;
      if (freq < 50 || freq > 2000) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mags[k];
    }
    frames++;
  }

  if (!frames) return null;

  for (let i = 0; i < 12; i++) {
    chroma[i] /= frames;
  }

  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  let best = { key: null, score: -Infinity };
  const labels = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  for (let root = 0; root < 12; root++) {
    const majScore = profileScore(chroma, majorProfile, root);
    if (majScore > best.score) {
      best = { key: `${labels[root]} major`, score: majScore };
    }
    const minScore = profileScore(chroma, minorProfile, root);
    if (minScore > best.score) {
      best = { key: `${labels[root]} minor`, score: minScore };
    }
  }

  return best.key;
}

function profileScore(chroma, profile, root) {
  let score = 0;
  for (let i = 0; i < 12; i++) {
    const idx = (i + root) % 12;
    score += chroma[idx] * profile[i];
  }
  return score;
}

function hannWindow(size) {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return win;
}

function fftMagnitudes(frame, window) {
  const size = frame.length;
  const re = new Float32Array(size);
  const im = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    re[i] = frame[i] * window[i];
  }

  fftInPlace(re, im);

  const mags = new Float32Array(size / 2);
  for (let i = 0; i < mags.length; i++) {
    mags[i] = Math.hypot(re[i], im[i]);
  }
  return mags;
}

function fftInPlace(re, im) {
  const n = re.length;
  const levels = Math.log2(n);
  if (Math.floor(levels) !== levels) {
    throw new Error("FFT size must be power of 2");
  }

  for (let i = 0; i < n; i++) {
    const j = reverseBits(i, levels);
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const tableStep = (Math.PI * 2) / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = i + j;
        const l = k + half;
        const angle = tableStep * j;
        const cos = Math.cos(angle);
        const sin = -Math.sin(angle);

        const tre = re[l] * cos - im[l] * sin;
        const tim = re[l] * sin + im[l] * cos;

        re[l] = re[k] - tre;
        im[l] = im[k] - tim;
        re[k] += tre;
        im[k] += tim;
      }
    }
  }
}

function reverseBits(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y;
}

startTabBtn.addEventListener("click", () => {
  startCapture();
});

stopTabBtn.addEventListener("click", () => {
  stopCapture();
  analyzeRecorded();
});

fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) {
    analyzeFile(file).catch((err) => {
      setStatus(`Failed: ${err.message}`);
    });
  }
});

copyBtn.addEventListener("click", async () => {
  const text = getCopyText();
  if (!text) {
    setStatus("Nothing to copy yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied results to clipboard.");
  } catch (err) {
    setStatus(`Copy failed: ${err.message}`);
  }
});
