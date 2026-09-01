const SETTINGS_KEY = 'local-image-compressor-settings';
const VIDEO_SETTINGS_KEY = 'local-video-compressor-settings';
const state = {
  files: [],
  outputFolder: null,
  busy: false,
  settingsLoaded: false,
  jobId: null,
  stopRequested: false,
  saveTimer: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  files: $('fileList'), count: $('fileCount'), status: $('status'), compress: $('compress'),
  level: $('level'), levelValue: $('levelValue'), resize: $('resizeEnabled'),
  maxDimension: $('maxDimension'), fixed: $('fixedOutputRow'), folderLabel: $('outputFolderLabel'),
  preservePng: $('preservePng'), pngAlphaOption: $('pngAlphaOption'),
  progress: $('progressCard'), progressText: $('progressText'), percent: $('progressPercent'),
  bar: $('progressBar'), current: $('currentFile'), stop: $('stopCompress'), scan: $('scanLabel'),
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

function baseName(filePath) { return String(filePath).split(/[/\\]/).pop(); }
function hasPngFiles() { return state.files.some((file) => String(file.path).toLowerCase().endsWith('.png')); }

function updatePngOption() {
  const enabled = hasPngFiles();
  els.pngAlphaOption.hidden = false;
  els.preservePng.disabled = !enabled;
  els.pngAlphaOption.classList.toggle('disabled-option', !enabled);
}

function renderFiles() {
  els.count.textContent = state.files.length;
  els.compress.disabled = !state.files.length || state.busy;
  updatePngOption();

  if (!state.files.length) {
    els.files.innerHTML = '<div class="empty"><span>▧</span><p>还没有添加图片</p><small>选择图片，或导入文件夹自动扫描</small></div>';
    return;
  }

  els.files.innerHTML = state.files.map((file, index) => {
    let saving = '-';
    let rowStatus = '待处理';
    if (file.result?.canceled) {
      saving = '已停止';
      rowStatus = '已停止';
    } else if (file.result?.ok) {
      saving = file.result.finalBytes < file.result.originalBytes
        ? `-${Math.round((1 - file.result.finalBytes / file.result.originalBytes) * 100)}%`
        : '未变小';
      rowStatus = '完成';
    } else if (file.result) {
      saving = '失败';
      rowStatus = '失败';
    }

    return `<div class="file-row">
      <div class="file-icon">▧</div>
      <div>
        <div class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(baseName(file.path))}</div>
        <div class="file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</div>
      </div>
      <div class="size">${formatBytes(file.size)}</div>
      <div class="saving" id="saving-${index}">${saving}</div>
      <div class="row-status" id="row-status-${index}">${rowStatus}</div>
    </div>`;
  }).join('');
}

async function addFiles(files, sourceLabel) {
  if (!Array.isArray(files) || !files.length) {
    els.status.textContent = '没有扫描到支持的图片';
    return;
  }

  const existing = new Set(state.files.map((file) => file.path.toLowerCase()));
  const added = [];
  for (const file of files) {
    if (!file?.path || !Number.isFinite(file.size) || file.size < 1) continue;
    const key = file.path.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    added.push(file);
  }

  state.files.push(...added);
  els.scan.textContent = sourceLabel === 'folder'
    ? `已扫描 ${added.length} 个图片文件`
    : `已添加 ${added.length} 个图片文件`;
  els.status.textContent = added.length ? '文件已加入待处理列表' : '没有新增图片';
  renderFiles();
}

function currentSettings() {
  return {
    outputFolder: state.outputFolder,
    mode: document.querySelector('input[name=mode]:checked')?.value || 'copy',
    level: Number(els.level.value),
    resizeEnabled: els.resize.checked,
    maxDimension: Number(els.maxDimension.value),
    preservePng: els.preservePng.checked,
  };
}

function scheduleSaveSettings() {
  const settings = currentSettings();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  if (!state.settingsLoaded) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    window.compressorAPI.saveSettings(settings).catch((error) => {
      els.status.textContent = `设置保存失败：${error.message}`;
    });
  }, 120);
}

