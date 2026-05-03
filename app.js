const ui = {
  video: document.getElementById("sourceVideo"),
  canvas: document.getElementById("view"),
  startBtn: document.getElementById("startBtn"),
  resetBtn: document.getElementById("resetBtn"),
  cameraStatus: document.getElementById("cameraStatus"),
  fpsStatus: document.getElementById("fpsStatus"),
  resolutionStatus: document.getElementById("resolutionStatus"),
  controls: {
    seedCount: document.getElementById("seedCount"),
    centerRadius: document.getElementById("centerRadius"),
    falloff: document.getElementById("falloff"),
  },
  values: {
    seedCount: document.getElementById("seedCountValue"),
    centerRadius: document.getElementById("centerRadiusValue"),
    falloff: document.getElementById("falloffValue"),
  },
};

const defaults = {
  seedCount: 900,
  centerRadius: 200,
  falloff: 260,
  processingScale: 0.55,
  fpsCap: 30,
};

const state = {
  stream: null,
  started: false,
  width: 640,
  height: 360,
  frameInterval: 1000 / defaults.fpsCap,
  lastFrameTime: 0,
  lastFpsMark: 0,
  framesSinceMark: 0,
  params: { ...defaults },
  // These flags gate expensive recomputation so we only rebuild when inputs change.
  dirtySeeds: true,
  dirtyMap: true,
  seedBaseX: new Float32Array(0),
  seedBaseY: new Float32Array(0),
  seedDistNorm: new Float32Array(0),
  seedColorR: new Uint8Array(0),
  seedColorG: new Uint8Array(0),
  seedColorB: new Uint8Array(0),
  pixelSeedMap: new Uint16Array(0),
  gridCellSize: 34,
  gridColumns: 0,
  gridRows: 0,
  spatialGrid: [],
  outputImageData: null,
  sourceCtx: null,
  sourceCanvas: document.createElement("canvas"),
};

const viewCtx = ui.canvas.getContext("2d", {
  alpha: false,
  desynchronized: true,
});
// Frequent getImageData reads are central to this effect, so ask the browser to
// optimize this context for readback performance.
state.sourceCtx = state.sourceCanvas.getContext("2d", {
  willReadFrequently: true,
  alpha: false,
});

