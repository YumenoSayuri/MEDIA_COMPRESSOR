const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const sharp = require('sharp');
const { runEchoWaveVideo } = require('./video-automation.cjs');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
let mainWindow;
const activeJobs = new Map();

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.mpeg', '.mpg', '.ts', '.vob']);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once('ready-to-show', () => { mainWindow.show(); mainWindow.focus(); });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { if (!isQuitting) app.quit(); });
}

async function walkImages(root, includeRoot = false) {
  const result = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.push({ path: fullPath, relativePath: includeRoot ? path.join(path.basename(root), path.relative(root, fullPath)) : path.relative(root, fullPath), root, size: (await fs.stat(fullPath)).size });
      }
    }
  }
  await walk(root);
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
}

function outputExtension(sourceExt, options = {}) {
  const ext = sourceExt.toLowerCase();
  if (ext === '.png' && options.preservePng) return '.png';
  if (ext === '.jpeg') return '.jpeg';
  return '.jpg';
}

function uniqueCopyPath(targetPath) {
  const ext = path.extname(targetPath);
  const stem = targetPath.slice(0, -ext.length);
  return (async () => {
    let candidate = `${stem}-副本${ext}`;
    let index = 2;
    while (fsSync.existsSync(candidate)) {
      candidate = `${stem}-副本-${index}${ext}`;
      index += 1;
    }
    return candidate;
  })();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function encodeImage(inputPath, outputPath, options) {
  const sourceExt = path.extname(inputPath).toLowerCase();
  const targetExt = outputExtension(sourceExt, options);
  const level = Math.min(100, Math.max(0, Number(options.level) || 0));
  const quality = Math.max(1, Math.min(100, 100 - level));
  const resizeEnabled = Boolean(options.resizeEnabled) && level >= 70;
  const maxDimension = Math.max(256, Math.min(16000, Number(options.maxDimension) || 2560));

  let image = sharp(inputPath, { failOn: 'none' });
  const metadata = await image.metadata();
  image = image.rotate();

  if (resizeEnabled && metadata.width && metadata.height && Math.max(metadata.width, metadata.height) > maxDimension) {
    image = image.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
  }

  if (targetExt === '.png') {
    image = image.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: level >= 30,
      quality: Math.max(30, quality),
      colours: Math.max(32, Math.min(256, Math.round(256 - level * 2.2))),
      effort: 10,
      dither: 1,
    });
  } else {
    image = image.jpeg({ quality, mozjpeg: true, progressive: true, trellisQuantisation: true, overshootDeringing: true, optimiseScans: true });
  }

  const buffer = await image.toBuffer();
  await ensureDir(path.dirname(outputPath));
  const tempPath = `${outputPath}.compressing-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tempPath, buffer);
  return { tempPath, bytes: buffer.byteLength, targetExt };
}

async function commitFile(tempPath, outputPath, replace, overwrite = false) {
  if (replace || overwrite) {
    await fs.rm(outputPath, { force: true });
  }
  await fs.rename(tempPath, outputPath);
}

async function readSettings() {
  try { return JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8')); }
  catch { return {}; }
}

async function writeSettings(settings) {
  await ensureDir(path.dirname(SETTINGS_PATH));
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

ipcMain.handle('load-settings', async () => readSettings());
ipcMain.handle('save-settings', async (_event, settings) => {
  const current = await readSettings();
  const incoming = settings || {};
  const merged = { ...current, ...incoming };
  if (current.video || incoming.video) merged.video = { ...(current.video || {}), ...(incoming.video || {}) };
  return writeSettings(merged);
});

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS].map((ext) => ext.slice(1)) }],
  });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map(async (filePath) => ({ path: filePath, relativePath: path.basename(filePath), size: (await fs.stat(filePath)).size })));
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = result.filePaths[0];
  return { root, files: await walkImages(root, true) };
});

ipcMain.handle('scan-paths', async (_event, paths) => {
  const result = [];
  for (const itemPath of paths || []) {
    const stat = await fs.stat(itemPath);
    if (stat.isDirectory()) result.push(...await walkImages(itemPath, true));
    else if (IMAGE_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) result.push({ path: itemPath, relativePath: path.basename(itemPath), size: stat.size });
  }
  return result;
});

ipcMain.handle('select-output-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});


ipcMain.handle('select-video-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频', extensions: [...VIDEO_EXTENSIONS].map((ext) => ext.slice(1)) }],
  });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map(async (filePath) => ({ path: filePath, relativePath: path.basename(filePath), size: (await fs.stat(filePath)).size })));
});


ipcMain.handle('select-video-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = result.filePaths[0];
  return { root, files: await (async () => {
    const found = [];
    async function walk(current) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push({ path: full, relativePath: path.join(path.basename(root), path.relative(root, full)), root, size: (await fs.stat(full)).size });
      }
    }
    await walk(root);
    return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
  })() };
});
ipcMain.handle('scan-video-paths', async (_event, paths) => {
  const result = [];
  async function walkVideo(root, current = root) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walkVideo(root, fullPath);
      else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.push({ path: fullPath, relativePath: path.join(path.basename(root), path.relative(root, fullPath)), root, size: (await fs.stat(fullPath)).size });
      }
    }
  }
  for (const itemPath of paths || []) {
    const stat = await fs.stat(itemPath);
    if (stat.isDirectory()) await walkVideo(itemPath);
    else if (VIDEO_EXTENSIONS.has(path.extname(itemPath).toLowerCase())) result.push({ path: itemPath, relativePath: path.basename(itemPath), size: stat.size });
  }
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
});

function cancelVideoTask(task, removed = false) {
  if (!task) return;
  task.removed = task.removed || removed;
  task.canceled = true;
  for (const handler of task.cancelHandlers || []) { try { handler(); } catch {} }
  for (const item of task.downloadItems || []) { try { if (!item.isDone()) item.cancel(); } catch {} }
  for (const win of task.windows || []) { try { if (!win.isDestroyed()) win.destroy(); } catch {} }
}

ipcMain.handle('cancel-video-compress', async (_event, jobId) => {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  for (const task of job.tasks.values()) { if (task.started) cancelVideoTask(task); }
  return true;
});

ipcMain.handle('remove-video-task', async (_event, jobId, taskId) => {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  const task = job.tasks.get(taskId);
  if (!task) return false;
  cancelVideoTask(task, true);
  if (!task.started) task.result = { taskId, path: task.file.path, relativePath: task.file.relativePath, ok: false, removed: true, canceled: true, error: '\u5df2\u79fb\u9664' };
  return true;
});

ipcMain.handle('pause-video-compress', async (_event, jobId) => {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  job.paused = true;
  return true;
});

ipcMain.handle('resume-video-compress', async (_event, jobId) => {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  job.paused = false;
  return true;
});

ipcMain.handle('append-video-tasks', async (_event, jobId, files) => {
  const job = activeJobs.get(jobId);
  if (!job || job.kind !== 'video' || job.canceled || !job.accepting || typeof job.appendFiles !== 'function') return { ok: false, added: [] };
  return { ok: true, added: job.appendFiles(files || [], true) };
});

ipcMain.handle('retry-video-task', async (_event, jobId, taskId) => {
  const job = activeJobs.get(jobId);
  const task = job?.tasks?.get(taskId);
  if (!job || job.kind !== 'video' || job.canceled || !job.accepting || !task || task.removed || typeof job.appendFiles !== 'function') return { ok: false };
  task.superseded = true;
  if (task.result) task.result.superseded = true;
  cancelVideoTask(task, false);
  const replacementTaskId = `${taskId}-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [added] = job.appendFiles([{ ...task.file, taskId: replacementTaskId }], true);
  return added ? { ok: true, taskId: added } : { ok: false };
});

