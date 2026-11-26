# JV Checker Node.js Backend (FFmpeg + FFprobe)

Netlify Node.js Function for TikTok metadata, media probing, and small-file MP4 conversion.

## Deploy
1. The backend lives in the `jv-checker-backend/` folder, which is the Netlify base directory.
2. Import the repository into Netlify.
3. Set `API_SECRET` in Site configuration → Environment variables. Use a long random secret.
4. Deploy. Netlify installs `ffmpeg-static` and `ffprobe-static`; `netlify.toml` includes their Linux x64 binaries in the function bundle.
5. Endpoint: `https://YOUR-SITE.netlify.app/.netlify/functions/tiktok`

Use `Authorization: Bearer YOUR_API_SECRET` and `Content-Type: application/json`.

## Actions

### Metadata (no FFmpeg needed)
```json
{"action":"check","url":"https://www.tiktok.com/@user/video/1234567890"}
```

### Analyze actual downloaded media with FFprobe
```json
{"action":"analyze","url":"https://www.tiktok.com/@user/video/1234567890"}
```
Returns actual media resolution, FPS, video/audio codec, pixel format, bitrate, duration, container and file size. `probe` is an alias for `analyze`.

### Convert to H.264 MP4 with FFmpeg
```json
{"action":"convert","url":"https://www.tiktok.com/@user/video/1234567890","crf":23}
```
Returns an MP4 as base64. `crf` is clamped to 18–32. The response is limited to 4 MB of converted video because large binary responses are not suitable for synchronous serverless functions.

### Original-quality task (submit and poll separately)
```json
{"action":"original_submit","url":"https://www.tiktok.com/@user/video/1234567890"}
```
Then poll with:
```json
{"action":"original_status","url":"https://www.tiktok.com/@user/video/1234567890","task_id":"TASK_ID_FROM_SUBMIT"}
```

## Important limitations
- This uses Linux x64 static FFmpeg/FFprobe binaries. Netlify's deployed function must use the compatible Linux x64 runtime.
- The function downloads at most 450 MB of source media, but a large download or conversion may still hit Netlify's execution-time, memory, bandwidth, or function-size limits.
- FFmpeg conversion is limited to a 4 MB output response. For normal full-size TikTok video conversions, long videos, 4K, or concurrent jobs, use a VPS (for example, a Linux server) and let Netlify call that service.
- Browser playback resolution/FPS are not the same as FFprobe values. FFprobe reports the properties of the actual stream/file downloaded from TikWM. TikTok Browser Type playback is not independently resolved by this function.
- TikWM is a third-party service; availability and returned fields may change.


## Runtime response compatibility fix
The function returns standard Web `Response` objects (including JSON error responses), as required by Netlify's modern function runtime.