async function loadSettings() {
  let diskSettings = {};
  let localSettings = {};
  try { diskSettings = (await window.compressorAPI.loadSettings()) || {}; } catch {}
  try { localSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
  const settings = { ...diskSettings, ...localSettings };

  if (settings.outputFolder) {
    state.outputFolder = settings.outputFolder;
    els.folderLabel.textContent = settings.outputFolder;
  }
  if (Number.isFinite(settings.level)) els.level.value = settings.level;
  if (Number.isFinite(settings.maxDimension)) els.maxDimension.value = settings.maxDimension;
  els.preservePng.checked = settings.preservePng !== false;

  const level = Number(els.level.value);
  els.levelValue.textContent = level;
  const resizeAvailable = level >= 70;
  els.resize.disabled = !resizeAvailable;
  els.maxDimension.disabled = !resizeAvailable;
  els.resize.checked = resizeAvailable && Boolean(settings.resizeEnabled);

  const mode = document.querySelector(`input[name="mode"][value="${settings.mode || 'copy'}"]`);
  if (mode) mode.checked = true;
  els.fixed.hidden = (settings.mode || 'copy') !== 'fixed';

  state.settingsLoaded = true;
  updatePngOption();
  scheduleSaveSettings();
}

$('chooseFiles').addEventListener('click', async () => {
  if (state.busy) return;
  try { await addFiles(await window.compressorAPI.selectFiles(), 'files'); }
  catch (error) { els.status.textContent = `添加失败：${error.message}`; }
});

$('chooseFolder').addEventListener('click', async () => {
  if (state.busy) return;
  try {
    els.status.textContent = '正在扫描文件夹…';
    const result = await window.compressorAPI.selectFolder();
    if (result) await addFiles(result.files, 'folder');
  } catch (error) { els.status.textContent = `文件夹扫描失败：${error.message}`; }
});

$('clearFiles').addEventListener('click', () => {
  if (state.busy) return;
  state.files = [];
  els.scan.textContent = '可导入文件或文件夹';
  els.status.textContent = '列表已清空';
  renderFiles();
});

$('chooseOutput').addEventListener('click', async () => {
  try {
    const folder = await window.compressorAPI.selectOutputFolder();
    if (!folder) return;
    state.outputFolder = folder;
    els.folderLabel.textContent = folder;
    scheduleSaveSettings();
  } catch (error) { els.status.textContent = `选择路径失败：${error.message}`; }
});

els.level.addEventListener('input', () => {
  const level = Number(els.level.value);
  els.levelValue.textContent = level;
  const enabled = level >= 70;
  els.resize.disabled = !enabled;
  els.maxDimension.disabled = !enabled;
  if (!enabled) els.resize.checked = false;
  scheduleSaveSettings();
});
els.resize.addEventListener('change', scheduleSaveSettings);
els.maxDimension.addEventListener('change', scheduleSaveSettings);
els.preservePng.addEventListener('change', scheduleSaveSettings);

for (const radio of document.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    els.fixed.hidden = document.querySelector('input[name=mode]:checked').value !== 'fixed';
    scheduleSaveSettings();
  });
}

const dropzone = $('dropzone');
for (const eventName of ['dragenter', 'dragover']) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('drag');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('drag');
  });
}
document.addEventListener('drop', (event) => event.preventDefault());

dropzone.addEventListener('drop', async (event) => {
  if (state.busy) return;
  try {
    els.status.textContent = '正在扫描拖入的内容…';
    const paths = [...event.dataTransfer.files]
      .map((file) => window.compressorAPI.getPathForFile(file))
      .filter(Boolean);
    if (!paths.length) {
      els.status.textContent = '无法读取拖入内容的路径';
      return;
    }
    await addFiles(await window.compressorAPI.scanPaths(paths), 'folder');
  } catch (error) { els.status.textContent = `添加失败：${error.message}`; }
});

window.compressorAPI.onProgress(({ current, total, percent, file, result }) => {
  els.progress.hidden = false;
  els.progressText.textContent = `正在压缩 ${current} / ${total}`;
  els.percent.textContent = `${percent}%`;
  els.bar.style.width = `${percent}%`;
  els.current.textContent = file;
  const index = state.files.findIndex((item) => item.path === result.path);
  if (index >= 0) {
    state.files[index].result = result;
    renderFiles();
  }
});

els.stop.addEventListener('click', async () => {
  if (!state.busy || !state.jobId) return;
  state.stopRequested = true;
  els.stop.disabled = true;
  els.status.textContent = '正在停止，等待当前任务完成…';
  try { await window.compressorAPI.cancelCompress(state.jobId); }
  catch (error) { els.status.textContent = `停止失败：${error.message}`; }
});