function setStatus(text) {
  ui.cameraStatus.textContent = `Camera: ${text}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function updateOutputLabels() {
  ui.values.seedCount.textContent = String(state.params.seedCount);
  ui.values.centerRadius.textContent = String(
    Math.round(state.params.centerRadius),
  );
  ui.values.falloff.textContent = String(Math.round(state.params.falloff));
}

function adaptControlRanges() {
  // Tie ranges to the active processing size so controls stay meaningful when
  // adaptive scaling changes the working resolution.
  const diagonal = Math.hypot(state.width / 2, state.height / 2);
  ui.controls.centerRadius.max = String(
    Math.max(120, Math.round(diagonal * 0.95)),
  );
  ui.controls.falloff.max = String(Math.max(220, Math.round(diagonal * 1.15)));
  state.params.centerRadius = clamp(
    state.params.centerRadius,
    Number(ui.controls.centerRadius.min),
    Number(ui.controls.centerRadius.max),
  );
  state.params.falloff = clamp(
    state.params.falloff,
    Number(ui.controls.falloff.min),
    Number(ui.controls.falloff.max),
  );
  ui.controls.centerRadius.value = String(
    Math.round(state.params.centerRadius),
  );
  ui.controls.falloff.value = String(Math.round(state.params.falloff));
  updateOutputLabels();
}

function applyDefaults() {
  state.params = { ...defaults };
  ui.controls.seedCount.value = String(defaults.seedCount);
  ui.controls.centerRadius.value = String(defaults.centerRadius);
  ui.controls.falloff.value = String(defaults.falloff);
  state.frameInterval = 1000 / defaults.fpsCap;
  state.dirtySeeds = true;
  state.dirtyMap = true;
  resizeProcessingBuffers();
  updateOutputLabels();
}

function setProcessingSizeFromVideo() {
  const srcWidth = ui.video.videoWidth || 1280;
  const srcHeight = ui.video.videoHeight || 720;
  const scale = state.params.processingScale;
  // Process at a reduced internal resolution to keep real-time frame rates.
  state.width = Math.max(220, Math.round(srcWidth * scale));
  state.height = Math.max(124, Math.round(srcHeight * scale));
}

function resizeProcessingBuffers() {
  setProcessingSizeFromVideo();
  state.sourceCanvas.width = state.width;
  state.sourceCanvas.height = state.height;
  ui.canvas.width = state.width;
  ui.canvas.height = state.height;
  state.outputImageData = viewCtx.createImageData(state.width, state.height);
  state.dirtyMap = true;
  state.dirtySeeds = true;
  adaptControlRanges();
  ui.resolutionStatus.textContent = `Resolution: ${state.width}x${state.height}`;
}

function buildSeeds() {
  const n = state.params.seedCount;
  const cx = state.width * 0.5;
  const cy = state.height * 0.5;
  const maxDist = Math.hypot(cx, cy);

  state.seedBaseX = new Float32Array(n);
  state.seedBaseY = new Float32Array(n);
  state.seedDistNorm = new Float32Array(n);
  state.seedColorR = new Uint8Array(n);
  state.seedColorG = new Uint8Array(n);
  state.seedColorB = new Uint8Array(n);

  for (let i = 0; i < n; i += 1) {
    // Bias toward radial placement so center-heavy detail is easier to preserve
    // while still keeping enough random seeds to avoid obvious structure.
    const useRadial = Math.random() < 0.82;
    let x;
    let y;

    if (useRadial) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.pow(Math.random(), 1.72) * maxDist;
      x = cx + Math.cos(angle) * radius;
      y = cy + Math.sin(angle) * radius;
    } else {
      x = Math.random() * state.width;
      y = Math.random() * state.height;
    }

    x = clamp(x, 0, state.width - 1);
    y = clamp(y, 0, state.height - 1);

    const distNorm = clamp(Math.hypot(x - cx, y - cy) / maxDist, 0, 1);

    state.seedBaseX[i] = x;
    state.seedBaseY[i] = y;
    state.seedDistNorm[i] = distNorm;
  }

  buildSpatialGrid();
  state.dirtyMap = true;
  state.dirtySeeds = false;
}

function buildSpatialGrid() {
  // Uniform bins keep nearest-seed search practical without full O(seedCount)
  // scans per output pixel.
  const cols = Math.max(1, Math.ceil(state.width / state.gridCellSize));
  const rows = Math.max(1, Math.ceil(state.height / state.gridCellSize));
  state.gridColumns = cols;
  state.gridRows = rows;
  state.spatialGrid = Array.from({ length: cols * rows }, () => []);

  for (let i = 0; i < state.seedBaseX.length; i += 1) {
    const gx = clamp(
      Math.floor(state.seedBaseX[i] / state.gridCellSize),
      0,
      cols - 1,
    );
    const gy = clamp(
      Math.floor(state.seedBaseY[i] / state.gridCellSize),
      0,
      rows - 1,
    );
    state.spatialGrid[gy * cols + gx].push(i);
  }
}

function getNearestSeedIndex(x, y) {
  const gx = clamp(
    Math.floor(x / state.gridCellSize),
    0,
    state.gridColumns - 1,
  );
  const gy = clamp(Math.floor(y / state.gridCellSize), 0, state.gridRows - 1);
  const maxRing = Math.max(state.gridColumns, state.gridRows);
  const searchPaddingRings = 1;

  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  let firstFoundRing = -1;

  for (let ring = 0; ring <= maxRing; ring += 1) {
    let foundAny = false;

    for (let yy = gy - ring; yy <= gy + ring; yy += 1) {
      if (yy < 0 || yy >= state.gridRows) {
        continue;
      }

      for (let xx = gx - ring; xx <= gx + ring; xx += 1) {
        if (xx < 0 || xx >= state.gridColumns) {
          continue;
        }

        const bucket = state.spatialGrid[yy * state.gridColumns + xx];
        if (bucket.length === 0) {
          continue;
        }

        foundAny = true;

        for (let i = 0; i < bucket.length; i += 1) {
          const idx = bucket[i];
          const dx = x - state.seedBaseX[idx];
          const dy = y - state.seedBaseY[idx];
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = idx;
          }
        }
      }
    }

    if (foundAny) {
      if (firstFoundRing === -1) {
        firstFoundRing = ring;
      }

      // Continue a few rings past the first hit so cell borders are not
      // constrained by the acceleration grid's bin boundaries.
      if (ring >= firstFoundRing + searchPaddingRings) {
        break;
      }
    }
  }

  return bestIdx;
}

function buildPixelSeedMap() {
  // Cell ownership is stable across frames, so cache this expensive mapping and
  // reuse it until seed geometry changes.
  const total = state.width * state.height;
  state.pixelSeedMap = new Uint16Array(total);

  let p = 0;
  for (let y = 0; y < state.height; y += 1) {
    for (let x = 0; x < state.width; x += 1) {
      state.pixelSeedMap[p] = getNearestSeedIndex(x, y);
      p += 1;
    }
  }

  state.dirtyMap = false;
}

function updateSeedColors(sourceData) {
  const src = sourceData.data;

  for (let i = 0; i < state.seedBaseX.length; i += 1) {
    const sx = Math.round(state.seedBaseX[i]);
    const sy = Math.round(state.seedBaseY[i]);
    const srcIndex = (sy * state.width + sx) * 4;

    // Blend instead of hard replace so motion feels less noisy and edge regions
    // (higher distNorm) intentionally retain slightly more temporal persistence.
    const targetAlpha = 0.42 + 0.48 * state.seedDistNorm[i];

    state.seedColorR[i] = Math.round(
      state.seedColorR[i] * targetAlpha + src[srcIndex] * (1 - targetAlpha),
    );
    state.seedColorG[i] = Math.round(
      state.seedColorG[i] * targetAlpha + src[srcIndex + 1] * (1 - targetAlpha),
    );
    state.seedColorB[i] = Math.round(
      state.seedColorB[i] * targetAlpha + src[srcIndex + 2] * (1 - targetAlpha),
    );
  }
}

function renderVoronoiFrame() {
  if (!state.outputImageData) {
    return;
  }

  if (state.dirtySeeds) {
    buildWeightedSeeds();
  }

  const srcCtx = state.sourceCtx;

  // Mirror the camera feed so motion feels natural like a front-facing preview.
  srcCtx.setTransform(-1, 0, 0, 1, state.width, 0);

  srcCtx.drawImage(ui.video, 0, 0, state.width, state.height);
  srcCtx.setTransform(1, 0, 0, 1, 0, 0);

  if (state.dirtyMap) {
    buildPixelSeedMap();
  }

  const sourceData = srcCtx.getImageData(0, 0, state.width, state.height);
  updateSeedColors(sourceData);

  const out = state.outputImageData.data;
  const total = state.pixelSeedMap.length;

  for (let i = 0; i < total; i += 1) {
    const seedIndex = state.pixelSeedMap[i];
    const outIndex = i * 4;
    out[outIndex] = state.seedColorR[seedIndex];
    out[outIndex + 1] = state.seedColorG[seedIndex];
    out[outIndex + 2] = state.seedColorB[seedIndex];
    out[outIndex + 3] = 255;
  }

  viewCtx.putImageData(state.outputImageData, 0, 0);
}

function measureFps(now) {
  state.framesSinceMark += 1;

  if (now - state.lastFpsMark > 1000) {
    const fps = Math.round(
      (state.framesSinceMark * 1000) / (now - state.lastFpsMark),
    );
    ui.fpsStatus.textContent = `FPS: ${fps}`;
    state.framesSinceMark = 0;
    state.lastFpsMark = now;

    // Prefer stable motion over detail when the device is under load.
    if (
      fps < state.params.fpsCap * 0.72 &&
      state.params.processingScale > 0.42
    ) {
      state.params.processingScale = Number(
        (state.params.processingScale - 0.04).toFixed(2),
      );
      state.params.processingScale = clamp(
        state.params.processingScale,
        0.42,
        0.7,
      );
      resizeProcessingBuffers();
      state.dirtySeeds = true;
      state.dirtyMap = true;
    }
  }
}

function animate(now) {
  if (!state.started) {
    return;
  }

  requestAnimationFrame(animate);

  if (ui.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  if (now - state.lastFrameTime < state.frameInterval) {
    return;
  }

  state.lastFrameTime = now;

  renderVoronoiFrame();
  measureFps(now);
}

function readControls() {
  state.params.seedCount = Number(ui.controls.seedCount.value);
  state.params.centerRadius = Number(ui.controls.centerRadius.value);
  state.params.falloff = Number(ui.controls.falloff.value);
  state.frameInterval = 1000 / state.params.fpsCap;

  updateOutputLabels();
}

function bindControls() {
  ui.controls.seedCount.addEventListener("input", () => {
    readControls();
    state.dirtySeeds = true;
  });

  ui.controls.centerRadius.addEventListener("input", () => {
    readControls();
    state.dirtySeeds = true;
  });

  ui.controls.falloff.addEventListener("input", () => {
    readControls();
    state.dirtySeeds = true;
  });

  ui.resetBtn.addEventListener("click", () => {
    applyDefaults();
    readControls();
  });
}

function makeSeedWeight(distanceFromCenter) {
  if (distanceFromCenter <= state.params.centerRadius) {
    return 1;
  }

  // Outside the center radius, gradually reduce survival probability so cells
  // get coarser toward the periphery.
  const t =
    (distanceFromCenter - state.params.centerRadius) /
    Math.max(1, state.params.falloff);
  const edgeDrop = clamp(1 - t, 0.18, 1);
  return edgeDrop;
}

function enforceRadialDensity() {
  const cx = state.width * 0.5;
  const cy = state.height * 0.5;
  const maxDist = Math.hypot(cx, cy);
  const survivorsX = [];
  const survivorsY = [];
  const survivorsDist = [];

  for (let i = 0; i < state.seedBaseX.length; i += 1) {
    const x = state.seedBaseX[i];
    const y = state.seedBaseY[i];
    const d = Math.hypot(x - cx, y - cy);
    const keepWeight = makeSeedWeight(d);

    // Keep a floor so sparse parameter combinations still produce a connected
    // field instead of isolated voids.
    if (Math.random() < keepWeight || survivorsX.length < 70) {
      survivorsX.push(x);
      survivorsY.push(y);
      survivorsDist.push(clamp(d / maxDist, 0, 1));
    }
  }

  while (survivorsX.length < state.params.seedCount) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.pow(Math.random(), 1.95) * maxDist;
    const x = clamp(cx + Math.cos(angle) * radius, 0, state.width - 1);
    const y = clamp(cy + Math.sin(angle) * radius, 0, state.height - 1);
    survivorsX.push(x);
    survivorsY.push(y);
    survivorsDist.push(clamp(Math.hypot(x - cx, y - cy) / maxDist, 0, 1));
  }

  const n = state.params.seedCount;
  state.seedBaseX = new Float32Array(n);
  state.seedBaseY = new Float32Array(n);
  state.seedDistNorm = new Float32Array(n);
  state.seedColorR = new Uint8Array(n);
  state.seedColorG = new Uint8Array(n);
  state.seedColorB = new Uint8Array(n);

  for (let i = 0; i < n; i += 1) {
    state.seedBaseX[i] = survivorsX[i];
    state.seedBaseY[i] = survivorsY[i];
    state.seedDistNorm[i] = survivorsDist[i];
  }
}

function buildWeightedSeeds() {
  buildSeeds();
  enforceRadialDensity();
  buildSpatialGrid();
  state.dirtyMap = true;
}

async function startCamera() {
  if (state.started) {
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("unsupported browser");
    return;
  }

  setStatus("requesting permission");

  try {
    const constraints = {
      audio: false,
      video: {
        facingMode: "user",
        // Use higher ideals, then let the processing pipeline downscale as needed.
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };

    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    ui.video.srcObject = state.stream;
    await ui.video.play();

    readControls();
    resizeProcessingBuffers();
    buildWeightedSeeds();

    state.started = true;
    state.lastFrameTime = 0;
    state.lastFpsMark = performance.now();
    state.framesSinceMark = 0;
    setStatus("live");

    requestAnimationFrame(animate);
  } catch (error) {
    if (error && error.name === "NotAllowedError") {
      setStatus("permission denied");
      return;
    }

    if (error && error.name === "NotFoundError") {
      setStatus("no camera detected");
      return;
    }

    setStatus("failed");
    console.error(error);
  }
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  // Debounce layout-driven work to avoid repeated seed/map rebuild churn while
  // the user is actively resizing the viewport.
  resizeTimer = window.setTimeout(() => {
    if (!state.started) {
      return;
    }

    resizeProcessingBuffers();
    buildWeightedSeeds();
  }, 220);
});

ui.startBtn.addEventListener("click", startCamera);
bindControls();
applyDefaults();
setStatus("idle");
ui.fpsStatus.textContent = "FPS: --";
