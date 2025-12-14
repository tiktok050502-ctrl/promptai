import { GoogleGenAI } from "@google/genai";
import { Script, VideoGenerationOptions, Scene } from '../types';

/**
 * Creates the GoogleGenAI client using the provided API key.
 */
function createAiClient(apiKey: string): GoogleGenAI {
    if (!apiKey) {
        throw new Error("Vui lòng nhập Google AI Studio API Key.");
    }
    return new GoogleGenAI({ apiKey: apiKey });
}

/**
 * Validates the provided API Key.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
    const key = apiKey ? apiKey.trim() : "";
    if (!key.startsWith("AIza")) return false;

    try {
        const ai = new GoogleGenAI({ apiKey: key });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [{ text: "ping" }] },
        });
        return !!response.text;
    } catch (e: any) {
        return false;
    }
}

// --- HELPER FUNCTIONS ---

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

function cleanAttribute(text: string | undefined | null): string {
    if (!text) return "";
    let t = text.trim();
    if (['không có', 'none', 'n/a', 'null', '', 'unknown'].includes(t.toLowerCase())) return "";
    t = t.replace(/^[,.\s]+|[,.\s]+$/g, ""); 
    t = t.replace(/(\r\n|\n|\r)/gm, " "); 
    return t.trim();
}

function cleanForJson(text: string | undefined | null): string {
    if (!text) return "";
    return text.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, " ").trim();
}

function mapBatchJsonToScenes(scenesArray: any[], startIndex: number): Scene[] {
    if (!Array.isArray(scenesArray)) return [];

    return scenesArray.map((item: any, idx: number) => {
        // FORCE SEQUENTIAL INDEXING
        const currentIndex = startIndex + idx;

        // Time
        const timeStart = item.time?.start ?? 0;
        const timeEnd = item.time?.end ?? 5;
        const timeLine = `Thời lượng: ${timeStart}s - ${timeEnd}s`;

        // Continuity
        const continuity = cleanAttribute(item.continuity_reference);
        const continuityLine = continuity ? `Tiếp nối: ${continuity}` : '';

        // Environment
        const location = cleanAttribute(item.environment?.location);
        const weather = cleanAttribute(item.environment?.weather);
        const sounds = Array.isArray(item.environment?.ambient_sound) 
            ? item.environment.ambient_sound.map(cleanAttribute).join(', ') 
            : cleanAttribute(item.environment?.ambient_sound);
        
        const envParts = [];
        if (location) envParts.push(`Địa điểm: ${location}`);
        if (weather) envParts.push(`Thời tiết: ${weather}`);
        if (sounds) envParts.push(`Âm thanh: ${sounds}`);
        const envLine = envParts.join(' | ');

        // Characters
        let charLine = '';
        if (item.characters && Array.isArray(item.characters)) {
            const chars = item.characters.map((c: any) => {
                const name = cleanAttribute(c.name);
                const app = cleanAttribute(c.appearance);
                const outfit = cleanAttribute(c.outfit);
                const emotion = cleanAttribute(c.emotion);
                const action = cleanAttribute(c.actions?.body_movement);
                
                let desc = name;
                if (app || outfit) desc += ` [${[app, outfit].filter(Boolean).join(', ')}]`;
                if (emotion) desc += ` (Cảm xúc: ${emotion})`;
                if (action) desc += ` -> Hành động: ${action}`;
                return desc;
            }).join('; '); 
            if (chars) charLine = `Nhân vật: ${chars}`;
        }

        // Camera & Style
        const shotType = cleanAttribute(item.camera?.shot_type);
        const camMove = cleanAttribute(item.camera?.movement);
        const cameraLine = (shotType || camMove) ? `Camera: ${shotType} | ${camMove}` : '';

        const styleName = cleanAttribute(item.visual_style?.style);
        const lighting = cleanAttribute(item.visual_style?.lighting);
        const styleLine = (styleName || lighting) ? `Visual: ${styleName} | Light: ${lighting}` : '';

        // Dialogue
        const line = cleanAttribute(item.dialogue?.line);
        const lang = cleanAttribute(item.dialogue?.language);
        const dialogueLine = line ? `Thoại (${lang}): "${line}"` : 'Thoại: Không có';

        // Description for UI
        const description = [
            `Cảnh ${currentIndex} (${timeLine})`,
            continuityLine,
            envLine,
            charLine,
            cameraLine,
            styleLine,
            dialogueLine
        ].filter(Boolean).join(' | ');

        // Strict JSON Prompt for Veo
        const jsonPrompt = {
            scene: currentIndex,
            time: item.time || { start: 0, end: 5 },
            continuity_reference: cleanForJson(item.continuity_reference),
            environment: {
                location: cleanForJson(item.environment?.location),
                weather: cleanForJson(item.environment?.weather),
                ambient_sound: Array.isArray(item.environment?.ambient_sound) 
                    ? item.environment.ambient_sound.map(cleanForJson)
                    : []
            },
            characters: (item.characters || []).map((c: any) => ({
                name: cleanForJson(c.name),
                appearance: cleanForJson(c.appearance),
                outfit: cleanForJson(c.outfit),
                emotion: cleanForJson(c.emotion),
                actions: { body_movement: cleanForJson(c.actions?.body_movement) }
            })),
            camera: {
                shot_type: cleanForJson(item.camera?.shot_type),
                movement: cleanForJson(item.camera?.movement)
            },
            visual_style: {
                style: cleanForJson(item.visual_style?.style),
                lighting: cleanForJson(item.visual_style?.lighting)
            },
            dialogue: {
                line: cleanForJson(item.dialogue?.line),
                language: cleanForJson(item.dialogue?.language)
            }
        };

        let rawWishk = item.wishk_prompt || "";
        rawWishk = cleanForJson(rawWishk);

        return {
            scene_number: currentIndex,
            script_description: description,
            veo_prompt: JSON.stringify(jsonPrompt), 
            wishk_prompt: rawWishk 
        };
    });
}

// --- CORE GENERATION LOGIC ---

async function generateBatchScenes(
    ai: GoogleGenAI,
    options: VideoGenerationOptions,
    startSceneNumber: number,
    count: number,
    previousVisualContext: string,
    storySummary: string,
    initialIdea: string
): Promise<{ scenes: any[], summary: string }> {

    const isFirstBatch = startSceneNumber === 1;

    let contextSection = "";
    if (isFirstBatch) {
        contextSection = `
        CORE IDEA: "${options.idea}"
        START: Begin Scene 1 according to the core idea.
        `;
    } else {
        contextSection = `
        CORE IDEA: "${initialIdea}"
        STORY SO FAR: "${storySummary}"
        
        CRITICAL - PREVIOUS SCENE ENDING VISUALS:
        "${previousVisualContext}"
        
        TASK: Start Scene ${startSceneNumber} EXACTLY where the previous scene ended.
        `;
    }

    // THIS IS THE SYSTEM PROMPT THAT ENFORCES SEAMLESS CONTINUITY
    const systemPrompt = `
You are a world-class AI Cinematographer specializing in SINGLE-TAKE / CONTINUOUS SHOT videos.
Your task is to generate JSON prompts for Scene ${startSceneNumber} to ${startSceneNumber + count - 1}.

${contextSection}

🔥🔥🔥 ABSOLUTE RULES FOR SEAMLESS CONTINUITY 🔥🔥🔥
1. **NO CUTS**: Treat this as a continuous video stream. Scene N starts *visually* exactly where Scene N-1 ended.
2. **LOCK ENVIRONMENT**: Do NOT change the location, background, time of day, or weather unless the characters physically travel there in the scene.
3. **LOCK CHARACTERS**: Characters must have the EXACT SAME appearance (clothes, hair, face) as described in the previous scene.
4. **FLOW**: If Scene 1 ends with a character raising a hand, Scene 2 MUST start with that hand raised.
5. **CAMERA**: Maintain smooth camera flow.

JSON OUTPUT STRUCTURE (Must be valid JSON):
{
  "story_summary": "Update the summary in Vietnamese",
  "scenes": [
    {
      "scene": <number>,
      "time": { "start": 0, "end": 5 },
      "continuity_reference": "Describe the EXACT visual state from the end of the previous scene to match here.",
      "environment": { "location": "SAME AS PREVIOUS", "weather": "SAME AS PREVIOUS", "ambient_sound": ["..."] },
      "characters": [
        { 
           "name": "...", 
           "appearance": "MUST MATCH PREVIOUS", 
           "outfit": "MUST MATCH PREVIOUS", 
           "emotion": "...", 
           "actions": { "body_movement": "Action that flows naturally from previous scene..." } 
        }
      ],
      "camera": { "shot_type": "...", "movement": "..." },
      "visual_style": { "style": "${options.videoStyle}", "lighting": "..." },
      "dialogue": { "line": "...", "language": "${options.dialogueLanguage}" },
      "wishk_prompt": "A detailed descriptive prompt in English/Vietnamese mix describing this specific frame moment."
    }
  ]
}
`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: { parts: [{ text: systemPrompt }] },
        config: { 
            responseMimeType: 'application/json',
            temperature: 0.4 // Lower temperature for more consistent/stable results
        }
    });

    if (!response.text) throw new Error("API returned empty response");
    const json = JSON.parse(response.text);

    return {
        scenes: json.scenes || [],
        summary: json.story_summary || storySummary || ""
    };
}

// --- RETRY WRAPPER ---

async function generateBatchWithRetry(
    ai: GoogleGenAI,
    options: VideoGenerationOptions,
    start: number,
    count: number,
    visualCtx: string,
    summary: string,
    initialIdea: string,
    onProgress: (msg: string) => void
) {
    let attempts = 0;
    const MAX_ATTEMPTS = 4;
    while (attempts < MAX_ATTEMPTS) {
        try {
            return await generateBatchScenes(ai, options, start, count, visualCtx, summary, initialIdea);
        } catch (error: any) {
            attempts++;
            const msg = error.message || String(error);
            console.warn(`Batch failed (Attempt ${attempts}):`, msg);

            if (msg.includes('429') || msg.includes('quota') || msg.includes('overloaded')) {
                onProgress(`Server đang bận, thử lại sau 5s (Lần ${attempts}/${MAX_ATTEMPTS})...`);
                await delay(5000);
            } else {
                if (attempts >= MAX_ATTEMPTS) throw error;
                await delay(2000);
            }
        }
    }
    throw new Error("Quá thời gian chờ. Vui lòng thử lại.");
}

// --- MAIN EXPORT ---

export async function generateScript(
    options: VideoGenerationOptions, 
    apiKey: string, 
    onProgress: (msg: string) => void
): Promise<Script> {
    const ai = createAiClient(apiKey);
    
    const BATCH_SIZE = 5; 
    
    let targetCount = typeof options.promptCount === 'string' 
        ? parseInt(options.promptCount, 10) 
        : options.promptCount;

    if (isNaN(targetCount) || targetCount <= 0) targetCount = 5;

    let allScenes: Scene[] = [];
    let storySummary = "";
    
    // Critical for seamlessness: We track the visual state of the LAST frame
    let lastVisualState = "Beginning of the video.";
    
    let consecutiveFailures = 0;

    while (allScenes.length < targetCount) {
        if (consecutiveFailures >= 5) {
             throw new Error("Không thể tạo đủ số lượng prompt sau nhiều lần thử.");
        }

        const remainingNeeded = targetCount - allScenes.length;
        const currentBatchSize = Math.min(BATCH_SIZE, remainingNeeded);
        const startSceneNum = allScenes.length + 1;

        onProgress(`Đang tạo liền mạch ${currentBatchSize} cảnh tiếp theo (Đã xong ${allScenes.length}/${targetCount})...`);

        try {
            const result = await generateBatchWithRetry(
                ai, 
                options, 
                startSceneNum, 
                currentBatchSize, 
                lastVisualState, // Pass the visual ending of previous batch
                storySummary,
                options.idea,
                onProgress
            );

            if (!storySummary) storySummary = result.summary;

            const processed = mapBatchJsonToScenes(result.scenes, startSceneNum);
            const scenesToAdd = processed.slice(0, remainingNeeded);

            if (scenesToAdd.length > 0) {
                allScenes = [...allScenes, ...scenesToAdd];
                
                // EXTRACT VISUAL STATE FOR NEXT BATCH
                const last = scenesToAdd[scenesToAdd.length - 1];
                // We construct a specific string that tells the next batch exactly how this one looked at the end
                lastVisualState = `
                LAST SCENE NUMBER: ${last.scene_number}
                LAST LOCATION: ${cleanAttribute(JSON.parse(last.veo_prompt).environment?.location)}
                LAST ACTION: ${cleanAttribute(JSON.parse(last.veo_prompt).characters?.[0]?.actions?.body_movement)}
                LAST OUTFIT: ${cleanAttribute(JSON.parse(last.veo_prompt).characters?.[0]?.outfit)}
                LAST CAMERA: ${cleanAttribute(JSON.parse(last.veo_prompt).camera?.shot_type)}
                `;
                
                consecutiveFailures = 0;
            } else {
                console.warn("Batch returned 0 valid scenes.");
                consecutiveFailures++;
            }

            if (allScenes.length < targetCount) {
                await delay(1500);
            }

        } catch (err: any) {
            console.error("Batch Error:", err);
            onProgress(`Gặp lỗi kết nối: ${err.message}. Đang thử lại...`);
            consecutiveFailures++;
            await delay(2000);
        }
    }

    return {
        story_summary: storySummary,
        scenes: allScenes
    };
}

export async function extendScript(
    lastScene: Scene,
    extensionIdea: string,
    count: number,
    originalOptions: VideoGenerationOptions,
    apiKey: string
): Promise<Scene[]> {
    const ai = createAiClient(apiKey);
    const BATCH_SIZE = 5;
    
    let newScenes: Scene[] = [];
    
    // Construct initial visual state from the actual last scene provided
    let lastVisualState = `
    LAST SCENE NUMBER: ${lastScene.scene_number}
    LAST LOCATION: ${cleanAttribute(JSON.parse(lastScene.veo_prompt).environment?.location)}
    LAST ACTION: ${cleanAttribute(JSON.parse(lastScene.veo_prompt).characters?.[0]?.actions?.body_movement)}
    LAST OUTFIT: ${cleanAttribute(JSON.parse(lastScene.veo_prompt).characters?.[0]?.outfit)}
    `;

    let consecutiveFailures = 0;
    const startNum = lastScene.scene_number + 1;
    const targetTotal = count;

    while (newScenes.length < targetTotal) {
        if (consecutiveFailures >= 5) {
             throw new Error("Không thể mở rộng đủ số lượng prompt.");
        }

        const remaining = targetTotal - newScenes.length;
        const batchSize = Math.min(BATCH_SIZE, remaining);
        const currentStartNum = startNum + newScenes.length;

        try {
            const result = await generateBatchWithRetry(
                ai,
                originalOptions,
                currentStartNum,
                batchSize,
                lastVisualState,
                "Continuing seamlessly...", 
                // Merge original idea with extension idea for context
                `${originalOptions.idea}. EXTENSION IDEA: ${extensionIdea}`, 
                (msg) => console.log(msg)
            );

            const processed = mapBatchJsonToScenes(result.scenes, currentStartNum);
            const toAdd = processed.slice(0, remaining);

            if (toAdd.length > 0) {
                newScenes = [...newScenes, ...toAdd];
                
                const last = toAdd[toAdd.length - 1];
                lastVisualState = `
                LAST SCENE NUMBER: ${last.scene_number}
                LAST LOCATION: ${cleanAttribute(JSON.parse(last.veo_prompt).environment?.location)}
                LAST ACTION: ${cleanAttribute(JSON.parse(last.veo_prompt).characters?.[0]?.actions?.body_movement)}
                LAST OUTFIT: ${cleanAttribute(JSON.parse(last.veo_prompt).characters?.[0]?.outfit)}
                `;

                consecutiveFailures = 0;
            } else {
                consecutiveFailures++;
            }
            
            if (newScenes.length < targetTotal) await delay(1500);

        } catch (e: any) {
            console.error(e);
            consecutiveFailures++;
            await delay(2000);
        }
    }

    return newScenes;
}