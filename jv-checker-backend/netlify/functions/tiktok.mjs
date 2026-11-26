import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static');
const ffprobePackage = require('ffprobe-static');
const ffprobePath = ffprobePackage.path || ffprobePackage;
const MAX_DOWNLOAD_BYTES = 450 * 1024 * 1024;
const MAX_CONVERTED_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25_000;

// Netlify's modern function runtime requires a standard Web Response.
const json = (statusCode, body) => new Response(JSON.stringify(body), {
  status: statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

function runBinary(binary, args, timeoutMs = 40_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Media tool exited with code ${code}: ${stderr.slice(-1800)}`));
    });
  });
}

function validateTikTokUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('A valid TikTok URL is required.'); }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!['tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].includes(host)) {
    throw new Error('Only TikTok URLs are supported.');
  }
  return parsed.toString();
}

const TIKWM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.tikwm.com',
  'Referer': 'https://www.tikwm.com/',
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...TIKWM_HEADERS, ...(options.headers || {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`TikWM returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(data.msg || `TikWM request failed (HTTP ${response.status}).`);
  return data;
}

async function getTikwmData(url) {
  const result = await fetchJson(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  if (result.code !== 0 || !result.data) throw new Error(result.msg || 'TikTok information could not be retrieved.');
  return result.data;
}

function normalize(data) {
  const video = data.video || {};
  const author = data.author || {};
  const music = data.music || {};
  return {
    title: data.title || '', cover: video.cover || data.cover || '',
    author: { nickname: author.nickname || '', username: author.unique_id || author.uniqueId || '' },
    stats: {
      views: data.play_count ?? 0, likes: data.digg_count ?? 0,
      comments: data.comment_count ?? 0, favorites: data.collect_count ?? 0,
      shares: data.share_count ?? 0, downloads: data.download_count ?? 0,
    },
    video: {
      id: data.id || '', posted_at: data.create_time || null, region: data.region || '',
      width: video.width ?? null, height: video.height ?? null,
      resolution: video.width && video.height ? `${video.width}x${video.height}` : null,
      definition: video.definition || null, duration: video.duration ?? data.duration ?? null,
      codec: video.codec_type || null, bitrate: video.bitrate ?? null,
      size: video.size ?? data.size ?? null, hd_size: data.hd_size ?? null, original_width: video.origin_cover?.width ?? null,
      original_height: video.origin_cover?.height ?? null, vq_score: video.vq_score ?? null,
    },
    browser_resolution: null, browser_fps: null,
    sound: { title: music.title || '', artist: music.author || '', id: music.id || '', url: music.play || '' },
    tags: (data.challenge || []).map(item => item.title).filter(Boolean),
    downloads: { video: video.play || data.play || '', hd: video.hdplay || data.hdplay || '', audio: music.play || '' },
  };
}

async function downloadToFile(url, filePath) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Video download failed (HTTP ${response.status}).`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('Video is larger than the 450 MB processing limit.');
  let received = 0;
  const limited = new Readable({
    read() {},
  });
  const reader = response.body.getReader();
  const stream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) return this.push(null);
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          this.destroy(new Error('Video is larger than the 450 MB processing limit.'));
          return;
        }
        this.push(Buffer.from(value));
      } catch (error) { this.destroy(error); }
    },
  });
  await pipeline(stream, (await import('node:fs')).createWriteStream(filePath));
}

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jv-tiktok-'));
  try { return await callback(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function analyzeVideo(data, quality) {
  const standard = data.video?.play || data.play || data.video?.wmplay || data.wmplay;
  const hd = data.video?.hdplay || data.hdplay;
  // quality:"standard" probes the exact file the bot's Standard download button delivers.
  const sourceUrl = quality === 'standard' ? (standard || hd) : (hd || standard);
  if (!sourceUrl) throw new Error('TikWM did not provide a playable video URL.');
  return withTempDir(async dir => {
    const input = path.join(dir, 'input.mp4');
    await downloadToFile(sourceUrl, input);
    const { stdout } = await runBinary(ffprobePath, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', input,
    ], 35_000);
    const probe = JSON.parse(stdout);
    const stream = probe.streams?.find(item => item.codec_type === 'video') || {};
    const audio = probe.streams?.find(item => item.codec_type === 'audio') || null;
    const fpsValue = stream.avg_frame_rate && stream.avg_frame_rate !== '0/0' ? stream.avg_frame_rate : stream.r_frame_rate;
    let fps = null;
    if (fpsValue && fpsValue.includes('/')) {
      const [n, d] = fpsValue.split('/').map(Number);
      if (d) fps = Number((n / d).toFixed(3));
    }
    return {
      resolution: stream.width && stream.height ? `${stream.width}x${stream.height}` : null,
      width: stream.width ?? null, height: stream.height ?? null, fps,
      avg_frame_rate: stream.avg_frame_rate || null, nominal_frame_rate: stream.r_frame_rate || null,
      codec: stream.codec_name || null, profile: stream.profile || null,
      pixel_format: stream.pix_fmt || null, bitrate: Number(probe.format?.bit_rate || stream.bit_rate || 0) || null,
      duration: Number(probe.format?.duration || stream.duration || 0) || null,
      file_size: Number(probe.format?.size || 0) || null,
      video_codec: stream.codec_name || null, audio_codec: audio?.codec_name || null,
      container: probe.format?.format_name || null,
    };
  });
}

async function convertVideo(data, body) {
  const sourceUrl = data.video?.hdplay || data.hdplay || data.video?.play || data.play || data.video?.wmplay || data.wmplay;
  if (!sourceUrl) throw new Error('TikWM did not provide a playable video URL.');
  return withTempDir(async dir => {
    const input = path.join(dir, 'input.mp4');
    const output = path.join(dir, 'output.mp4');
    await downloadToFile(sourceUrl, input);
    const crf = Math.max(18, Math.min(32, Number(body.crf ?? 23) || 23));
    await runBinary(ffmpegPath, [
      '-y', '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264',
      '-preset', 'veryfast', '-crf', String(crf), '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', output,
    ], 45_000);
    const info = await stat(output);
    if (info.size > MAX_CONVERTED_BYTES) {
      throw new Error('The converted file is larger than the 4 MB API response limit. Use a VPS for larger conversions.');
    }
    const buffer = await readFile(output);
    return { filename: 'converted.mp4', content_type: 'video/mp4', size: info.size, base64: buffer.toString('base64') };
  });
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'Use POST.' });
  const secret = Netlify.env.get('API_SECRET') || process.env.API_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { ok: false, error: 'Unauthorized.' });
  }
  try {
    const body = await request.json();
    const url = validateTikTokUrl(body.url);
    const action = body.action || 'check';

    if (action === 'original_submit') {
      const form = new URLSearchParams({ url, web: '1' });
      const submitted = await fetchJson('https://www.tikwm.com/api/video/task/submit', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.tikwm.com/' }, body: form,
      });
      if (!submitted.data?.task_id) throw new Error(submitted.msg || 'Original-quality task could not be submitted.');
      return json(200, { ok: true, task_id: submitted.data.task_id });
    }

    if (action === 'original_status') {
      if (!body.task_id) return json(400, { ok: false, error: 'task_id is required.' });
      const result = await fetchJson(`https://www.tikwm.com/api/video/task/result?task_id=${encodeURIComponent(body.task_id)}`);
      const task = result.data || {};
      const detail = task.detail || task;
      return json(200, { ok: true, status: task.status || result.msg || 'processing',
        original_download: detail.play_url || detail.download_url || detail.play || null });
    }

    const data = await getTikwmData(url);
    if (action === 'check') return json(200, { ok: true, data: normalize(data) });
    if (action === 'analyze' || action === 'probe') {
      const media = await analyzeVideo(data, body.quality);
      return json(200, { ok: true, data: normalize(data), media });
    }
    if (action === 'convert') {
      const converted = await convertVideo(data, body);
      return json(200, { ok: true, converted });
    }
    return json(400, { ok: false, error: 'Unsupported action. Use check, analyze, probe, convert, original_submit, or original_status.' });
  } catch (error) {
    return json(500, { ok: false, error: error?.message || 'Something went wrong.' });
  }
};