els.compress.addEventListener('click', async () => {
  if (state.busy || !state.files.length) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'fixed' && !state.outputFolder) {
    els.status.textContent = '请先选择固定输出路径';
    return;
  }
  if (mode === 'replace' && !confirm('确定直接替换所有原文件吗？此操作不可恢复。')) return;

  state.busy = true;
  state.stopRequested = false;
  state.jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  els.stop.hidden = false;
  els.stop.disabled = false;
  els.progress.hidden = false;
  els.status.textContent = '正在压缩…';
  els.bar.style.width = '0%';
  els.percent.textContent = '0%';
  renderFiles();

  try {
    const results = await window.compressorAPI.compressBatch({
      jobId: state.jobId,
      files: state.files.map(({ path, relativePath, root }) => ({ path, relativePath, root })),
      options: {
        level: Number(els.level.value), resizeEnabled: els.resize.checked,
        maxDimension: Number(els.maxDimension.value), preservePng: els.preservePng.checked,
        mode, outputFolder: state.outputFolder, concurrency: 4,
      },
    });
    results.forEach((result, index) => { state.files[index].result = result; });
    const ok = results.filter((result) => result.ok).length;
    const canceled = results.filter((result) => result.canceled).length;
    els.status.textContent = state.stopRequested
      ? `已停止：完成 ${ok} 个，未处理 ${canceled} 个`
      : `完成：${ok}/${results.length} 个文件`;
  } catch (error) {
    els.status.textContent = `压缩失败：${error.message}`;
  } finally {
    state.busy = false;
    state.jobId = null;
    els.stop.hidden = true;
    els.stop.disabled = false;
    renderFiles();
  }
});

renderFiles();
loadSettings();

