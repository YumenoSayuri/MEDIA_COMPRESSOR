const { BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

// EchoWave 2026-11 改版后，基础方案按钮的文案变成「轻度 ≈ 22 KB / 均衡 ≈ 22 KB /
// 推荐 高强度 ≈ 22 KB / 最大 ≈ 22 KB」，旧的「轻度压缩 / 平衡（推荐）/ 激进 / 最大化」已不存在。
const PRESET_LABELS = { light: '\u8f7b\u5ea6', balanced: '\u5747\u8861', aggressive: '\u9ad8\u5f3a\u5ea6', maximum: '\u6700\u5927' };
const COMPRESS_BUTTON = '\u538b\u7f29\u89c6\u9891';
// EchoWave 免费档每天 3 次，用完后整块工具被一张墙取代（2026-11 实测）。
const QUOTA_WALL_MESSAGE = 'EchoWave \u4eca\u5929 3 \u6b21\u514d\u8d39\u5904\u7406\u5df2\u7528\u5b8c\uff08\u7ad9\u70b9\u63d0\u793a\u300c\u514d\u8d39\u6b21\u6570\u5c06\u5728\u5348\u591c\u6062\u590d\u300d\uff09\u3002\u8bf7\u6362\u4e00\u4e2a\u8d26\u53f7\uff0c\u6216\u7b49\u989d\u5ea6\u6062\u590d\u540e\u518d\u8dd1';
// 额度按 Firebase UID 计，换身份（清掉分区里的登录/匿名身份 → 重新匿名注册）就能拿到新的 3 次。
const QUOTA_CODE = 'quota_exhausted';
const DEFAULT_IDENTITY_ROTATIONS = 20;
function quotaError() {
  const error = new Error(QUOTA_WALL_MESSAGE);
  error.code = QUOTA_CODE;
  return error;
}
const VIDEO_CODECS = new Set(['auto', 'h264', 'h265', 'av1', 'copy']);
const AUDIO_CODECS = new Set(['auto', 'aac', 'ac3', 'mp3', 'copy']);
const claimedDownloadItems = new WeakSet();
const ECHOWAVE_PARTITION = 'persist:echowave-video-v2';

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
// EchoWave 的登录/匿名鉴权走 Firebase（identitytoolkit.googleapis.com），该域名在
// 中国大陆直连不通，会让上传直接报 not_authenticated。这里给 EchoWave 分区单独设置代理。
async function applySessionProxy(options) {
  const rules = String(options?.proxy ?? process.env.ECHOWAVE_PROXY ?? '').trim();
  const target = session.fromPartition(ECHOWAVE_PARTITION);
  if (!rules) return '';
  await target.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
  return rules;
}
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
  const eta = progress?.localEta !== null && progress?.localEta !== undefined && Number.isFinite(Number(progress.localEta))
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
// ==== EchoWave 2026-11 改版后的页面事实（实测记录见 README「EchoWave 改版适配」）====
// 步骤条：01 上传视频 → 02 选择选项 → 03 渲染 → 04 下载
// 上传中：正文「正在上传您的文件...」「即将完成…」，提交按钮文案为「压缩视频 上传完成后开始」
// 上传完成：提交按钮文案变成「压缩视频」，并且不再是 button[type="submit"]（现在是 type=button）
// 渲染中：正文「正在压缩… 95%」，进度条是带 aria-valuenow 的 div
// 完成页：「你的视频已就绪」+「下载」+「更改设置」，并显示「今日免费处理还剩 N 次（共 3 次）」
// 付费墙：未登录或当日免费额度用尽时 URL 带 ?ew_modal=upgrade 并弹出升级弹窗
const PAGE_STATE_PROBE = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const text = (document.body && document.body.innerText || '').replace(/\\u00a0/g, ' ');
  const controls = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const labels = controls.map((el) => (el.innerText || el.textContent || '').trim());
  const buttons = [...document.querySelectorAll('button')].filter(visible)
    .map((el) => ({ text: (el.innerText || '').trim(), disabled: Boolean(el.disabled) }))
    .filter((item) => item.text);
  const compressButton = buttons.find((item) => /^压缩视频/.test(item.text)) || null;
  const downloadControl = controls.find((el) => /^(?:下载|download)$/i.test((el.innerText || '').trim())) || null;
  const hasChangeSettings = labels.some((label) => /更改设置/.test(label));
  const ready = /你的视频已就绪/.test(text) || Boolean(downloadControl && hasChangeSettings);
  // 上传阶段那条 3px 进度条同样带 role="progressbar"（aria-label 是「正在上传您的文件...」），
  // 必须先把它排掉，否则会把上传误判成「已经在渲染」。
  const uploadBarLabel = (el) => String(el.getAttribute('aria-label') || '') + ' ' + String(el.innerText || '') + ' ' + String(el.className || '');
  const progressBars = [...document.querySelectorAll('[aria-valuenow],[role="progressbar"]')]
    .filter(visible)
    .filter((el) => !/上传|upload/i.test(uploadBarLabel(el)));
  let barPercent = null;
  for (const el of progressBars) {
    const value = Number(el.getAttribute('aria-valuenow'));
    if (Number.isFinite(value) && value >= 0 && value <= 100) { barPercent = Math.max(barPercent === null ? 0 : barPercent, value); continue; }
    const width = String((el.style && el.style.width) || (((el.querySelector('[style*="width"]') || {}).style || {}).width) || '').match(/([\\d.]+)%/);
    if (width) barPercent = Math.max(barPercent === null ? 0 : barPercent, Number(width[1]));
  }
  const textPercent = text.match(/(?:正在压缩|正在渲染|渲染中|压缩中)[^%\\d]{0,40}(\\d{1,3}(?:\\.\\d+)?)\\s*%/);
  const percent = textPercent ? Number(textPercent[1]) : barPercent;
  const uploading = /正在上传您的文件|即将完成|正在上传|finalizing(?: your)? upload|上传完成后开始/i.test(text);
  const rendering = /正在压缩|正在渲染|渲染视频可能需要|compressing|rendering your video/i.test(text);
  const errorMatch = text.match(/处理错误\\s*([^\\n]{0,160})/);
  const quotaMatch = text.match(/今日免费处理还剩\\s*(\\d+)\\s*次/);
  const quotaLastFree = /这是你今天最后一次免费处理/.test(text);
  // 额度用尽时整块工具会被一张墙取代：「今天的 3 次免费处理已用完 … 免费次数将在午夜恢复」
  const quotaExhausted = /今天的?\\s*\\d+\\s*次免费处理已用完|次免费处理已用完|免费次数将在午夜恢复|免费次数已用完/.test(text);
  const paywallModal = /ew_modal=upgrade/.test(location.search) || quotaExhausted || Boolean([...document.querySelectorAll('[role="dialog"],dialog')].find((el) => visible(el) && /升级|订阅|Unlock/i.test(el.innerText || '')));
  const phase = quotaExhausted ? 'quota_exhausted'
    : ready ? 'completed'
    : errorMatch ? 'error'
    : uploading ? 'uploading'
    : rendering ? 'rendering'
    : compressButton && !compressButton.disabled && compressButton.text === '压缩视频' ? 'configuring'
    : document.querySelector('#dropzone-file') ? 'uploading'
    : 'unknown';
  return {
    phase, percent, uploading, rendering, ready,
    error: errorMatch ? errorMatch[1].replace(/\\s+/g, ' ').trim() : '',
    quotaRemaining: quotaMatch ? Number(quotaMatch[1]) : null,
    quotaLastFree, quotaExhausted, paywallModal,
    compressButton, hasDownload: Boolean(downloadControl),
    text: text.replace(/\\s+/g, ' ').slice(0, 1200)
  };
})()`;

function explainPageError(raw) {
  const value = String(raw || '').trim();
  if (/not_authenticated/i.test(value)) {
    return 'EchoWave 拒绝请求：not_authenticated（Firebase 鉴权失败）。通常是本机直连不通 identitytoolkit.googleapis.com，请给 EchoWave 会话设置代理（ECHOWAVE_PROXY 或设置里的代理），或在弹出的窗口里登录一次后再试';
  }
  if (/connection hiccup|network|internet/i.test(value)) return `EchoWave 报网络抖动：${value}（可重试）`;
  if (/quota|limit|exceed/i.test(value)) return `EchoWave 报额度受限：${value}`;
  return value ? `EchoWave 处理错误：${value}` : '';
}
async function readEchoWavePagePhase(win, job) {
  return evaluate(win, PAGE_STATE_PROBE, job);
}
async function readCompressionProgress(win, job) {
  const state = await readEchoWavePagePhase(win, job);
  return {
    ...state,
    renderPage: state.rendering,
    failure: state.quotaExhausted ? '今日免费处理次数已用完' : state.error
  };
}
async function waitForCompressionComplete(win, job, onProgress) {
  const started = Date.now();
  const submitTimeout = 3 * 60 * 1000;
  const stagnantTimeout = 20 * 60 * 1000;
  const indeterminateTimeout = 30 * 60 * 1000;
  const absoluteTimeout = 2 * 60 * 60 * 1000;
  let renderStartedAt = null;
  let lastPercent = 0;
  let lastIncreaseAt = started;
  let consecutiveReadErrors = 0;
  let lastReadError = '';
  let quotaRemaining = null;
  let paywallSeen = false;
  while (Date.now() - started < absoluteTimeout) {
    assertActive(win, job);
    let info;
    try {
      info = await readCompressionProgress(win, job);
      consecutiveReadErrors = 0;
      lastReadError = '';
    } catch (error) {
      if (isCanceled(job)) throw error;
      consecutiveReadErrors += 1;
      lastReadError = error?.message || String(error);
      if (consecutiveReadErrors >= 15) throw new Error(`连续无法读取 EchoWave 页面状态：${lastReadError}`);
      info = { percent: null, phase: 'unknown', text: '', failure: '', quotaRemaining: null };
    }
    if (info.failure) throw new Error(explainPageError(info.failure) || info.failure);
    if (info.phase === 'quota_exhausted') throw quotaError();
    if (Number.isFinite(info.quotaRemaining)) quotaRemaining = info.quotaRemaining;
    if (info.paywallModal) paywallSeen = true;
    if (info.phase === 'completed') {
      const quotaNote = quotaRemaining === null ? '' : ` · 今日剩余免费 ${quotaRemaining} 次`;
      const paywallNote = info.paywallModal ? ' · 页面同时弹出升级提示（不影响下载）' : '';
      onProgress('rendering', 97, `网页压缩 100%${quotaNote}${paywallNote}`, {
        compressionPercent: 100,
        compressionPercentSource: 'web-dom',
        quotaRemaining
      });
      return { quotaRemaining, paywallModal: Boolean(info.paywallModal) };
    }
    const hasWebPercent = Number.isFinite(info.percent);
    if (info.phase !== 'rendering' && !hasWebPercent) {
      // 已经点过「压缩视频」，页面既没进入渲染也没给百分比：先判断是不是被升级弹窗挡住。
      if (info.paywallModal && Date.now() - started >= 20000) {
        throw new Error('EchoWave 弹出升级窗（?ew_modal=upgrade），今日免费处理次数可能已用完。请更换账号或等额度重置后再试');
      }
      if (Date.now() - started >= submitTimeout) {
        const pageHint = String(info.text || '').slice(0, 180);
        throw new Error(`提交压缩后 3 分钟仍未进入 EchoWave 渲染页面${pageHint ? `：${pageHint}` : ''}`);
      }
      onProgress('submitting', 40, '等待 EchoWave 进入网页压缩页面');
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!renderStartedAt) { renderStartedAt = Date.now(); lastIncreaseAt = renderStartedAt; }
    const rawPercent = hasWebPercent ? Math.min(100, Number(info.percent)) : lastPercent;
    if (rawPercent > lastPercent + 0.05) { lastPercent = rawPercent; lastIncreaseAt = Date.now(); }
    const percent = Math.max(lastPercent, rawPercent);
    lastPercent = percent;
    const quotaDetail = quotaRemaining === null ? '' : ` · 今日剩余免费 ${quotaRemaining} 次`;
    const webDetail = hasWebPercent ? `网页压缩 ${Math.round(percent)}%${quotaDetail}` : `网页压缩中${quotaDetail}`;
    onProgress('rendering', hasWebPercent ? 45 + percent * 0.52 : 45, webDetail, {
      compressionPercent: hasWebPercent ? percent : null,
      compressionPercentSource: hasWebPercent ? 'web-dom' : 'web-phase',
      quotaRemaining
    });
    const stagnantFor = Date.now() - lastIncreaseAt;
    if (hasWebPercent && lastPercent < 1 && Date.now() - renderStartedAt >= 10 * 60 * 1000) throw new Error('EchoWave 网页压缩连续 10 分钟仍为 0%，任务可能已卡死，请重试');
    if (hasWebPercent && lastPercent >= 1 && stagnantFor >= stagnantTimeout) throw new Error(`EchoWave 网页压缩连续 20 分钟停在 ${Math.round(lastPercent)}%，任务可能已卡死，请重试`);
    if (!hasWebPercent && Date.now() - renderStartedAt >= indeterminateTimeout) throw new Error('EchoWave 网页连续 30 分钟未提供压缩进度且尚未完成，已结束本次尝试并准备重试');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待 EchoWave 压缩完成超过 2 小时，已结束本次尝试并准备重试${paywallSeen ? '（页面出现过升级弹窗）' : ''}`);
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
    const pagePhase = await readEchoWavePagePhase(win, job).catch(() => ({ phase: 'unknown' }));
    if (pagePhase.phase === 'rendering' || pagePhase.phase === 'completed') {
      return { transitioned: true, stage: pagePhase.phase, compressionPercent: 0 };
    }
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
    if (currentPercent >= 99.5 || (Number.isFinite(domPercent) && domPercent >= 99.5) || pageReady) sawCompleteBytes = true;
    const localEta = total > loaded && lastSpeed > 0 ? (total - loaded) / lastSpeed : null;
    const tracked = { ...progress, loaded, total, percent, localSpeed: lastSpeed, localEta };
    job.uploadProgress = { ...tracked, detail: formatUploadDetail(tracked, fileSize) };
    if (progress.failed) throw new Error(progress.error || '\u4e0a\u4f20\u5931\u8d25');
    onProgress('uploading', 10 + percent * 0.25, job.uploadProgress.detail, { uploadPercent: percent, uploadLoaded: loaded, uploadTotal: total, uploadSpeed: lastSpeed, uploadEta: localEta });
    if (pagePhase.phase === 'error') throw new Error(explainPageError(pagePhase.error) || 'EchoWave 页面报错');
    if (pagePhase.phase === 'quota_exhausted') throw quotaError();
    // The submit button is already visible while the upload is still running.
    // It is therefore not a valid upload-complete signal by itself.
    // `loadend` is emitted for every XHR/chunk, not only for the whole file.
    // Never treat that flag alone as completion; require the full-size upload
    // (or EchoWave's explicit completion/finalizing text).
    const uploadEvidence = Boolean(progress.domDone || progress.finalizing || sawCompleteBytes
      || (progress.done && currentPercent >= 99.5));
    // 2026-11 改版后没有 button[type="submit"] 了：上传期间按钮文案是
    // 「压缩视频 上传完成后开始」，上传落地后文案才变成「压缩视频」，这是唯一可靠信号。
    const compressButtonReady = Boolean(pagePhase.compressButton
      && pagePhase.compressButton.text === COMPRESS_BUTTON
      && !pagePhase.compressButton.disabled);
    const uploadReady = compressButtonReady || (uploadEvidence && pagePhase.phase === 'configuring'
      && await evaluate(win, `Boolean(document.querySelector('button[type="submit"]'))`, job).catch(() => false));
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
      return { action: 'allow', overrideBrowserWindowOptions: { show: Boolean(options.showBrowser), webPreferences: { partition: ECHOWAVE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } } };
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
const COMPRESS_URL = 'https://echowave.io/app/tools/compress';
// 站点/代理链路偶发 ERR_FAILED / ERR_CONNECTION_CLOSED，加载本身必须能重试，
// 否则一次网络抖动就会把整个任务判死。
async function loadCompressPage(win, job, attempts = 4) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    assertActive(win, job);
    try { await win.loadURL(COMPRESS_URL); return; }
    catch (error) {
      lastError = error;
      if (i >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new Error(`EchoWave 压缩页加载失败（已重试 ${attempts} 次）：${lastError?.message || lastError}`);
}
async function readAuthState(win, job) {  return evaluate(win, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible)
      .map((el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' '))
      .filter(Boolean).slice(0, 24);
    // 未登录（含匿名身份）时页头一定有「登录 / 注册」两个入口。
    return { signedOut: buttons.some((text) => text === '登录' || text === '注册'), buttons };
  })()`, job);
}
async function waitForEchoWaveLogin(win, job, report) {
  const initial = await readAuthState(win, job).catch(() => ({ signedOut: true }));
  if (!initial.signedOut) return true;
  report('opening', 6, '请在弹出的 EchoWave 窗口里登录（登录态会保存在本机，只需一次）');
  const started = Date.now();
  while (Date.now() - started < 5 * 60 * 1000) {
    assertActive(win, job);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await readAuthState(win, job).catch(() => null);
    if (current && !current.signedOut) { report('opening', 8, '已登录 EchoWave'); return true; }
  }
  return false;
}
async function runEchoWaveVideoAttempt({ file, options, job, onProgress }) {
  const outputFolder = options.saveMode === 'fixed' ? options.outputFolder : path.dirname(file.path);
  if (!outputFolder) return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, error: '\u5c1a\u672a\u9009\u62e9\u56fa\u5b9a\u8f93\u51fa\u76ee\u5f55' };
  await fs.mkdir(outputFolder, { recursive: true });
  const proxyRules = await applySessionProxy(options);
  const win = new BrowserWindow({ width: 1180, height: 820, show: Boolean(options.showBrowser), title: `EchoWave - ${path.basename(file.path)}`, webPreferences: { partition: ECHOWAVE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: Boolean(options.showBrowser), webPreferences: { partition: ECHOWAVE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } } }));
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
    report('opening', 5, proxyRules ? `通过代理 ${proxyRules} 打开 EchoWave` : '');
    await loadCompressPage(win, job);
    await waitFor(win, `(() => {
      const text = (document.body && document.body.innerText) || '';
      return Boolean(document.querySelector('#dropzone-file')) || /次免费处理已用完|免费次数将在午夜恢复/.test(text);
    })()`, job, 90000);
    const opened = await readEchoWavePagePhase(win, job).catch(() => null);
    if (opened && opened.quotaExhausted) throw quotaError();
    if (!await evaluate(win, `Boolean(document.querySelector('#dropzone-file'))`, job).catch(() => false)) {
      throw new Error(`EchoWave 压缩页结构异常，未找到上传控件${opened?.text ? `：${String(opened.text).slice(0, 160)}` : ''}`);
    }
    if (options.showBrowser) await waitForEchoWaveLogin(win, job, report);
    await installUploadProgressHook(win, job); await waitWhilePaused(job); report('uploading', 10, '\u51c6\u5907\u4e0a\u4f20'); await setFileInput(win, '#dropzone-file', file.path, job);
    const uploadState = await waitForUploadComplete(win, job, file.size, report);
    if (!uploadState?.transitioned) {
      await waitWhilePaused(job); report('configuring', 35, ''); await configure(win, options, job); await waitWhilePaused(job); report('submitting', 40, '');
      const submitted = await evaluate(win, `(() => {
        const label = ${JSON.stringify(COMPRESS_BUTTON)};
        const button = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === label && !el.disabled);
        if (!button) return false;
        button.click();
        return true;
      })()`, job);
      if (!submitted) throw new Error('EchoWave 页面未找到可点击的「压缩视频」按钮（上传可能还没落地，或站点又改版了）');
      report('submitting', 40, '\u7b49\u5f85 EchoWave \u8fdb\u5165\u7f51\u9875\u538b\u7f29\u9875\u9762', { compressionPercent: null });
    } else {
      report('rendering', 45, '\u7f51\u9875\u538b\u7f29\u4e2d', { compressionPercent: null });
    }
    const renderResult = await waitForCompressionComplete(win, job, report);
    await waitWhilePaused(job); report('downloading', 97, '\u51c6\u5907\u4e0b\u8f7d'); const downloaded = await waitForDownload(win, file, options, job, report); const stat = await fs.stat(downloaded.outputPath); report('completed', 100, renderResult?.quotaRemaining === null || renderResult?.quotaRemaining === undefined ? '' : `\u4eca\u65e5\u5269\u4f59\u514d\u8d39 ${renderResult.quotaRemaining} \u6b21`);
    return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: true, outputPath: downloaded.outputPath, outputName: downloaded.outputName, originalBytes: file.size, finalBytes: stat.size };
  } catch (error) {
    if (job.removed) return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, removed: true, canceled: true, error: '\u5df2\u79fb\u9664' };
    if (isCanceled(job)) return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, canceled: true, error: '\u5df2\u505c\u6b62' };
    const uploadIncomplete = Number(job.uploadProgress?.percent) < 99;
    const failureStage = job.stage || job.lastProgress?.status;
    const failureProgress = currentProgress || (uploadIncomplete ? 10 + (Number(job.uploadProgress?.percent) || 0) * 0.25 : 0);
    const failureDetail = uploadIncomplete && job.uploadProgress?.detail ? `\u4e0a\u4f20\u5931\u8d25\uff1a${error.message} \u00b7 ${job.uploadProgress.detail}` : error.message;
    return { taskId: file.taskId, path: file.path, relativePath: file.relativePath, ok: false, error: error.message, errorCode: error.code || '', failureStage: currentStage, detail: failureDetail, progress: failureProgress, uploadPercent: uploadIncomplete ? job.uploadProgress?.percent : undefined, uploadLoaded: job.uploadProgress?.loaded, uploadTotal: job.uploadProgress?.total, uploadSpeed: job.uploadProgress?.localSpeed, uploadEta: job.uploadProgress?.localEta };
  } finally {
    job.windows.delete(win); if (job.window === win) job.window = null;
    if (!win.isDestroyed()) { if (!win.webContents.isDestroyed() && win.webContents.debugger.isAttached()) { try { win.webContents.debugger.detach(); } catch {} } win.destroy(); }
  }
}
// 换身份会动同一个持久分区，多个隐藏窗口（默认并发 2）同时清会互相破坏，
// 所以全局串行化：同一时刻只允许一个任务在做身份轮换。
let identityRotationLock = Promise.resolve();
function withIdentityRotationLock(task) {
  const run = identityRotationLock.then(task, task);
  identityRotationLock = run.then(() => {}, () => {});
  return run;
}
// 清掉这个分区里的 Firebase 身份（cookie / localStorage / IndexedDB 里的 auth 记录），
// 下次打开页面站点会自动匿名注册一个新 UID，额度随之重置成新的一天 3 次。
async function rotateEchoWaveIdentity() {
  const target = session.fromPartition(ECHOWAVE_PARTITION);
  await target.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexeddb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache', 'appcache']
  });
  try { await target.clearCache(); } catch {}
  try { if (typeof target.clearAuthCache === 'function') await target.clearAuthCache(); } catch {}
}
async function runEchoWaveVideo(args) {
  const options = args?.options || {};
  const rotationEnabled = options.identityRotation !== false;
  const maxRotations = rotationEnabled
    ? Math.max(0, Math.min(200, Number(options.identityRotations ?? DEFAULT_IDENTITY_ROTATIONS)))
    : 0;
  let result = await runEchoWaveVideoAttempt(args);
  let rotations = 0;
  let consecutiveWalls = 0;
  while (!result.ok && result.errorCode === QUOTA_CODE && !result.canceled && !result.removed) {
    if (rotations >= maxRotations) {
      result = { ...result, error: `${QUOTA_WALL_MESSAGE}（自动换身份已用满 ${rotations} 次，请稍后再跑或换网络出口）` };
      break;
    }
    rotations += 1;
    args.onProgress('opening', 5, `今日免费额度已用完 · 切换第 ${rotations} 个匿名身份后继续（${rotations}/${maxRotations}）`);
    try { await withIdentityRotationLock(() => rotateEchoWaveIdentity()); }
    catch (error) {
      result = { ...result, error: `${QUOTA_WALL_MESSAGE}（清空身份失败：${error.message}）` };
      break;
    }
    result = await runEchoWaveVideoAttempt(args);
    if (result.ok) { result = { ...result, rotatedIdentities: rotations }; break; }
    if (result.errorCode === QUOTA_CODE) {
      consecutiveWalls += 1;
      if (consecutiveWalls >= 3) {
        result = { ...result, error: `${QUOTA_WALL_MESSAGE}（连续 ${consecutiveWalls} 个新身份都没有额度，站点可能已限制本网络创建匿名账号）` };
        break;
      }
    } else consecutiveWalls = 0;
  }
  return result;
}
module.exports = { runEchoWaveVideo, outputPathFor, commitDownloadedFile, rotateEchoWaveIdentity };

