const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { chromium } = require('playwright');
const Busboy = require('busboy');

const PORT = Number(process.env.PORT || 3478);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const JOB_ROOT = path.join(os.tmpdir(), 'echowave-compressor');
const PROFILE_DIR = path.join(ROOT, '.echowave-browser-profile');
const MAX_CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.ECHOWAVE_CONCURRENCY || 2)));
const jobs = new Map();
const queue = [];
let activeJobs = 0;
let browserContextPromise;

const PRESETS = new Set(['light', 'balanced', 'aggressive', 'maximum']);
const PRESET_LABELS = { light: '轻度压缩', balanced: '平衡（推荐）', aggressive: '激进', maximum: '最大化' };
const VIDEO_CODECS = new Set(['auto', 'h264', 'h265', 'av1', 'copy']);
const AUDIO_CODECS = new Set(['auto', 'aac', 'ac3', 'mp3', 'copy']);

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function safeName(value, fallback = 'video') { const name = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim(); return name || fallback; }
function baseName(name) { return path.parse(safeName(name)).name || 'video'; }
function resolveChrome() { const candidates = process.env.ECHOWAVE_BROWSER ? [process.env.ECHOWAVE_BROWSER] : ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']; return candidates.find((p) => fs.existsSync(p)); }
async function getBrowserContext() { if (!browserContextPromise) { browserContextPromise = (async () => { await fsp.mkdir(PROFILE_DIR, { recursive: true }); return chromium.launchPersistentContext(PROFILE_DIR, { headless: process.env.SHOW_BROWSER !== '1', executablePath: resolveChrome(), acceptDownloads: true, downloadsPath: path.join(JOB_ROOT, 'downloads'), viewport: { width: 1365, height: 900 }, locale: 'zh-CN' }); })(); } return browserContextPromise; }
async function waitForText(page, text, timeout = 60000) { await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }); }
async function clickUnique(locator, label) { const count = await locator.count(); if (count !== 1) throw new Error(`${label}控件数量异常（${count}）`); await locator.click(); }
async function selectIfPresent(page, selectors, value) { for (const selector of selectors) { const locator = page.locator(selector); if (await locator.count() === 1) { const options = await locator.locator('option').evaluateAll((xs) => xs.map((x) => x.value)); if (options.includes(value)) { await locator.selectOption(value); return true; } } } return false; }
async function configureEchoWave(page, settings) {
  if (settings.mode === 'advanced') {
    await clickUnique(page.getByRole('button', { name: '高级', exact: true }), '高级模式');
    const crf = page.locator('#quality-slider'); if (settings.crf && await crf.count() === 1) await crf.fill(String(Math.max(18, Math.min(32, Number(settings.crf) || 23))));
    if (settings.resolution) await selectIfPresent(page, ['#resolution-select'], settings.resolution);
    if (settings.framerate) await selectIfPresent(page, ['#framerate-select'], settings.framerate);
  } else {
    const preset = PRESETS.has(settings.preset) ? settings.preset : 'balanced';
    await clickUnique(page.getByRole('button', { name: PRESET_LABELS[preset], exact: false }), '压缩方案');
  }
  const videoCodec = VIDEO_CODECS.has(settings.videoCodec) ? settings.videoCodec : 'auto';
  const audioCodec = AUDIO_CODECS.has(settings.audioCodec) ? settings.audioCodec : 'auto';
  const codecToggle = page.locator('button.w-full.flex.items-center.justify-between').filter({ hasText: '高级编码器' });
  if (await codecToggle.count() === 1) {
    const expanded = await codecToggle.getAttribute('aria-expanded');
    if (expanded !== 'true') await codecToggle.click();
    await selectIfPresent(page, ['#tool-video-codec'], videoCodec);
    await selectIfPresent(page, ['#tool-audio-codec'], audioCodec);
  }
}
async function waitForCompleted(page, timeout = 60 * 60 * 1000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await page.getByText('压缩完成', { exact: false }).count() || await page.getByText('完成 🎉', { exact: false }).count()) return; await page.waitForTimeout(1500); } throw new Error('EchoWave 处理超时，页面仍未显示完成结果。'); }
async function downloadEchoWaveResult(page, job, originalName) { job.status = 'downloading'; job.progress = 97; const download = page.waitForEvent('download', { timeout: 180000 }); const button = page.getByRole('button', { name: '下载', exact: true }); if (await button.count() !== 1) throw new Error('未找到 EchoWave 的下载按钮。'); await button.click(); const item = await download; const suggested = item.suggestedFilename() || 'compressed.mp4'; const ext = path.extname(suggested) || '.mp4'; const outputName = `${baseName(originalName)}${ext}`; const outputPath = path.join(job.dir, outputName); await item.saveAs(outputPath); const stat = await fsp.stat(outputPath); job.status = 'completed'; job.progress = 100; job.outputName = outputName; job.outputSize = stat.size; }
async function runEchoWave(job, upload, settings) { const context = await getBrowserContext(); const page = await context.newPage(); page.setDefaultTimeout(60000); try { job.status = 'opening'; job.progress = 5; await page.goto('https://echowave.io/app/tools/compress', { waitUntil: 'domcontentloaded', timeout: 90000 }); job.status = 'uploading'; job.progress = 10; await page.locator('#dropzone-file').setInputFiles(upload.path); await waitForText(page, '已上传', 120000); job.progress = 35; await configureEchoWave(page, settings); job.status = 'submitting'; job.progress = 40; await clickUnique(page.locator('button[type="submit"]'), '开始压缩'); job.status = 'rendering'; job.progress = 45; await waitForCompleted(page); await downloadEchoWaveResult(page, job, upload.originalName); } finally { await page.close().catch(() => {}); await fsp.rm(upload.path, { force: true }).catch(() => {}); } }
function pumpQueue() { while (activeJobs < MAX_CONCURRENCY && queue.length) { const item = queue.shift(); activeJobs += 1; item.job.queuePosition = 0; runEchoWave(item.job, item.upload, item.settings).catch((e) => { item.job.status = 'error'; item.job.error = e.message; }).finally(() => { activeJobs -= 1; pumpQueue(); }); } queue.forEach((item, index) => { item.job.queuePosition = index + 1; if (item.job.status === 'queued') item.job.progress = 0; }); }
function enqueue(job, upload, settings) { queue.push({ job, upload, settings }); pumpQueue(); }
function handleCompress(req, res) { const id = crypto.randomUUID(); const dir = path.join(JOB_ROOT, id); fs.mkdirSync(dir, { recursive: true }); const fields = {}; let upload; const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 4 * 1024 * 1024 * 1024 } }); busboy.on('field', (name, value) => { fields[name] = value; }); busboy.on('file', (name, file, info) => { if (name !== 'file') return file.resume(); const originalName = safeName(info.filename || fields.originalName || 'video.mp4'); const inputPath = path.join(dir, `input${path.extname(originalName) || '.bin'}`); const stream = fs.createWriteStream(inputPath); let size = 0; file.on('data', (chunk) => { size += chunk.length; }); file.pipe(stream); upload = { path: inputPath, originalName, size, writeDone: new Promise((resolve, reject) => { stream.on('finish', resolve); stream.on('error', reject); }) }; }); busboy.on('error', (e) => json(res, 400, { error: e.message })); busboy.on('finish', async () => { if (!upload) return json(res, 400, { error: '没有收到视频文件' }); await upload.writeDone; const job = { id, dir, status: 'queued', progress: 0, inputName: upload.originalName, createdAt: Date.now() }; jobs.set(id, job); enqueue(job, upload, { mode: fields.mode, preset: fields.preset, crf: fields.crf, resolution: fields.resolution, framerate: fields.framerate, videoCodec: fields.videoCodec || 'auto', audioCodec: fields.audioCodec || 'auto' }); json(res, 202, { jobId: id, maxConcurrency: MAX_CONCURRENCY }); }); req.pipe(busboy); }
function publicJob(job) { return { jobId: job.id, status: job.status, progress: job.progress, queuePosition: job.queuePosition || 0, inputName: job.inputName, outputName: job.outputName, outputSize: job.outputSize, error: job.error }; }
function sendDownload(res, filePath) { fs.stat(filePath, (e, stat) => { if (e) return json(res, 404, { error: '文件不存在' }); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`, 'Cache-Control': 'no-store' }); fs.createReadStream(filePath).pipe(res); }); }
function serveStatic(req, res) { const pathname = new URL(req.url, `http://${req.headers.host}`).pathname; const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const file = path.resolve(PUBLIC_DIR, rel); if (!file.startsWith(path.resolve(PUBLIC_DIR))) return json(res, 403, { error: 'Forbidden' }); const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(file)] || 'application/octet-stream'; fs.readFile(file, (e, data) => { if (e) return json(res, 404, { error: '文件不存在' }); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data); }); }
const server = http.createServer((req, res) => { const url = new URL(req.url, `http://${req.headers.host}`); if (req.method === 'POST' && url.pathname === '/api/compress') return handleCompress(req, res); if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) { const parts = url.pathname.split('/'); const job = jobs.get(parts[3]); if (!job) return json(res, 404, { error: '任务不存在或已过期' }); if (parts[4] === 'download') { if (job.status !== 'completed') return json(res, 409, { error: '压缩尚未完成' }); return sendDownload(res, path.join(job.dir, job.outputName)); } return json(res, 200, publicJob(job)); } if (req.method === 'GET') return serveStatic(req, res); json(res, 404, { error: 'Not found' }); });
fs.mkdirSync(JOB_ROOT, { recursive: true }); server.listen(PORT, () => console.log(`EchoWave web automation running at http://localhost:${PORT} (concurrency=${MAX_CONCURRENCY}, visible=${process.env.SHOW_BROWSER === '1'})`));