// ---- Video compression section ----
const videoState = {
  files: [], busy: false, paused: false, jobId: null, stopRequested: false,
  outputFolder: null, mode: 'basic', preset: 'balanced', saveMode: 'copy',
};
const videoEls = {
  files: $('videoFileList'), count: $('videoFileCount'), status: $('videoStatus'),
  start: $('startVideoCompress'), pause: $('pauseVideoQueue'), resume: $('resumeVideoQueue'),
  stop: $('stopVideoCompress'), error: $('videoError'), output: $('videoOutputFolder'),
  outputRow: $('videoOutputRow'), crf: $('videoCrf'), resolution: $('videoResolution'),
  framerate: $('videoFramerate'), videoCodec: $('videoCodec'), audioCodec: $('audioCodec'),
  picker: $('videoFilePicker'), dropzone: $('videoDropzone'), chooseOutput: $('chooseVideoOutput'),
  autoRetry: $('videoAutoRetry'), retryCount: $('videoRetryCount'),
};
const videoStatusText = {
  queued: '\u6392\u961f\u4e2d', retrying: '\u91cd\u8bd5\u4e2d', opening: '\u6253\u5f00 EchoWave', uploading: '\u4e0a\u4f20\u4e2d',
  configuring: '\u8bbe\u7f6e\u7f51\u9875\u9009\u9879', submitting: '\u63d0\u4ea4\u538b\u7f29', rendering: 'EchoWave \u538b\u7f29\u4e2d',
  downloading: '\u4e0b\u8f7d\u5e76\u91cd\u547d\u540d', completed: '\u5b8c\u6210', error: '\u5931\u8d25',
  canceled: '\u5df2\u505c\u6b62', pending: '\u5f85\u5904\u7406', stopping: '\u6b63\u5728\u505c\u6b62', removed: '\u5df2\u79fb\u9664', waiting: '\u7b49\u5f85\u4e2d',
};
function videoFileName(file) { return String(file?.path || '').split(/[/\\]/).pop(); }
function videoFormatBytes(bytes) { return formatBytes(Number(bytes) || 0); }
function videoFormatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}\u5206${total % 60}\u79d2`;
}
function updateVideoRetryUI() { videoEls.retryCount.disabled = !videoEls.autoRetry.checked; }
function updateVideoSaveUI() {
  videoEls.outputRow.hidden = videoState.saveMode !== 'fixed';
  videoEls.output.textContent = videoState.outputFolder || '\u5c1a\u672a\u9009\u62e9\u56fa\u5b9a\u8f93\u51fa\u76ee\u5f55';
}
function currentVideoSettings() {
  return {
    mode: videoState.mode, preset: videoState.preset, crf: Number(videoEls.crf.value) || 23,
    resolution: videoEls.resolution.value, framerate: videoEls.framerate.value,
    videoCodec: videoEls.videoCodec.value, audioCodec: videoEls.audioCodec.value,
    saveMode: videoState.saveMode, outputFolder: videoState.outputFolder,
    autoRetry: Boolean(videoEls.autoRetry.checked), retryCount: Math.min(5, Math.max(0, Number(videoEls.retryCount.value) || 0)),
  };
}
function scheduleSaveVideoSettings() {
  const settings = currentVideoSettings();
  try { localStorage.setItem(VIDEO_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  window.compressorAPI.saveSettings({ video: settings }).catch(() => {});
}
async function loadVideoSettings() {
  let disk = {};
  let local = {};
  try { disk = (await window.compressorAPI.loadSettings())?.video || {}; } catch {}
  try { local = JSON.parse(localStorage.getItem(VIDEO_SETTINGS_KEY) || '{}'); } catch {}
  const settings = { ...disk, ...local };
  if (settings.mode === 'advanced' || settings.mode === 'basic') videoState.mode = settings.mode;
  if (settings.preset && document.querySelector(`.video-presets button[data-video-preset="${settings.preset}"]`)) videoState.preset = settings.preset;
  if (Number.isFinite(Number(settings.crf))) videoEls.crf.value = Number(settings.crf);
  if (settings.resolution) videoEls.resolution.value = settings.resolution;
  if (settings.framerate) videoEls.framerate.value = settings.framerate;
  if (settings.videoCodec && videoEls.videoCodec.querySelector(`option[value="${settings.videoCodec}"]`)) videoEls.videoCodec.value = settings.videoCodec;
  if (settings.audioCodec && videoEls.audioCodec.querySelector(`option[value="${settings.audioCodec}"]`)) videoEls.audioCodec.value = settings.audioCodec;
  if (['copy', 'fixed', 'replace'].includes(settings.saveMode)) videoState.saveMode = settings.saveMode;
  if (settings.outputFolder) videoState.outputFolder = settings.outputFolder;
  videoEls.autoRetry.checked = Boolean(settings.autoRetry);
  if (Number.isFinite(Number(settings.retryCount))) videoEls.retryCount.value = Math.min(5, Math.max(0, Number(settings.retryCount)));
  document.querySelectorAll('.video-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.videoMode === videoState.mode));
  document.querySelectorAll('.video-presets button').forEach((button) => button.classList.toggle('active', button.dataset.videoPreset === videoState.preset));
  $('videoBasicOptions').hidden = videoState.mode !== 'basic';
  $('videoAdvancedOptions').hidden = videoState.mode !== 'advanced';
  document.querySelectorAll('input[name="videoSaveMode"]').forEach((radio) => { radio.checked = radio.value === videoState.saveMode; });
  updateVideoRetryUI();
}
function videoStatusSummary() {
  const done = videoState.files.filter((file) => ['completed', 'error', 'canceled', 'removed'].includes(file.result?.status)).length;
  const queueState = videoState.paused ? ' \u00b7 \u961f\u5217\u5df2\u6682\u505c' : '';
  return `${done}/${videoState.files.length} \u4e2a\u4efb\u52a1\u5df2\u7ed3\u675f${queueState} \u00b7 \u540c\u65f6\u8fd0\u884c\u6700\u591a 2 \u4e2a EchoWave \u9875\u9762`;
}
function renderVideoFiles() {
  videoEls.count.textContent = videoState.files.length;
  videoEls.start.disabled = !videoState.files.some((file) => file.result?.status !== 'completed') || videoState.busy;
  videoEls.pause.disabled = !videoState.busy || videoState.paused;
  videoEls.resume.disabled = !videoState.busy || !videoState.paused;
  videoEls.resume.hidden = !videoState.paused;
  videoEls.stop.disabled = !videoState.busy;

  if (!videoState.files.length) {
    videoEls.files.innerHTML = '<div class="empty"><span>&#x25A7;</span><p>\u8fd8\u6ca1\u6709\u6dfb\u52a0\u89c6\u9891</p><small>\u9009\u62e9\u89c6\u9891\u6216\u5bfc\u5165\u6587\u4ef6\u5939</small></div>';
    return;
  }

  videoEls.files.innerHTML = videoState.files.map((file, index) => {
    const result = file.result || {};
    const status = result.status || (videoState.busy ? 'queued' : '\u5f85\u5904\u7406');
    const showUploadProgress = Number.isFinite(Number(result.uploadPercent)) && (status === 'uploading' || (status === 'error' && Number(result.uploadPercent) < 100));
    const progress = showUploadProgress
      ? Number(result.uploadPercent)
      : (Number.isFinite(Number(result.progress)) ? Number(result.progress) : (result.ok ? 100 : 0));
    const detail = result.ok
      ? `${videoFormatBytes(result.finalBytes)} \u00b7 ${videoFileName({ path: result.outputPath || '' })}`
      : (result.detail || result.error || '');
    const terminal = ['completed', 'error', 'canceled', 'removed'].includes(status);
    const webPercent = status === 'rendering' && Number.isFinite(Number(result.compressionPercent)) ? `\u7f51\u9875\u538b\u7f29 ${Math.round(Number(result.compressionPercent))}%` : '';
    const progressDetail = terminal || status === 'rendering' ? '' : result.detail;
    const currentTotalElapsed = Number.isFinite(Number(result.totalElapsed)) ? Number(result.totalElapsed) : (Number(result.totalStartedAt) ? Math.max(0, (Date.now() - Number(result.totalStartedAt)) / 1000) : null);
    const currentStageElapsed = Number.isFinite(Number(result.stageElapsed)) ? Number(result.stageElapsed) : (Number(result.stageStartedAt) ? Math.max(0, (Date.now() - Number(result.stageStartedAt)) / 1000) : null);
    const elapsedLabel = currentTotalElapsed !== null ? (terminal ? `\u603b\u8017\u65f6 ${videoFormatDuration(currentTotalElapsed)}` : `\u5df2\u8017\u65f6 ${videoFormatDuration(currentStageElapsed)}`) : '';
    const statusLabel = webPercent || videoStatusText[status] || status;
    const progressLabel = webPercent ? statusLabel : `${statusLabel} \u00b7 ${Math.round(progress)}%`;
    const displayName = videoFileName(file);
    const resultLabel = result.ok && result.originalBytes > 0 && result.finalBytes > 0
      ? `${Math.round((1 - result.finalBytes / result.originalBytes) * 100)}% \u00b7 ${detail}`
      : (['completed', 'error', 'canceled', 'removed'].includes(status) ? detail : '');
    return `<div class="video-row">
      <div class="video-number">${index + 1}</div>
      <div class="video-name"><strong title="${escapeHtml(file.path)}">${escapeHtml(displayName)}</strong><span title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span></div>
      <div class="video-size">${videoFormatBytes(file.size)}</div>
      <div class="video-progress">
        <div class="track"><div style="width:${Math.max(0, Math.min(100, progress))}%"></div></div>
        <span>${escapeHtml(progressLabel)}${elapsedLabel ? ` \u00b7 ${elapsedLabel}` : ''}</span>
        ${progressDetail ? `<small title="${escapeHtml(progressDetail)}">${escapeHtml(progressDetail)}</small>` : ''}
      </div>
      <div class="video-result" title="${escapeHtml(resultLabel)}">${escapeHtml(resultLabel)}</div>
      <div class="video-row-actions">${status === 'error' ? `<button class="video-retry" data-video-retry="${escapeHtml(file.taskId)}" ${videoState.busy ? 'disabled' : ''} title="\u91cd\u8bd5\u6b64\u6587\u4ef6">\u91cd\u8bd5</button>` : ''}<button class="video-remove" data-video-remove="${escapeHtml(file.taskId)}" title="\u968f\u65f6\u79fb\u9664\u6b64\u4efb\u52a1">\u79fb\u9664</button></div>
    </div>`;
  }).join('');

  videoEls.files.querySelectorAll('[data-video-remove]').forEach((button) => button.addEventListener('click', async () => {
    const taskId = button.dataset.videoRemove;
    const index = videoState.files.findIndex((file) => file.taskId === taskId);
    if (index < 0) return;
    const file = videoState.files[index];
    button.disabled = true;
    try {
      if (videoState.busy && videoState.jobId) await window.compressorAPI.removeVideoTask(videoState.jobId, file.taskId);
    } catch (error) {
      videoEls.status.textContent = `\u79fb\u9664\u5931\u8d25\uff1a${error.message}`;
      button.disabled = false;
      return;
    }
    videoState.files.splice(index, 1);
    videoEls.status.textContent = videoState.files.length ? videoStatusSummary() : '\u5217\u8868\u5df2\u6e05\u7a7a';
    renderVideoFiles();
  }));
  videoEls.files.querySelectorAll('[data-video-retry]').forEach((button) => button.addEventListener('click', () => retryVideoTask(button.dataset.videoRetry)));
}
async function retryVideoTask(taskId) {
  if (videoState.busy) return;
  const file = videoState.files.find((item) => item.taskId === taskId);
  if (!file) return;
  videoState.busy = true;
  videoState.stopRequested = false;
  videoState.jobId = `video-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  file.result = { status: 'queued', progress: 0, detail: '' };
  videoEls.error.hidden = true;
  videoEls.status.textContent = '正在重试该文件…';
  renderVideoFiles();
  try {
    const results = await window.compressorAPI.compressVideoBatch({
      jobId: videoState.jobId,
      files: [{ taskId: file.taskId, path: file.path, relativePath: file.relativePath, root: file.root, size: file.size }],
      options: { mode: videoState.mode, preset: videoState.preset, crf: Number(videoEls.crf.value), resolution: videoEls.resolution.value, framerate: videoEls.framerate.value, videoCodec: videoEls.videoCodec.value, audioCodec: videoEls.audioCodec.value, outputFolder: videoState.outputFolder, saveMode: videoState.saveMode, concurrency: 1, autoRetry: videoEls.autoRetry.checked, retryCount: Number(videoEls.retryCount.value) || 0 },
    });
    const result = results[0];
    if (result) file.result = { ...file.result, ...result, status: result.ok ? 'completed' : result.removed ? 'removed' : result.canceled ? 'canceled' : 'error', progress: result.ok || result.removed || result.canceled ? 100 : (Number(result.progress) || 0), detail: result.ok ? '' : (result.detail || result.error || '') };
    videoEls.status.textContent = result?.ok ? '重试成功' : '重试失败';
  } catch (error) {
    file.result = { ...file.result, status: 'error', detail: error.message, error: error.message };
    videoEls.status.textContent = '重试失败';
  } finally {
    videoState.busy = false; videoState.jobId = null; renderVideoFiles();
  }
}
function addVideoFiles(files) {
  const existing = new Set(videoState.files.map((file) => String(file.path).toLowerCase()));
  for (const file of files || []) {
    if (!file?.path || existing.has(String(file.path).toLowerCase())) continue;
    existing.add(String(file.path).toLowerCase());
    videoState.files.push({ ...file, taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  }
  renderVideoFiles();
  videoEls.status.textContent = `\u5df2\u6dfb\u52a0 ${videoState.files.length} \u4e2a\u89c6\u9891 \u00b7 \u6700\u591a\u5e76\u53d1 2 \u4e2a EchoWave \u9875\u9762`;
}
async function addDroppedVideoPaths(paths) { addVideoFiles(await window.compressorAPI.scanVideoPaths(paths)); }
function selectVideoPage(pageId) {
  document.querySelectorAll('.mode-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.page === pageId));
  $('imagePage').hidden = pageId !== 'imagePage';
  $('videoPage').hidden = pageId !== 'videoPage';
}
document.querySelectorAll('.mode-tab').forEach((tab) => tab.addEventListener('click', () => selectVideoPage(tab.dataset.page)));
$('chooseVideoFiles').addEventListener('click', async () => {
  if (videoState.busy) return;
  try { addVideoFiles(await window.compressorAPI.selectVideoFiles()); }
  catch (error) { videoEls.status.textContent = `\u6dfb\u52a0\u5931\u8d25\uff1a${error.message}`; }
});
$('chooseVideoFolder').addEventListener('click', async () => {
  if (videoState.busy) return;
  try {
    const result = await window.compressorAPI.scanVideoFolder();
    if (!result?.canceled) addVideoFiles(result.files);
  } catch (error) { videoEls.status.textContent = `\u626b\u63cf\u5931\u8d25\uff1a${error.message}`; }
});
$('clearVideoFiles').addEventListener('click', async () => {
  if (videoState.busy) return;
  videoState.files = [];
  videoEls.status.textContent = '\u5217\u8868\u5df2\u6e05\u7a7a';
  renderVideoFiles();
});
videoEls.chooseOutput.addEventListener('click', async () => {
  const folder = await window.compressorAPI.selectOutputFolder();
  if (folder) { videoState.outputFolder = folder; updateVideoSaveUI(); scheduleSaveVideoSettings(); }
});
videoEls.picker.addEventListener('change', async () => {
  try {
    const paths = [...videoEls.picker.files].map((file) => window.compressorAPI.getPathForFile(file)).filter(Boolean);
    await addDroppedVideoPaths(paths);
  } catch (error) { videoEls.status.textContent = `\u6dfb\u52a0\u5931\u8d25\uff1a${error.message}`; }
  videoEls.picker.value = '';
});
videoEls.dropzone.addEventListener('click', () => { if (!videoState.busy) videoEls.picker.click(); });
for (const eventName of ['dragenter', 'dragover']) videoEls.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); videoEls.dropzone.classList.add('drag'); });
for (const eventName of ['dragleave', 'drop']) videoEls.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); videoEls.dropzone.classList.remove('drag'); });
videoEls.dropzone.addEventListener('drop', (event) => {
  if (videoState.busy) return;
  const paths = [...event.dataTransfer.files].map((file) => window.compressorAPI.getPathForFile(file)).filter(Boolean);
  addDroppedVideoPaths(paths).catch((error) => { videoEls.status.textContent = `\u6dfb\u52a0\u5931\u8d25\uff1a${error.message}`; });
});
document.querySelectorAll('.video-tab').forEach((tab) => tab.addEventListener('click', () => {
  videoState.mode = tab.dataset.videoMode;
  document.querySelectorAll('.video-tab').forEach((item) => item.classList.toggle('active', item === tab));
  $('videoBasicOptions').hidden = videoState.mode !== 'basic';
  $('videoAdvancedOptions').hidden = videoState.mode !== 'advanced';
  scheduleSaveVideoSettings();
}));
document.querySelectorAll('.video-presets button').forEach((button) => button.addEventListener('click', () => {
  videoState.preset = button.dataset.videoPreset;
  document.querySelectorAll('.video-presets button').forEach((item) => item.classList.toggle('active', item === button));
  scheduleSaveVideoSettings();
}));
window.compressorAPI.onVideoProgress((event) => {
  const file = videoState.files.find((item) => item.taskId === event.taskId);
  if (!file) return;
  const previous = file.result || {};
  const previousDetail = previous.detail || '';
  const terminal = ['completed', 'error', 'canceled', 'removed'].includes(event.status);
  const incomingUploadPercent = Number(event.uploadPercent);
  const previousUploadPercent = Number(previous.uploadPercent);
  const uploadRolledBack = event.status === 'uploading'
    && Number.isFinite(incomingUploadPercent)
    && Number.isFinite(previousUploadPercent)
    && incomingUploadPercent < previousUploadPercent;
  const detail = uploadRolledBack
    ? previousDetail
    : (event.detail !== undefined
      ? event.detail
      : (event.result?.detail !== undefined ? event.result.detail : (terminal ? '' : previousDetail)));
  file.result = {
    ...previous, ...(event.result || {}), status: event.status,
    progress: uploadRolledBack ? previous.progress : event.progress,
    uploadPercent: uploadRolledBack ? previous.uploadPercent : event.uploadPercent,
    uploadLoaded: uploadRolledBack ? previous.uploadLoaded : event.uploadLoaded,
    uploadTotal: uploadRolledBack ? previous.uploadTotal : event.uploadTotal,
    uploadSpeed: uploadRolledBack ? previous.uploadSpeed : event.uploadSpeed,
    uploadEta: uploadRolledBack ? previous.uploadEta : event.uploadEta,
    compressionPercent: event.compressionPercent, stageElapsed: event.stageElapsed, totalElapsed: event.totalElapsed, stageStartedAt: event.stageStartedAt, totalStartedAt: event.totalStartedAt, detail,
  };
  videoEls.status.textContent = videoStatusSummary();
  renderVideoFiles();
});
setInterval(() => { if (videoState.busy) renderVideoFiles(); }, 1000);
videoEls.pause.addEventListener('click', async () => {
  if (!videoState.busy || videoState.paused) return;
  const ok = await window.compressorAPI.pauseVideoCompress(videoState.jobId);
  if (!ok) return;
  videoState.paused = true;
  videoEls.status.textContent = '\u961f\u5217\u5df2\u6682\u505c \u00b7 \u5df2\u63d0\u4ea4\u7684 EchoWave \u4efb\u52a1\u7ee7\u7eed \u00b7 \u6392\u961f\u4efb\u52a1\u6682\u4e0d\u542f\u52a8';
  renderVideoFiles();
});
videoEls.resume.addEventListener('click', async () => {
  if (!videoState.busy || !videoState.paused) return;
  const ok = await window.compressorAPI.resumeVideoCompress(videoState.jobId);
  if (!ok) return;
  videoState.paused = false;
  videoEls.status.textContent = '\u961f\u5217\u5df2\u7ee7\u7eed';
  renderVideoFiles();
});
function markVideoTasksForStop() {
  for (const file of videoState.files) {
    const status = file.result?.status;
    if (['queued', 'pending', 'waiting'].includes(status) || !status) file.result = { status: 'pending', progress: 0, detail: '' };
    else if (!['completed', 'error', 'canceled', 'removed'].includes(status)) file.result = { ...file.result, status: 'stopping', detail: '\u6b63\u5728\u5173\u95ed EchoWave \u9875\u9762' };
  }
}
function prepareVideoBatch() {
  const batchFiles = videoState.files.filter((file) => file.result?.status !== 'completed');
  for (const file of batchFiles) file.result = { status: 'queued', progress: 0, detail: '' };
  return batchFiles;
}
videoEls.stop.addEventListener('click', async () => {
  if (!videoState.busy || !videoState.jobId) return;
  videoState.stopRequested = true;
  videoEls.stop.disabled = true;
  markVideoTasksForStop();
  renderVideoFiles();
  await window.compressorAPI.cancelVideoCompress(videoState.jobId);
  videoEls.status.textContent = '\u6b63\u5728\u505c\u6b62\u5e76\u5173\u95ed EchoWave \u9875\u9762\u2026';
});
$('startVideoCompress').addEventListener('click', async () => {
  if (videoState.busy || !videoState.files.length) return;
  if (videoState.saveMode === 'fixed' && !videoState.outputFolder) {
    videoEls.error.textContent = '\u9009\u62e9\u56fa\u5b9a\u8f93\u51fa\u8def\u5f84\u540e\uff0c\u8bf7\u5148\u9009\u62e9\u4e0b\u8f7d\u76ee\u5f55\u3002';
    videoEls.error.hidden = false;
    return;
  }
  if (videoState.saveMode === 'replace' && !confirm('\u76f4\u63a5\u66ff\u6362\u539f\u6587\u4ef6\uff1f\u6b64\u64cd\u4f5c\u4f1a\u8986\u76d6\u6e90\u89c6\u9891\uff0c\u8bf7\u786e\u8ba4\u3002')) return;
  const batchFiles = prepareVideoBatch();
  if (!batchFiles.length) {
    videoEls.status.textContent = '\u6ca1\u6709\u5f85\u5904\u7406\u7684\u89c6\u9891';
    renderVideoFiles();
    return;
  }
  videoState.busy = true;
  videoState.paused = false;
  videoState.stopRequested = false;
  videoState.jobId = `video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  videoEls.error.hidden = true;
  videoEls.status.textContent = '\u6b63\u5728\u521b\u5efa EchoWave \u7f51\u9875\u4efb\u52a1\u2026';
  renderVideoFiles();
  try {
    const results = await window.compressorAPI.compressVideoBatch({
      jobId: videoState.jobId,
      files: batchFiles.map(({ taskId, path, relativePath, root, size }) => ({ taskId, path, relativePath, root, size })),
      options: {
        mode: videoState.mode, preset: videoState.preset, crf: Number(videoEls.crf.value),
        resolution: videoEls.resolution.value, framerate: videoEls.framerate.value,
        videoCodec: videoEls.videoCodec.value, audioCodec: videoEls.audioCodec.value,
        outputFolder: videoState.outputFolder, saveMode: videoState.saveMode, concurrency: 2, autoRetry: videoEls.autoRetry.checked, retryCount: Math.min(5, Math.max(0, Number(videoEls.retryCount.value) || 0)),
      },
    });
    results.forEach((result) => {
      const file = videoState.files.find((item) => item.taskId === result.taskId);
      if (file) {
        const failedProgress = Number.isFinite(Number(result.uploadPercent)) ? 10 + Number(result.uploadPercent) * 0.25 : Number(result.progress ?? file.result?.progress) || 0;
        const resultStatus = result.ok ? 'completed' : result.removed ? 'removed' : result.pending ? 'pending' : result.canceled ? 'canceled' : 'error';
        file.result = result.pending
          ? { status: 'pending', progress: 0, detail: '' }
          : { ...file.result, ...result, status: resultStatus, progress: result.ok || result.removed ? 100 : failedProgress, detail: result.ok ? '' : (result.detail || file.result?.detail || result.error || ''), stageElapsed: result.stageElapsed ?? file.result?.stageElapsed, totalElapsed: result.totalElapsed ?? file.result?.totalElapsed, compressionPercent: result.compressionPercent ?? file.result?.compressionPercent };
      }
    });
    const ok = results.filter((result) => result.ok).length;
    const pending = results.filter((result) => result.pending).length;
    const canceled = results.filter((result) => result.canceled && !result.removed).length;
    videoEls.status.textContent = videoState.stopRequested
      ? `\u5df2\u505c\u6b62 \u00b7 \u672c\u6b21\u5b8c\u6210 ${ok} \u4e2a \u00b7 \u505c\u6b62 ${canceled} \u4e2a \u00b7 \u672a\u5f00\u59cb ${pending} \u4e2a`
      : `\u5b8c\u6210 \u00b7 ${ok}/${results.length} \u4e2a\u89c6\u9891 \u00b7 \u7ed3\u679c\u5df2\u6309\u4fdd\u5b58\u65b9\u5f0f\u5904\u7406`;
    renderVideoFiles();
  } catch (error) {
    videoEls.error.textContent = `\u6279\u91cf\u4efb\u52a1\u5931\u8d25\uff1a${error.message}`;
    videoEls.error.hidden = false;
    videoEls.status.textContent = '\u4efb\u52a1\u5931\u8d25';
  } finally {
    videoState.busy = false;
    videoState.paused = false;
    videoState.jobId = null;
    renderVideoFiles();
  }
});
for (const radio of document.querySelectorAll('input[name="videoSaveMode"]')) radio.addEventListener('change', () => { videoState.saveMode = radio.value; updateVideoSaveUI(); scheduleSaveVideoSettings(); });
videoEls.autoRetry.addEventListener('change', updateVideoRetryUI);
for (const control of [videoEls.crf, videoEls.resolution, videoEls.framerate, videoEls.videoCodec, videoEls.audioCodec, videoEls.autoRetry, videoEls.retryCount]) {
  control.addEventListener('change', scheduleSaveVideoSettings);
  control.addEventListener('input', scheduleSaveVideoSettings);
}
loadVideoSettings().then(() => { updateVideoSaveUI(); renderVideoFiles(); }).catch(() => { updateVideoSaveUI(); renderVideoFiles(); });
renderVideoFiles();
