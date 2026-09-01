const { BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const PRESET_LABELS = { light: '\u8f7b\u5ea6\u538b\u7f29', balanced: '\u5e73\u8861\uff08\u63a8\u8350\uff09', aggressive: '\u6fc0\u8fdb', maximum: '\u6700\u5927\u5316' };
const VIDEO_CODECS = new Set(['auto', 'h264', 'h265', 'av1', 'copy']);
const AUDIO_CODECS = new Set(['auto', 'aac', 'ac3', 'mp3', 'copy']);
const claimedDownloadItems = new WeakSet();

function safeName(value, fallback = 'video') {
  const name = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return name || fallback;
}
function baseName(filePath) { return path.parse(safeName(path.basename(filePath))).name || 'video'; }
function safeRelativePath(value) { return String(value || '').split(/[\\/]+/).map((part) => safeName(part)).filter(Boolean).join(path.sep); }
function uniqueOutputPath(folder, stem, ext) { let candidate = path.join(folder, `${stem}${ext}`); let index = 2; while (fsSync.existsSync(candidate)) { candidate = path.join(folder, `${stem}-${index}${ext}`); index += 1; } return candidate; }
function outputPathFor(file, options, ext) {
  const source = file.path;
  const normalizedExt = ext || path.extname(source) || '.mp4';
  const stem = baseName(source);
  if (options.saveMode === 'replace') return path.join(path.dirname(source), `${stem}${normalizedExt}`);
  if (options.saveMode === 'fixed') {
    if (!options.outputFolder) throw new Error('\u5c1a\u672a\u9009\u62e9\u56fa\u5b9a\u8f93\u51fa\u76ee\u5f55');
    const relative = safeRelativePath(file.relativePath || path.basename(source));
    const relativeExt = path.extname(relative);
    const relativeStem = relativeExt ? relative.slice(0, -relativeExt.length) : relative;
    return path.join(options.outputFolder, `${relativeStem}${normalizedExt}`);
  }
  return uniqueOutputPath(path.dirname(source), `${stem}-\u526f\u672c`, normalizedExt);
}
function isCanceled(job) { return Boolean(job?.removed || job?.canceled || job?.parentJob?.canceled); }
function isPaused(job) { return Boolean(job?.parentJob?.paused); }
function assertActive(win, job) {
  if (isCanceled(job)) throw new Error('\u5df2\u505c\u6b62');
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error('EchoWave \u81ea\u52a8\u5316\u7a97\u53e3\u5df2\u5173\u95ed');
}
async function waitWhilePaused(job) {
  while (isPaused(job) && !isCanceled(job)) await new Promise((resolve) => setTimeout(resolve, 200));
  if (isCanceled(job)) throw new Error('\u5df2\u505c\u6b62');
}
async function evaluate(win, code, job) { assertActive(win, job); return win.webContents.executeJavaScript(code, true); }
async function waitFor(win, code, job, timeout = 60000, interval = 500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    assertActive(win, job);
    try { if (await evaluate(win, code, job)) return true; } catch (error) { if (isCanceled(job)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('\u7b49\u5f85 EchoWave \u9875\u9762\u54cd\u5e94\u8d85\u65f6');
}
async function attachDebugger(win) { if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3'); }
async function setFileInput(win, selector, filePath, job) {
  assertActive(win, job); await attachDebugger(win);
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`EchoWave \u4e0a\u4f20\u63a7\u4ef6\u4e0d\u5b58\u5728\uff1a${selector}`);
  await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
}
async function clickButtonByText(win, text, job, exact = false) {
  const candidates = Array.isArray(text) ? text : [text];
  const values = JSON.stringify(candidates); const matcher = exact ? 't === label' : 't.includes(label)';
  const clicked = await evaluate(win, `(() => { const labels=${values}; const button=[...document.querySelectorAll('button')].find((item)=>{const t=(item.innerText||'').trim();return labels.some((label)=>${matcher})}); if(!button)return false; button.click(); return true; })()`, job);
  if (!clicked) throw new Error(`EchoWave button not found: ${candidates.join(' / ')}`);
}
async function setControlValue(win, selector, value, job) {
  const result = await evaluate(win, `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; const value=${JSON.stringify(String(value))}; const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value'); if(descriptor?.set)descriptor.set.call(el,value); else el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return el.value; })()`, job);
  return result !== false;
}
async function configure(win, options, job) {
  if (options.mode === 'advanced') {
    await clickButtonByText(win, ['\u9ad8\u7ea7', 'Advanced'], job, true);
    await waitFor(win, `Boolean(document.querySelector('#quality-slider'))`, job, 30000);
    await setControlValue(win, '#quality-slider', Math.max(18, Math.min(32, Number(options.crf) || 23)), job);
    await setControlValue(win, '#resolution-select', options.resolution || 'original', job);
    await setControlValue(win, '#framerate-select', options.framerate || 'original', job);
  } else await clickButtonByText(win, PRESET_LABELS[options.preset] || PRESET_LABELS.balanced, job, false);
  const toggleClicked = await evaluate(win, `(() => { const button=[...document.querySelectorAll('button')].find((item)=>{const t=item.innerText||'';return t.includes('\u9ad8\u7ea7\u7f16\u7801\u5668')||t.includes('Advanced codec')||t.includes('Advanced encoder')}); if(!button)return false; if(button.getAttribute('aria-expanded')!=='true')button.click(); return true; })()`, job);
  if (!toggleClicked) throw new Error('EchoWave advanced codec section not found');
  await waitFor(win, `Boolean(document.querySelector('#tool-video-codec'))`, job, 30000);
  await setControlValue(win, '#tool-video-codec', VIDEO_CODECS.has(options.videoCodec) ? options.videoCodec : 'auto', job);
  await setControlValue(win, '#tool-audio-codec', AUDIO_CODECS.has(options.audioCodec) ? options.audioCodec : 'auto', job);
}
async function installUploadProgressHook(win, job) {
  await evaluate(win, `(() => {
    if (window.__echoWaveUploadHookInstalled) return true;
    window.__echoWaveUploadHookInstalled = true;
    window.__echoWaveUploadProgress = { loaded: 0, total: 0, startedAt: Date.now(), updatedAt: Date.now(), done: false, failed: false, error: '' };
    const state = window.__echoWaveUploadProgress;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) { this.__echoWaveMethod = method; this.__echoWaveUrl = String(url || ''); return originalOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(body) {
      const looksLikeUpload = body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || (body && typeof body === 'object');
      if (looksLikeUpload && this.upload) {
        state.startedAt = state.loaded ? state.startedAt : Date.now();
        this.upload.addEventListener('progress', (event) => { state.loaded = Number(event.loaded) || 0; state.total = Number(event.total) || state.total || 0; state.updatedAt = Date.now(); });
        this.addEventListener('load', () => { state.httpStatus = Number(this.status) || 0; if (this.status >= 400) { state.failed = true; state.error = 'HTTP ' + this.status; } });
        this.addEventListener('error', () => { state.failed = true; state.error = '\u7f51\u7edc\u9519\u8bef'; state.updatedAt = Date.now(); });
        this.addEventListener('abort', () => { state.failed = true; state.error = '\u4e0a\u4f20\u88ab\u4e2d\u65ad'; state.updatedAt = Date.now(); });
        this.addEventListener('timeout', () => { state.failed = true; state.error = '\u4e0a\u4f20\u8d85\u65f6'; state.updatedAt = Date.now(); });
        this.addEventListener('loadend', () => { state.done = true; state.updatedAt = Date.now(); });
      }
      return originalSend.apply(this, arguments);
    };
    return true;
  })()`, job);
}
function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function humanDuration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  if (n < 60) return `${n}\u79d2`;
  if (n < 3600) return `${Math.floor(n / 60)}\u5206${n % 60}\u79d2`;
  return `${Math.floor(n / 3600)}\u5c0f\u65f6${Math.floor((n % 3600) / 60)}\u5206`;
}
function formatUploadDetail(progress, fallbackTotal) {
  const loaded = Number(progress?.loaded) || 0;
  const total = Number(progress?.total) || Number(fallbackTotal) || 0;
  const speed = Number(progress?.localSpeed ?? progress?.speed) || 0;
  const eta = Number.isFinite(Number(progress?.localEta))
    ? Number(progress.localEta)
    : (total > loaded && speed > 0 ? (total - loaded) / speed : null);
  const parts = [`\u5df2\u4e0a\u4f20 ${humanBytes(loaded)}${total ? ` / ${humanBytes(total)}` : ''}`];
  parts.push(speed > 0 ? `${humanBytes(speed)}/s` : '\u901f\u5ea6\u8ba1\u7b97\u4e2d');
  parts.push(eta !== null && eta >= 0 ? `\u9884\u8ba1\u5269\u4f59 ${humanDuration(eta)}` : '\u9884\u8ba1\u5269\u4f59\u65f6\u95f4\u8ba1\u7b97\u4e2d');
  return parts.join(' \u00b7 ');
}
async function readUploadProgress(win, job, fallbackTotal) {
  const progress = await evaluate(win, `(() => {
    const state = window.__echoWaveUploadProgress || {};
    const text = document.body?.innerText || '';
    const parseBytes = (value, unit) => {
      const n = Number(String(value).replace(',', '.')) || 0;
      const u = String(unit || 'B').toUpperCase();
      return n * (u === 'GB' ? 1024 ** 3 : u === 'MB' ? 1024 ** 2 : u === 'KB' ? 1024 : 1);
    };
    const percentMatch = text.match(/(\\d{1,3}(?:\\.\\d+)?)\\s*%/);
    const uploadedMatch = text.match(/\u5df2\u4e0a\u4f20\\s*([\\d.,]+)\\s*(B|KB|MB|GB)\\s*\\/\\s*([\\d.,]+)\\s*(B|KB|MB|GB)/i);
    const speedMatch = text.match(/\u901f\u5ea6\\s*([\\d.,]+)\\s*(KB|MB|GB)\\s*\\/(?:s|\u79d2)/i);
    const etaMatch = text.match(/(?:\u9884\u8ba1\u5230\u8fbe\u65f6\u95f4|\u9884\u8ba1\u5269\u4f59)\\s*([\\d.,]+)\\s*(\u79d2|\u5206|\u5c0f\u65f6|s|m|h)/i);
    const domLoaded = uploadedMatch ? parseBytes(uploadedMatch[1], uploadedMatch[2]) : 0;
    const domTotal = uploadedMatch ? parseBytes(uploadedMatch[3], uploadedMatch[4]) : 0;
    const domSpeed = speedMatch ? parseBytes(speedMatch[1], speedMatch[2]) : 0;
    const etaValue = etaMatch ? Number(String(etaMatch[1]).replace(',', '.')) || 0 : null;
    const etaUnit = etaMatch?.[2]?.toLowerCase();
    const domEta = etaValue === null ? null : etaValue * (etaUnit === '\\u5206' || etaUnit === 'm' ? 60 : etaUnit === '\\u5c0f\\u65f6' || etaUnit === 'h' ? 3600 : 1);
    const explicitComplete = /\\u4e0a\\u4f20\\s*(?:\\u5b8c\\u6210|\\u6210\\u529f)|upload complete|uploaded successfully/i.test(text);
    const finalizing = /\\u6b63\\u5728\\u5b8c\\u6210\\u60a8\\u7684\\u4e0a\\u4f20|finalizing (?:your )?upload/i.test(text);
    const pageFailed = /\\u4e0a\\u4f20\\s*(?:\\u5931\\u8d25|\\u9519\\u8bef)|upload failed|upload error|network error/i.test(text);
    return { ...state, failed: Boolean(state.failed || pageFailed), error: state.error || (pageFailed ? '\\u4e0a\\u4f20\\u5931\\u8d25' : ''), domPercent: percentMatch ? Number(percentMatch[1]) : null, domLoaded, domTotal, domSpeed, domEta, domText: text.slice(0, 1200), domDone: explicitComplete, finalizing };
  })()`, job);
  const now = Date.now();
  const xhrLoaded = Number(progress.loaded) || 0;
  const domLoaded = Number(progress.domLoaded) || 0;
  const loaded = Math.max(xhrLoaded, domLoaded);
  const total = Math.max(Number(progress.total) || 0, Number(progress.domTotal) || 0, Number(fallbackTotal) || 0);
  const elapsed = Math.max(0.001, (now - (Number(progress.startedAt) || now)) / 1000);
  const percent = total > 0 ? Math.min(100, loaded / total * 100) : Number.isFinite(progress.domPercent) ? progress.domPercent : 0;
  return { ...progress, loaded, total, percent, done: Boolean(progress.done || progress.domDone), failed: Boolean(progress.failed) };
}
async function readCompressionProgress(win, job) {
  return evaluate(win, `(() => {
    const text = document.body?.innerText || '';
    const renderPage = /\u6b63\u5728\u6e32\u67d3\u89c6\u9891|\u6e32\u67d3\u89c6\u9891\u53ef\u80fd\u9700\u8981|rendering (?:your )?video/i.test(text);
    if (!renderPage) return { percent: 0, candidates: [], text: text.slice(0, 1800), renderPage: false };
    const candidates = [];
    const add = (value, source) => { const n = Number(value); if (Number.isFinite(n) && n >= 0 && n <= 100) candidates.push({ percent: n, source }); };
    // Only read EchoWave render bars; ignore media player volume/seek controls.
    const renderBars = [...document.querySelectorAll('[role="progressbar"]')].filter((el) => /render|\u6e32\u67d3|tool-render-bar/i.test(String(el.className) + ' ' + (el.getAttribute('aria-label') || '')));
    for (const el of renderBars) {
      add(el.getAttribute('aria-valuenow'), 'render-aria-valuenow');
      const child = el.querySelector('[style*="width"]');
      const indeterminate = /indeterminate/i.test(String(el.className));
      const width = !indeterminate && String(child?.style?.width || el.style?.width || '').match(/([\\d.]+)%/);
      if (width) add(width[1], 'render-style-width');
    }
    for (const el of document.querySelectorAll('*')) {
      const label = (el.innerText || '').trim();
      if (!label || el.children.length > 3 || !/(\\u538b\\u7f29|compression|render|\\u5bfc\\u51fa|export|processing)/i.test(label)) continue;
      const match = label.match(/(\\d{1,3}(?:\\.\\d+)?)\\s*%/);
      if (match) add(match[1], 'compression-text');
    }
    const compressionText = text.match(/(?:\\u538b\\u7f29|compression|render|processing)[^%]{0,120}?(\\d{1,3}(?:\\.\\d+)?)\\s*%/i);
    if (compressionText) add(compressionText[1], 'body-text');
    return { percent: candidates.length ? Math.max(...candidates.map((item) => item.percent)) : 0, candidates, text: text.slice(0, 1800) };
  })()`, job);
}
async function waitForCompressionComplete(win, job, onProgress) {
  const started = Date.now();
  let lastPercent = 0;
  while (Date.now() - started < 6 * 60 * 60 * 1000) {
    assertActive(win, job);
    const info = await readCompressionProgress(win, job).catch(() => ({ percent: lastPercent, text: '' }));
    const percent = Math.max(lastPercent, Math.min(100, Number(info.percent) || 0));
    lastPercent = percent;
    onProgress('rendering', 45 + percent * 0.52, `\u7f51\u9875\u538b\u7f29 ${Math.round(percent)}%`, { compressionPercent: percent });
    const complete = await evaluate(win, `(() => {
      const text = document.body?.innerText || '';
      return /\\u538b\\u7f29\\u5b8c\\u6210|\\u5b8c\\u6210 \\ud83c\\udf89|compression complete|rendering complete|done/i.test(text)
        && Boolean([...document.querySelectorAll('button')].find((button) => /\\u4e0b\\u8f7d|download/i.test(button.innerText || '')));
    })()`, job).catch(() => false);
    if (complete) {
      onProgress('rendering', 97, '\u7f51\u9875\u538b\u7f29 100%', { compressionPercent: 100 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('\u7b49\u5f85 EchoWave \u538b\u7f29\u5b8c\u6210\u8d85\u65f6');
}
async function waitForUploadComplete(win, job, fileSize, onProgress) {
  const started = Date.now();
  const samples = [];
  let lastSpeed = 0;
  let maxLoaded = 0;
  let lastIncreaseAt = started;
  let sawCompleteBytes = false;
  while (Date.now() - started < 6 * 60 * 60 * 1000) {
    assertActive(win, job);
    const progress = await readUploadProgress(win, job, fileSize).catch(() => ({ loaded: maxLoaded, total: fileSize, percent: 0, done: false }));
    const now = Date.now();
    const total = Number(progress.total) || fileSize;
    const currentLoaded = Math.max(0, Math.min(total, Number(progress.loaded) || 0));
    if (currentLoaded > maxLoaded) { maxLoaded = currentLoaded; lastIncreaseAt = now; }
    const loaded = maxLoaded;
    samples.push({ at: now, loaded });
    while (samples.length > 2 && now - samples[0].at > 10000) samples.shift();
    const first = samples[0];
    const elapsed = Math.max(0.001, (now - first.at) / 1000);
    if (samples.length >= 2 && loaded > first.loaded) lastSpeed = (loaded - first.loaded) / elapsed;
    else if (now - lastIncreaseAt > 5000) lastSpeed = 0;
    const percent = total > 0 ? Math.max(0, Math.min(100, loaded / total * 100)) : Math.max(0, Number(progress.domPercent) || 0);
    const currentPercent = total > 0 ? Math.max(0, Math.min(100, currentLoaded / total * 100)) : Math.max(0, Number(progress.domPercent) || 0);
    const domPercent = Number(progress.domPercent);
    const pageReady = Boolean(progress.domDone || progress.finalizing);
    // EchoWave may round the displayed byte count or replace the completed upload row
    // with a smaller per-request value while finalizing. Keep completion evidence sticky.
    if (currentPercent >= 98.5 || (Number.isFinite(domPercent) && domPercent >= 99.5) || pageReady) sawCompleteBytes = true;
    const localEta = total > loaded && lastSpeed > 0 ? (total - loaded) / lastSpeed : null;
    const tracked = { ...progress, loaded, total, percent, localSpeed: lastSpeed, localEta };
    job.uploadProgress = { ...tracked, detail: formatUploadDetail(tracked, fileSize) };
    if (progress.failed) throw new Error(progress.error || '\u4e0a\u4f20\u5931\u8d25');
    onProgress('uploading', 10 + percent * 0.25, job.uploadProgress.detail, { uploadPercent: percent, uploadLoaded: loaded, uploadTotal: total, uploadSpeed: lastSpeed, uploadEta: localEta });
    const uploadReady = sawCompleteBytes && pageReady
      && await evaluate(win, `Boolean(document.querySelector('button[type="submit"]'))`, job).catch(() => false);
    if (uploadReady) {
      const completed = { ...tracked, loaded: fileSize, total: fileSize, percent: 100, localEta: 0 };
      job.uploadProgress = { ...completed, detail: formatUploadDetail(completed, fileSize) };
      onProgress('uploading', 35, `\u4e0a\u4f20\u5b8c\u6210 \u00b7 ${job.uploadProgress.detail}`, { uploadPercent: 100, uploadLoaded: fileSize, uploadTotal: fileSize, uploadSpeed: lastSpeed, uploadEta: 0 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('\u7b49\u5f85 EchoWave \u4e0a\u4f20\u5b8c\u6210\u8d85\u65f6');
}
async function pathExists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
async function replacePathSafely(tempPath, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (!await pathExists(outputPath)) { await fs.rename(tempPath, outputPath); return; }
  const backupPath = `${outputPath}.echowave-backup-${process.pid}-${Date.now()}`;
  await fs.rename(outputPath, backupPath);
  try { await fs.rename(tempPath, outputPath); await fs.rm(backupPath, { force: true }); }
  catch (error) { await fs.rm(outputPath, { force: true }).catch(() => {}); await fs.rename(backupPath, outputPath).catch(() => {}); throw error; }
}
async function commitDownloadedFile(tempPath, outputPath, sourcePath, saveMode) {
  await replacePathSafely(tempPath, outputPath);
  if (saveMode === 'replace' && path.resolve(outputPath) !== path.resolve(sourcePath)) {
    try { await fs.rm(sourcePath); }
    catch (error) { throw new Error(`\u538b\u7f29\u6587\u4ef6\u5df2\u4fdd\u5b58\u5230 ${outputPath}\uff0c\u4f46\u65e0\u6cd5\u5220\u9664\u539f\u6587\u4ef6\uff1a${error.message}`); }
  }
}
function waitForDownload(win, file, options, job, onProgress) {
  return new Promise((resolve, reject) => {
    assertActive(win, job);
    const ses = win.webContents.session;
    const sourceWebContentsId = win.webContents.id;
    const allowedWebContentsIds = new Set([sourceWebContentsId]);
    const attachedSessions = new Set();
    const triggerDelays = [0, 4000, 12000, 30000];
    let settled = false;
    let tempPath = null;
    let downloadItem = null;
    let outputPath = null;
    let startTimer = null;
    let stallTimer = null;
    let hardTimer = null;
    let retryTimers = [];
    let triggerCount = 0;
    let lastTriggerError = '';
    let lastReceived = 0;
    let lastIncreaseAt = Date.now();
    let lastSampleAt = Date.now();
    let lastSampleBytes = 0;
    let smoothedSpeed = 0;

    const cleanupTimers = () => {
      if (startTimer) clearTimeout(startTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (hardTimer) clearTimeout(hardTimer);
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers = [];
    };
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      for (const attachedSession of attachedSessions) attachedSession.removeListener('will-download', listener);
      attachedSessions.clear();
      win.removeListener('closed', onWindowClosed);
      win.webContents.removeListener('did-create-window', onChildWindow);
      job?.cancelHandlers?.delete(onCancel);
      if (downloadItem) job?.downloadItems?.delete(downloadItem);
      if (error && tempPath) await fs.rm(tempPath, { force: true }).catch(() => {});
      if (error) reject(error); else resolve(value);
    };
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        try { if (downloadItem) downloadItem.cancel(); } catch {}
        void finish(new Error('EchoWave \u4e0b\u8f7d\u5df2\u8fde\u7eed 5 \u5206\u949f\u6ca1\u6709\u63a5\u6536\u5230\u65b0\u6570\u636e'));
      }, 300000);
    };
    const onCancel = () => {
      try { if (downloadItem) downloadItem.cancel(); } catch {}
      void finish(new Error('\u5df2\u505c\u6b62'));
    };
    const attachDownloadSession = (downloadSession) => {
      if (!downloadSession || attachedSessions.has(downloadSession)) return;
      attachedSessions.add(downloadSession);
      downloadSession.on('will-download', listener);
    };
    const onChildWindow = (childWindow) => {
      if (!childWindow?.webContents || childWindow.webContents.isDestroyed()) return;
      allowedWebContentsIds.add(childWindow.webContents.id);
      attachDownloadSession(childWindow.webContents.session);
    };
    const onWindowClosed = () => {
      void finish(new Error(isCanceled(job) ? '\u5df2\u505c\u6b62' : 'EchoWave \u81ea\u52a8\u5316\u7a97\u53e3\u5df2\u5173\u95ed'));
    };
    const triggerDownload = async () => {
      if (settled || downloadItem || isCanceled(job)) return;
      triggerCount += 1;
      try {
        const control = await evaluate(win, `(() => {
          const visible = (el) => { const style=getComputedStyle(el); const rect=el.getBoundingClientRect(); return style.display!=='none' && style.visibility!=='hidden' && rect.width>0 && rect.height>0; };
          const candidates=[...document.querySelectorAll('button,a,[role="button"]')].filter((el)=>{const text=(el.innerText||el.textContent||'').trim();return /(?:\u4e0b\u8f7d|download)/i.test(text) && visible(el) && !el.disabled && el.getAttribute('aria-disabled')!=='true';});
          const score=(el)=>{const text=(el.innerText||el.textContent||'').trim();return (el.href||el.hasAttribute('download')?10:0)+(/^(?:\u4e0b\u8f7d|download)$/i.test(text)?5:0);};
          const target=candidates.sort((a,b)=>score(b)-score(a))[0];
          if(!target)return { clicked:false, controls:[...document.querySelectorAll('button,a,[role="button"]')].map((el)=>(el.innerText||el.textContent||'').trim()).filter(Boolean).slice(-20) };
          const href=target.href || target.getAttribute('href') || '';
          target.click();
          return { clicked:true, tag:target.tagName, href, text:(target.innerText||target.textContent||'').trim() };
        })()`, job);
        if (!control?.clicked) throw new Error('\u9875\u9762\u4e0a\u6ca1\u6709\u53ef\u7528\u7684\u4e0b\u8f7d\u6309\u94ae');
        onProgress?.('downloading', 97, `\u6b63\u5728\u89e6\u53d1 EchoWave \u4e0b\u8f7d \u00b7 \u7b2c ${triggerCount} \u6b21`);
        if (triggerCount >= 3 && control.href && /^(?:https?:|blob:)/i.test(control.href)) {
          try { win.webContents.downloadURL(control.href); } catch {}
        }
      } catch (error) {
        lastTriggerError = error.message;
      }
    };
    const listener = (event, item, webContents) => {
      if (webContents && !allowedWebContentsIds.has(webContents.id)) return;
      if (claimedDownloadItems.has(item)) return;
      if (settled || downloadItem) {
        claimedDownloadItems.add(item);
        event.preventDefault();
        return;
      }
      claimedDownloadItems.add(item);
      downloadItem = item;
      job?.downloadItems?.add(item);
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers = [];
      const ext = path.extname(item.getFilename()) || path.extname(file.path) || '.mp4';
      try {
        outputPath = outputPathFor(file, options, ext);
        fsSync.mkdirSync(path.dirname(outputPath), { recursive: true });
        tempPath = `${outputPath}.echowave-downloading-${process.pid}-${Date.now()}.tmp`;
        item.setSavePath(tempPath);
      } catch (error) {
        try { item.cancel(); } catch {}
        void finish(error);
        return;
      }
      lastReceived = Number(item.getReceivedBytes()) || 0;
      lastSampleBytes = lastReceived;
      lastSampleAt = Date.now();
      lastIncreaseAt = lastSampleAt;
      armStallTimer();
      item.on('updated', () => {
        if (settled) return;
        const now = Date.now();
        const received = Number(item.getReceivedBytes()) || 0;
        const total = Number(item.getTotalBytes()) || 0;
        if (received > lastReceived) {
          const elapsed = Math.max(0.001, (now - lastSampleAt) / 1000);
          const instantSpeed = Math.max(0, (received - lastSampleBytes) / elapsed);
          smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.65 + instantSpeed * 0.35 : instantSpeed;
          lastReceived = received;
          lastSampleBytes = received;
          lastSampleAt = now;
          lastIncreaseAt = now;
          armStallTimer();
        } else if (now - lastIncreaseAt > 5000) smoothedSpeed = 0;
        const percent = total > 0 ? Math.max(0, Math.min(100, received / total * 100)) : 0;
        const eta = total > received && smoothedSpeed > 0 ? (total - received) / smoothedSpeed : null;
        const tracked = { loaded: received, total, localSpeed: smoothedSpeed, localEta: eta };
        onProgress?.('downloading', 97 + percent * 0.03, `\u5df2\u4e0b\u8f7d ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ''} \u00b7 ${smoothedSpeed > 0 ? `${humanBytes(smoothedSpeed)}/s` : '\u7b49\u5f85\u4e0b\u8f7d\u6570\u636e'}${eta !== null ? ` \u00b7 \u9884\u8ba1\u5269\u4f59 ${humanDuration(eta)}` : ''}`, { downloadPercent: percent, downloadLoaded: received, downloadTotal: total, downloadSpeed: smoothedSpeed, downloadEta: eta });
      });
      item.once('done', async (_doneEvent, state) => {
        if (settled) return;
        if (state !== 'completed') {
          await finish(new Error(isCanceled(job) ? '\u5df2\u505c\u6b62' : `EchoWave \u4e0b\u8f7d\u5931\u8d25\uff1a${state}`));
          return;
        }
        try {
          await commitDownloadedFile(tempPath, outputPath, file.path, options.saveMode);
          await finish(null, { outputPath, outputName: path.basename(outputPath) });
        } catch (error) { await finish(error); }
      });
    };

    attachDownloadSession(ses);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^(?:https?:|blob:)/i.test(url)) {
        setImmediate(() => {
          try { if (!settled && !downloadItem && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.downloadURL(url); } catch {}
        });
        return { action: 'deny' };
      }
      return { action: 'allow', overrideBrowserWindowOptions: { show: Boolean(options.showBrowser), webPreferences: { partition: 'persist:echowave-video', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } } };
    });
    win.webContents.on('did-create-window', onChildWindow);
    win.once('closed', onWindowClosed);
    job?.cancelHandlers?.add(onCancel);
    startTimer = setTimeout(() => {
      const suffix = lastTriggerError ? `\uff1a${lastTriggerError}` : '';
      void finish(new Error(`\u70b9\u51fb\u4e0b\u8f7d\u540e 3 \u5206\u949f\u4ecd\u672a\u5f00\u59cb\uff0c\u5df2\u81ea\u52a8\u91cd\u65b0\u89e6\u53d1 ${triggerCount} \u6b21${suffix}`));
    }, 180000);
    hardTimer = setTimeout(() => {
      try { if (downloadItem) downloadItem.cancel(); } catch {}
      void finish(new Error('EchoWave \u4e0b\u8f7d\u8d85\u8fc7 6 \u5c0f\u65f6\uff0c\u4efb\u52a1\u5df2\u505c\u6b62'));
    }, 6 * 60 * 60 * 1000);
    retryTimers = triggerDelays.map((delay) => setTimeout(() => { void triggerDownload(); }, delay));
    if (isCanceled(job)) onCancel();
  });
}
async function runEchoWaveVideo({ file, options, job, onProgress }) {
  const outputFolder = options.saveMode === 'fixed' ? options.outputFolder : path.dirname(file.path);
  if (!outputFolder) return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, error: '\u5c1a\u672a\u9009\u62e9\u56fa\u5b9a\u8f93\u51fa\u76ee\u5f55' };
  await fs.mkdir(outputFolder, { recursive: true });
  const win = new BrowserWindow({ width: 1180, height: 820, show: Boolean(options.showBrowser), title: `EchoWave - ${path.basename(file.path)}`, webPreferences: { partition: 'persist:echowave-video', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: Boolean(options.showBrowser), webPreferences: { partition: 'persist:echowave-video', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } } }));
  job.windows.add(win); job.window = win;
  job.uploadProgress = null;
  let currentStage = 'opening';
  let currentProgress = 5;
  const report = (status, progress, detail = '', meta = {}) => {
    currentStage = status;
    currentProgress = Number(progress) || 0;
    onProgress(status, progress, detail, meta);
  };
  try {
    report('opening', 5, ''); await win.loadURL('https://echowave.io/app/tools/compress'); await waitFor(win, `Boolean(document.querySelector('#dropzone-file'))`, job, 90000);
    await installUploadProgressHook(win, job); await waitWhilePaused(job); report('uploading', 10, '\u51c6\u5907\u4e0a\u4f20'); await setFileInput(win, '#dropzone-file', file.path, job); await waitForUploadComplete(win, job, file.size, report);
    await waitWhilePaused(job); report('configuring', 35, ''); await configure(win, options, job); await waitWhilePaused(job); report('submitting', 40, '');
    const submitted = await evaluate(win, `(() => { const button=document.querySelector('button[type="submit"]'); if(!button)return false; button.click(); return true; })()`, job); if (!submitted) throw new Error('EchoWave \u9875\u9762\u672a\u627e\u5230\u5f00\u59cb\u538b\u7f29\u6309\u94ae');
    report('rendering', 45, '\u7f51\u9875\u538b\u7f29 0%', { compressionPercent: 0 }); await waitForCompressionComplete(win, job, report);
    await waitWhilePaused(job); report('downloading', 97, '\u51c6\u5907\u4e0b\u8f7d'); const downloaded = await waitForDownload(win, file, options, job, report); const stat = await fs.stat(downloaded.outputPath); report('completed', 100, '');
    return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: true, outputPath: downloaded.outputPath, outputName: downloaded.outputName, originalBytes: file.size, finalBytes: stat.size };
  } catch (error) {
    if (job.removed) return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, removed: true, canceled: true, error: '\u5df2\u79fb\u9664' };
    if (isCanceled(job)) return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, canceled: true, error: '\u5df2\u505c\u6b62' };
    const uploadIncomplete = Number(job.uploadProgress?.percent) < 99;
    const failureStage = job.stage || job.lastProgress?.status;
    const failureProgress = currentProgress || (uploadIncomplete ? 10 + (Number(job.uploadProgress?.percent) || 0) * 0.25 : 0);
    const failureDetail = uploadIncomplete && job.uploadProgress?.detail ? `\u4e0a\u4f20\u5931\u8d25\uff1a${error.message} \u00b7 ${job.uploadProgress.detail}` : error.message;
    return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, error: error.message, failureStage: currentStage, detail: failureDetail, progress: failureProgress, uploadPercent: uploadIncomplete ? job.uploadProgress?.percent : undefined, uploadLoaded: job.uploadProgress?.loaded, uploadTotal: job.uploadProgress?.total, uploadSpeed: job.uploadProgress?.localSpeed, uploadEta: job.uploadProgress?.localEta };
  } finally {
    job.windows.delete(win); if (job.window === win) job.window = null;
    if (!win.isDestroyed()) { if (!win.webContents.isDestroyed() && win.webContents.debugger.isAttached()) { try { win.webContents.debugger.detach(); } catch {} } win.destroy(); }
  }
}
module.exports = { runEchoWaveVideo, outputPathFor, commitDownloadedFile };
