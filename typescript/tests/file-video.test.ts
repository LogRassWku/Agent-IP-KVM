import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  EndOfStream,
  FFmpegSource,
  VideoController,
  type VideoConfig,
} from "../src/video.js";
const require = createRequire(import.meta.url);
const ffmpeg: string = require("ffmpeg-static");
const ffprobe: string = require("ffprobe-static").path;
const exec = promisify(execFile);
test("real FFmpeg/ffprobe file playback, decodable frames, EOF and restart on Windows/Linux", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-kvm-file-"));
  const file = join(dir, "test video.avi");
  await exec(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=5",
      "-frames:v",
      "3",
      "-c:v",
      "mpeg4",
      "-q:v",
      "3",
      file,
    ],
    { windowsHide: true, timeout: 10000 },
  );
  const config: VideoConfig = {
    source: "file",
    file,
    device: "/dev/video0",
    width: 320,
    height: 240,
    fps: 5,
    ffmpeg,
    ffprobe,
  };
  const source = new FFmpegSource(config);
  const mode = await source.open();
  assert.equal(mode.width, 320);
  assert.equal(mode.fps, 5);
  await source.start();
  let count = 0;
  try {
    for (;;) {
      const frame = await source.nextFrame();
      assert.equal((await sharp(frame.data).metadata()).height, 240);
      count++;
    }
  } catch (e) {
    assert.ok(e instanceof EndOfStream, String(e));
  } finally {
    await source.close();
  }
  assert.equal(count, 3);
  assert.equal(source.health, "closed");
  await source.open();
  await source.start();
  assert.equal((await source.nextFrame()).sequence, 0);
  await source.close();
  const video = new VideoController(config);
  const one = await video.snapshot();
  assert.equal(one.metadata.on_demand, true);
  assert.equal(one.metadata.width, 320);
  await video.close();
  const unavailable = new FFmpegSource({
    ...config,
    ffmpeg: join(dir, "missing-ffmpeg"),
  });
  await unavailable.open();
  await unavailable.start();
  await assert.rejects(unavailable.nextFrame(), /ENOENT/);
  await unavailable.close();
});
test("file adapter fails clearly for missing local files", async () => {
  const missing = new FFmpegSource({
    source: "file",
    file: join(tmpdir(), "not-an-agent-kvm-file.mp4"),
    device: "/dev/video0",
    width: 1,
    height: 1,
    fps: 1,
    ffprobe,
  });
  await assert.rejects(missing.open());
  await missing.close();
});
