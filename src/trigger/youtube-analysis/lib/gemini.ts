import { AbortTaskRunError } from "@trigger.dev/sdk";
import { z } from "zod";
import type { TranscriptResult, VideoAnalysis, VideoMetadata } from "./types.js";

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

function buildPrompt(metadata: VideoMetadata, transcript: TranscriptResult): string {
  const source =
    transcript.status === "available"
      ? `TRANSCRIPT${transcript.truncated ? " (truncated — the video is very long)" : ""}:\n${transcript.text}`
      : `NO TRANSCRIPT IS AVAILABLE. Base the analysis only on the title and description, keep it brief, and do not invent details that are not stated there.`;

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

export async function analyzeWithGemini(params: {
  apiKey: string;
  model: string;
  metadata: VideoMetadata;
  transcript: TranscriptResult;
}): Promise<VideoAnalysis> {
  const { apiKey, model, metadata, transcript } = params;

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
        contents: [{ role: "user", parts: [{ text: buildPrompt(metadata, transcript) }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema,
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
