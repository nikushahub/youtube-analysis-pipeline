import { AbortTaskRunError } from "@trigger.dev/sdk";
import { z } from "zod";
import type { AnalysisSource, TranscriptResult, VideoAnalysis, VideoMetadata } from "./types.js";

const analysisSchema = z.object({
  summary: z.string().min(1),
  keyTakeaways: z.array(z.string()),
  actionItems: z.array(z.string()),
  topics: z.array(z.string()),
});

// Gemini's structured-output schema (OpenAPI subset) — forces the model to return exactly this JSON shape.
const responseSchema = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "A clear 3-6 sentence summary of the video." },
    keyTakeaways: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "The 4-8 most important insights or facts from the video.",
    },
    actionItems: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Concrete, practical steps a viewer could take after watching. Empty if none apply.",
    },
    topics: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "3-6 short topic tags.",
    },
  },
  required: ["summary", "keyTakeaways", "actionItems", "topics"],
  propertyOrdering: ["summary", "keyTakeaways", "actionItems", "topics"],
};

// Gemini can watch a public YouTube video straight from its URL (free tier: up to 8 hours of video per day).
// At low media resolution that costs ~100 tokens per second of video, so cap the length to stay well inside
// the free tier's per-minute token limit. Longer videos fall back to title + description.
const MAX_VIDEO_SECONDS = 45 * 60;

function buildPrompt(metadata: VideoMetadata, source: string): string {
  return [
    "You are analyzing a YouTube video for a busy viewer who wants the useful parts without watching it.",
    "Write the analysis in English, even if the video is in another language.",
    "Be specific and factual. Only use information contained in the material below.",
    "",
    `TITLE: ${metadata.title}`,
    `CHANNEL: ${metadata.channelTitle}`,
    `DURATION: ${metadata.duration}`,
    `DESCRIPTION:\n${metadata.description.slice(0, 5000)}`,
    "",
    source,
  ].join("\n");
}

type GeminiPart = { text: string } | { fileData: { fileUri: string } };

async function generateAnalysis(params: {
  apiKey: string;
  model: string;
  parts: GeminiPart[];
  lowMediaResolution?: boolean;
}): Promise<VideoAnalysis> {
  const { apiKey, model, parts, lowMediaResolution } = params;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Key goes in a header (not the URL) so it can never leak into logged URLs.
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema,
          ...(lowMediaResolution ? { mediaResolution: "MEDIA_RESOLUTION_LOW" } : {}),
        },
      }),
    }
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const detail = body?.error?.message ?? response.statusText;
    // Bad key / unknown model / bad request will never fix themselves — don't burn retries or quota.
    if ([400, 401, 403, 404].includes(response.status)) {
      throw new AbortTaskRunError(
        `Gemini rejected the request (${response.status}): ${detail}. Check GEMINI_API_KEY and GEMINI_MODEL.`
      );
    }
    // 429 (free-tier rate limit) and 5xx are temporary — throwing a normal error lets Trigger.dev retry with backoff.
    throw new Error(`Gemini request failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    throw new AbortTaskRunError(`Gemini blocked this content: ${data.promptFeedback.blockReason}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) {
    throw new Error(`Gemini returned an empty response (finishReason: ${data.candidates?.[0]?.finishReason ?? "unknown"})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned text that is not valid JSON");
  }

  const result = analysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Gemini's answer had an unexpected shape: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Analyzes the video from the best source available:
 * 1. the transcript, if we got one;
 * 2. otherwise the video itself — Gemini watches it from the YouTube URL (works even when YouTube blocks
 *    caption downloads from Trigger.dev's servers);
 * 3. otherwise (video too long, daily video quota used up, Gemini busy) just the title + description.
 */
export async function analyzeWithGemini(params: {
  apiKey: string;
  model: string;
  metadata: VideoMetadata;
  transcript: TranscriptResult;
}): Promise<{ analysis: VideoAnalysis; source: AnalysisSource; videoError?: string }> {
  const { apiKey, model, metadata, transcript } = params;

  if (transcript.status === "available") {
    const source = `TRANSCRIPT${transcript.truncated ? " (truncated — the video is very long)" : ""}:\n${transcript.text}`;
    const analysis = await generateAnalysis({ apiKey, model, parts: [{ text: buildPrompt(metadata, source) }] });
    return { analysis, source: "transcript" };
  }

  let videoError: string | undefined;
  if (metadata.durationSeconds !== null && metadata.durationSeconds <= MAX_VIDEO_SECONDS) {
    try {
      const source =
        "THE VIDEO IS ATTACHED. Watch it (audio and visuals) and base the analysis on what is actually said and shown.";
      const analysis = await generateAnalysis({
        apiKey,
        model,
        parts: [{ fileData: { fileUri: metadata.url } }, { text: buildPrompt(metadata, source) }],
        lowMediaResolution: true,
      });
      return { analysis, source: "video" };
    } catch (error) {
      videoError = error instanceof Error ? error.message : String(error);
    }
  } else {
    videoError = `video is longer than ${MAX_VIDEO_SECONDS / 60} minutes (or its length is unknown)`;
  }

  const source =
    "NO TRANSCRIPT IS AVAILABLE. Base the analysis only on the title and description, keep it brief, and do not invent details that are not stated there.";
  const analysis = await generateAnalysis({ apiKey, model, parts: [{ text: buildPrompt(metadata, source) }] });
  return { analysis, source: "metadata", videoError };
}