ipcMain.handle('compress-video-batch', async (event, payload) => {
  const { files: initialFiles = [], options = {}, jobId } = payload;
  const files = [];
  const results = [];
  const concurrency = Math.min(2, Math.max(1, Number(options.concurrency) || 2));
  const job = {
    kind: 'video', canceled: false, paused: false, accepting: true,
    windows: new Set(), cancelHandlers: new Set(), downloadItems: new Set(), tasks: new Map(),
    queueVersion: 0, queueWaiters: new Set(), nextIndex: 0, activeCount: 0, completed: 0,
  };
  activeJobs.set(jobId, job);

  const wakeQueue = () => {
    job.queueVersion += 1;
    for (const resolve of job.queueWaiters) resolve(true);
    job.queueWaiters.clear();
  };
  const waitForQueueChange = (version, timeout = 1000) => new Promise((resolve) => {
    if (job.canceled || job.queueVersion !== version) { resolve(true); return; }
    let settled = false;
    const finish = (changed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.queueWaiters.delete(onWake);
      resolve(changed);
    };
    const onWake = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    job.queueWaiters.add(onWake);
  });
  const createTask = (file, index) => {
    const taskId = file.taskId || `task-${index}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const normalizedFile = { ...file, taskId };
    files.push(normalizedFile);
    results.push(undefined);
    job.tasks.set(taskId, {
      taskId, file: normalizedFile, index, started: false, removed: false, superseded: false, _canceled: false,
      stage: null, stageStartedAt: 0, stageDurations: {}, totalStartedAt: 0,
      maxUploadLoaded: 0, maxUploadPercent: 0, lastUploadDetail: '', lastUploadMeta: {},
      windows: new Set(), cancelHandlers: new Set(), downloadItems: new Set(), parentJob: job,
      get canceled() { return this._canceled || job.canceled; }, set canceled(value) { this._canceled = value; },
    });
    return taskId;
  };

  function emit(index, taskId, status, progress, detail = '', result, meta = {}) {
    const file = files[index];
    if (!file) return;
    const trackedTask = job.tasks.get(taskId);
    const now = Date.now();
    if (trackedTask) {
      if (!trackedTask.totalStartedAt) trackedTask.totalStartedAt = now;
      if (status === 'uploading' && Number.isFinite(Number(meta.uploadPercent))) {
        const uploadPercent = Number(meta.uploadPercent);
        const uploadLoaded = Number(meta.uploadLoaded);
        const hasUploadLoaded = Number.isFinite(uploadLoaded) && uploadLoaded >= 0;
        const rolledBack = uploadPercent < trackedTask.maxUploadPercent
          || (hasUploadLoaded && uploadLoaded < trackedTask.maxUploadLoaded);
        if (rolledBack) {
          progress = 10 + trackedTask.maxUploadPercent * 0.25;
          detail = trackedTask.lastUploadDetail || detail;
          meta = { ...meta, ...trackedTask.lastUploadMeta, uploadPercent: trackedTask.maxUploadPercent, uploadLoaded: trackedTask.maxUploadLoaded };
        } else {
          trackedTask.maxUploadPercent = Math.max(trackedTask.maxUploadPercent, uploadPercent);
          if (hasUploadLoaded) trackedTask.maxUploadLoaded = Math.max(trackedTask.maxUploadLoaded, uploadLoaded);
          trackedTask.lastUploadDetail = detail;
          trackedTask.lastUploadMeta = { ...meta, uploadPercent: trackedTask.maxUploadPercent, uploadLoaded: trackedTask.maxUploadLoaded };
        }
      }
      if (trackedTask.stage && trackedTask.stage !== status && trackedTask.stageStartedAt) trackedTask.stageDurations[trackedTask.stage] = (trackedTask.stageDurations[trackedTask.stage] || 0) + now - trackedTask.stageStartedAt;
      if (trackedTask.stage !== status) { trackedTask.stage = status; trackedTask.stageStartedAt = now; }
      const stageElapsed = Math.max(0, (now - trackedTask.stageStartedAt) / 1000);
      const totalElapsed = Math.max(0, (now - trackedTask.totalStartedAt) / 1000);
      trackedTask.lastProgress = { status, progress, detail, ...meta, stageElapsed, totalElapsed };
      meta = { ...meta, stageElapsed, totalElapsed, stageStartedAt: trackedTask.stageStartedAt, totalStartedAt: trackedTask.totalStartedAt };
    }
    if (event.sender.isDestroyed()) return;
    event.sender.send('video-compress-progress', { index, taskId, current: job.completed, total: files.length, status, progress, detail, ...meta, uploadPercent: meta.uploadPercent, file: file.relativePath || path.basename(file.path), result });
  }

  job.appendFiles = (newFiles, emitQueued = false) => {
    if (!job.accepting || job.canceled) return [];
    const added = [];
    for (const file of newFiles || []) {
      if (!file?.path) continue;
      const index = files.length;
      const taskId = createTask(file, index);
      added.push(taskId);
      if (emitQueued) emit(index, taskId, 'queued', 0, '\u5df2\u8ffd\u52a0\u5230\u961f\u5217');
    }
    if (added.length) wakeQueue();
    return added;
  };
  job.appendFiles(initialFiles, false);

  async function processOne(index) {
    const file = files[index];
    const taskId = file?.taskId;
    const task = job.tasks.get(taskId);
    if (!file || !task) return;
    task.started = true;
    task.totalStartedAt = task.totalStartedAt || Date.now();
    if (task.removed) {
      task.result = { taskId, path: file.path, relativePath: file.relativePath, ok: false, removed: true, canceled: true, superseded: task.superseded, error: '\u5df2\u79fb\u9664' };
      results[index] = task.result; job.completed += 1; emit(index, taskId, 'removed', 100, '\u5df2\u79fb\u9664', task.result); return;
    }
    if (task.canceled) {
      task.result = { taskId, path: file.path, relativePath: file.relativePath, ok: false, canceled: true, superseded: task.superseded, error: '\u5df2\u505c\u6b62' };
      results[index] = task.result; job.completed += 1; emit(index, taskId, 'canceled', 0, '\u5df2\u505c\u6b62', task.result); return;
    }
    emit(index, taskId, 'opening', 5, '');
    let result;
    const maxRetries = options.autoRetry ? Math.min(5, Math.max(0, Number(options.retryCount) || 0)) : 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        task.maxUploadLoaded = 0; task.maxUploadPercent = 0; task.lastUploadDetail = ''; task.lastUploadMeta = {};
        emit(index, taskId, 'retrying', 5, `\u6b63\u5728\u91cd\u8bd5\uff1a\u7b2c ${attempt + 1} \u6b21\uff0c\u5171 ${maxRetries + 1} \u6b21`, undefined, { retryAttempt: attempt, retryTotal: maxRetries });
      }
      let cancelAttempt;
      const canceledAttempt = new Promise((_, reject) => {
        cancelAttempt = () => reject(new Error(task.removed ? '\u5df2\u79fb\u9664' : '\u5df2\u505c\u6b62'));
        task.cancelHandlers.add(cancelAttempt);
      });
      const automationAttempt = runEchoWaveVideo({ file, options: { ...options, showBrowser: process.env.ECHOWAVE_SHOW_BROWSER === '1' }, job: task, onProgress: (status, progress, detail, meta) => emit(index, taskId, status, progress, detail, undefined, meta) });
      try {
        result = await Promise.race([automationAttempt, canceledAttempt]);
      } catch (error) {
        result = { taskId, path: file.path, relativePath: file.relativePath, ok: false, removed: task.removed, canceled: task.canceled, error: task.removed ? '\u5df2\u79fb\u9664' : task.canceled ? '\u5df2\u505c\u6b62' : error.message, detail: task.lastProgress?.detail, progress: task.lastProgress?.progress, uploadPercent: task.lastProgress?.uploadPercent };
      } finally {
        task.cancelHandlers.delete(cancelAttempt);
        automationAttempt.catch(() => {});
      }
      const failureStage = result.failureStage || task.lastProgress?.status;
      const retryableFailure = failureStage === 'opening' || failureStage === 'uploading' || failureStage === 'rendering' || failureStage === 'downloading';
      if (result.ok || result.removed || result.canceled || !retryableFailure || attempt >= maxRetries) break;
    }
    result = { taskId, ...result, superseded: Boolean(task.superseded || result?.superseded) };
    task.result = result; results[index] = result; job.completed += 1;
    const status = result.removed ? 'removed' : result.canceled ? 'canceled' : result.ok ? 'completed' : 'error';
    const finalProgress = result.ok || result.removed ? 100 : (Number.isFinite(Number(result.progress)) ? Number(result.progress) : (task.lastProgress?.progress || 0));
    emit(index, taskId, status, finalProgress, result.ok ? '' : (result.detail || result.error || ''), result, { uploadPercent: result.uploadPercent, uploadLoaded: result.uploadLoaded, uploadTotal: result.uploadTotal, uploadSpeed: result.uploadSpeed, uploadEta: result.uploadEta });
  }

  async function waitIfPaused() {
    while (job.paused && !job.canceled) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  async function worker() {
    while (!job.canceled) {
      await waitIfPaused();
      if (job.canceled) return;
      if (job.nextIndex < files.length) {
        const index = job.nextIndex++;
        job.activeCount += 1;
        try { await processOne(index); }
        finally { job.activeCount -= 1; wakeQueue(); }
        continue;
      }
      const version = job.queueVersion;
      const changed = await waitForQueueChange(version, 1200);
      if (!changed && job.nextIndex >= files.length && job.activeCount === 0) return;
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    job.accepting = false;
    for (let index = 0; index < files.length; index += 1) {
      if (!results[index]) {
        const file = files[index]; const task = job.tasks.get(file.taskId);
        results[index] = task?.removed
          ? { taskId: task.taskId, path: file.path, relativePath: file.relativePath, ok: false, removed: true, canceled: true, superseded: task.superseded, error: '\u5df2\u79fb\u9664' }
          : task?.started
            ? { taskId: task?.taskId, path: file.path, relativePath: file.relativePath, ok: false, canceled: true, superseded: task?.superseded, error: '\u5df2\u505c\u6b62', progress: task.lastProgress?.progress || 0 }
            : { taskId: task?.taskId, path: file.path, relativePath: file.relativePath, ok: false, pending: true, error: '' };
      }
    }
    return results;
  } finally {
    job.accepting = false;
    wakeQueue();
    activeJobs.delete(jobId);
  }
});

ipcMain.handle('cancel-compress', async (_event, jobId) => {
  const job = activeJobs.get(jobId);
  if (job) job.canceled = true;
  return Boolean(job);
});

ipcMain.handle('compress-batch', async (event, payload) => {
  const { files, options, jobId } = payload;
  const job = { canceled: false };
  activeJobs.set(jobId, job);
  const total = files.length;
  const results = new Array(total);
  const concurrency = Math.min(4, Math.max(1, Number(options.concurrency) || 4));
  let nextIndex = 0;
  let completed = 0;

  async function processOne(index) {
    const file = files[index];
    const sourcePath = file.path;
    const originalBytes = (await fs.stat(sourcePath)).size;
    const sourceExt = path.extname(sourcePath).toLowerCase();
    const targetExt = outputExtension(sourceExt, options);
    let outputPath;
    let replace = false;
    let overwrite = false;
    let removeSourceAfter = false;

    if (options.mode === 'replace') {
      outputPath = targetExt === sourceExt ? sourcePath : `${sourcePath.slice(0, -sourceExt.length)}${targetExt}`;
      replace = targetExt === sourceExt;
      overwrite = targetExt !== sourceExt;
      removeSourceAfter = targetExt !== sourceExt;
    } else if (options.mode === 'fixed') {
      const relative = file.relativePath || path.basename(sourcePath);
      outputPath = path.join(options.outputFolder, relative);
      overwrite = true;
    } else {
      const sibling = `${sourcePath.slice(0, -sourceExt.length)}${targetExt}`;
      outputPath = await uniqueCopyPath(sibling);
    }

    let result;
    try {
      const encoded = await encodeImage(sourcePath, outputPath, options);
      if (job.canceled) {
        await fs.rm(encoded.tempPath, { force: true });
        result = { path: sourcePath, outputPath, relativePath: file.relativePath, ok: false, canceled: true, error: '\u5df2\u505c\u6b62' };
      } else {
        await commitFile(encoded.tempPath, outputPath, replace, overwrite);
        if (removeSourceAfter && outputPath !== sourcePath) await fs.rm(sourcePath, { force: true });
        const finalBytes = (await fs.stat(outputPath)).size;
        result = { path: sourcePath, outputPath, relativePath: file.relativePath, ok: true, originalBytes, finalBytes, changed: finalBytes < originalBytes };
      }
    } catch (error) {
      result = { path: sourcePath, outputPath, relativePath: file.relativePath, ok: false, error: error.message };
    }
    results[index] = result;
    completed += 1;
    event.sender.send('compress-progress', { current: completed, total, percent: Math.round((completed / total) * 100), file: file.relativePath || path.basename(sourcePath), result });
  }

  async function worker() {
    while (true) {
      if (job.canceled) return;
      const index = nextIndex++;
      if (index >= total) return;
      try { await processOne(index); }
      catch (error) {
        const file = files[index];
        results[index] = { path: file.path, relativePath: file.relativePath, ok: false, error: error.message };
        completed += 1;
        event.sender.send('compress-progress', { current: completed, total, percent: Math.round((completed / total) * 100), file: file.relativePath || path.basename(file.path), result: results[index] });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    for (let index = 0; index < total; index += 1) {
      if (!results[index]) {
        const file = files[index];
        results[index] = { path: file.path, relativePath: file.relativePath, ok: false, canceled: true, error: '\u5df2\u505c\u6b62' };
      }
    }
    return results;
  } finally {
    activeJobs.delete(jobId);
  }
});

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

let isQuitting = false;
let quitTimer = null;
app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();

  for (const job of activeJobs.values()) {
    if (job.tasks) {
      job.canceled = true;
      for (const task of job.tasks.values()) cancelVideoTask(task);
    } else {
      job.canceled = true;
      for (const handler of job.cancelHandlers || []) { try { handler(); } catch {} }
      for (const item of job.downloadItems || []) { try { if (!item.isDone()) item.cancel(); } catch {} }
      for (const win of job.windows || []) {
        try { if (!win.isDestroyed()) win.destroy(); } catch {}
      }
    }
  }

  const started = Date.now();
  const finishQuit = () => {
    if (quitTimer) { clearInterval(quitTimer); quitTimer = null; }
    app.quit();
  };
  quitTimer = setInterval(() => {
    const videoJobsRemain = [...activeJobs.values()].some((job) => job.kind === 'video');
    if (!videoJobsRemain || Date.now() - started > 3000) finishQuit();
  }, 50);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });










