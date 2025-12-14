import { GoogleGenAI } from "@google/genai";
import { Script, VideoGenerationOptions, Scene } from "../types";

function createAiClient(apiKey: string): GoogleGenAI {
  if (!apiKey) throw new Error("Vui lòng nhập Google AI Studio API Key.");
  return new GoogleGenAI({ apiKey });
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  const key = apiKey.trim();
  if (!key.startsWith("AIza")) return false;

  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: { parts: [{ text: "ping" }] },
    });
    return !!response.text;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

function cleanAttribute(text?: string | null): string {
  if (!text) return "";
  let t = text.trim();
  if (
    ["không có", "none", "n/a", "null", "", "unknown"].includes(t.toLowerCase())
  )
    return "";
  t = t.replace(/^[,.\s]+|[,.\s]+$/g, "");
  t = t.replace(/(\r\n|\n|\r)/gm, " ");
  return t.trim();
}

function cleanForJson(text?: string | null): string {
  if (!text) return "";
  return text.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, " ").trim();
}

function mapJsonToScenes(rawScenes: any[]): Scene[] {
  return rawScenes.map((item: any, index: number) => {
    const time = item.time || { start: 0, end: 5 };
    const timeLine = `Thời lượng: ${time.start}s - ${time.end}s`;
    const continuity = cleanAttribute(item.continuity_reference);
    const env = item.environment || {};
    const location = cleanAttribute(env.location);
    const weather = cleanAttribute(env.weather);
    const sounds = Array.isArray(env.ambient_sound)
      ? env.ambient_sound.map(cleanAttribute).join(", ")
      : cleanAttribute(env.ambient_sound);
    const envLine = [location && `Địa điểm: ${location}`, weather && `Thời tiết: ${weather}`, sounds && `Âm thanh: ${sounds}`]
      .filter(Boolean)
      .join(" | ");

    let charLine = "";
    if (Array.isArray(item.characters)) {
      const chars = item.characters
        .map((c: any) => {
          const name = cleanAttribute(c.name);
          const app = cleanAttribute(c.appearance);
          const outfit = cleanAttribute(c.outfit);
          const emotion = cleanAttribute(c.emotion);
          const action = cleanAttribute(c.actions?.body_movement);
          let desc = name;
          if (app || outfit)
            desc += ` [${[app, outfit].filter(Boolean).join(", ")}]`;
          if (emotion) desc += ` (Cảm xúc: ${emotion})`;
          if (action) desc += ` -> Hành động: ${action}`;
          return desc;
        })
        .join("; ");
      if (chars) charLine = `Nhân vật: ${chars}`;
    }

    const shot = cleanAttribute(item.camera?.shot_type);
    const move = cleanAttribute(item.camera?.movement);
    const cameraLine = (shot || move) ? `Camera: ${shot} | ${move}` : "";
    const style = cleanAttribute(item.visual_style?.style);
    const light = cleanAttribute(item.visual_style?.lighting);
    const styleLine = (style || light) ? `Visual: ${style} | Light: ${light}` : "";
    const line = cleanAttribute(item.dialogue?.line);
    const lang = cleanAttribute(item.dialogue?.language);
    const dialogueLine = line ? `Thoại (${lang}): "${line}"` : "Thoại: Không có";

    const description = [
      `Cảnh ${index + 1} (${timeLine})`,
      continuity && `Tiếp nối: ${continuity}`,
      envLine,
      charLine,
      cameraLine,
      styleLine,
      dialogueLine,
    ]
      .filter(Boolean)
      .join(" | ");

    return {
      scene_number: index + 1,
      script_description: description,
      veo_prompt: JSON.stringify(item),
      wishk_prompt: cleanForJson(item.wishk_prompt),
    };
  });
}

async function generateBatchWithRetry(
  ai: GoogleGenAI,
  options: VideoGenerationOptions,
  start: number,
  count: number,
  context: string,
  summary: string,
  onProgress: (msg: string) => void
): Promise<{ scenes: any[]; summary: string }> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prompt = `
You are a video scriptwriter AI.
Generate ${count} scenes continuing from: ${context}
Idea: ${options.idea}
Style: ${options.videoStyle}
Language: Vietnamese
Return JSON with {story_summary, scenes:[...]}
      `;
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: { parts: [{ text: prompt }] },
        config: { responseMimeType: "application/json" },
      });
      if (!response.text) throw new Error("Empty response");
      const json = JSON.parse(response.text);
      return { scenes: json.scenes || [], summary: json.story_summary || "" };
    } catch (err: any) {
      if (attempt < MAX_RETRIES) {
        onProgress(`Thử lại lần ${attempt + 1}...`);
        await delay(2000);
      } else throw err;
    }
  }
  throw new Error("Không thể tạo nội dung.");
}

export async function generateScript(
  options: VideoGenerationOptions,
  apiKey: string,
  onProgress: (msg: string) => void
): Promise<Script> {
  const ai = createAiClient(apiKey);
  const total = Number(options.promptCount) || 5;
  let all: any[] = [];
  let summary = "";
  let context = "Bắt đầu câu chuyện.";

  for (let i = 0; i < total; i += 5) {
    const count = Math.min(5, total - all.length);
    onProgress(`Đang tạo ${count} cảnh (${all.length}/${total})...`);
    const result = await generateBatchWithRetry(
      ai,
      options,
      i + 1,
      count,
      context,
      summary,
      onProgress
    );
    summary = result.summary || summary;
    all = [...all, ...result.scenes];
    context = `Kết thúc cảnh ${all.length}`;
    await delay(1500);
  }

  return { story_summary: summary, scenes: mapJsonToScenes(all) };
}

export async function extendScript(
  lastScene: Scene,
  extensionIdea: string,
  count: number,
  options: VideoGenerationOptions,
  apiKey: string
): Promise<Scene[]> {
  const ai = createAiClient(apiKey);
  const prompt = `
Tiếp tục kịch bản sau cảnh ${lastScene.scene_number}.
Ý tưởng mở rộng: ${extensionIdea}
Sinh ra ${count} cảnh mới theo cùng phong cách.
Trả về JSON {scenes:[...]}
  `;
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: { parts: [{ text: prompt }] },
    config: { responseMimeType: "application/json" },
  });
  if (!res.text) throw new Error("No response");
  const json = JSON.parse(res.text);
  return mapJsonToScenes(json.scenes || []).map((s, i) => ({
    ...s,
    scene_number: lastScene.scene_number + i + 1,
  }));
}
