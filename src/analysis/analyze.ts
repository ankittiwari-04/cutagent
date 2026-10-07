import { spawn } from "node:child_process";

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

export type Silence = { start: number; end: number; duration: number };

export async function probe(file: string) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === "video");
  const a = j.streams.find((s: any) => s.codec_type === "audio");
  return {
    duration: parseFloat(j.format.duration),
    video: v && { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate },
    audio: a && { codec: a.codec_name, sampleRate: a.sample_rate },
  };
}

export async function detectSilences(file: string, noiseDb = -30, minDur = 0.5): Promise<Silence[]> {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-",
  ]);
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start: ([\d.]+)/.exec(line);
    if (s) start = parseFloat(s[1]);
    const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: parseFloat(e[1]), duration: parseFloat(e[2]) });
      start = null;
    }
  }
  return out;
}

export async function detectScenes(file: string, threshold = 0.4): Promise<number[]> {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-",
  ]);
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]));
}

export async function analyze(file: string) {
  const info = await probe(file);
  const [silences, sceneCuts] = await Promise.all([
    info.audio ? detectSilences(file) : Promise.resolve([]),
    info.video ? detectScenes(file) : Promise.resolve([]),
  ]);
  return { ...info, silences, sceneCuts };
}
