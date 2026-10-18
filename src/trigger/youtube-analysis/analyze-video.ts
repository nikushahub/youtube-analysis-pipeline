import { AbortTaskRunError, idempotencyKeys, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { analyzeWithGemini } from "./lib/gemini.js";
import { describeError, optionalEnv, requireEnv } from "./lib/env.js";
import type { VideoReport } from "./lib/types.js";
import { fetchMetadata, fetchTranscript, parseVideoId } from "./lib/youtube.js";
import { saveAnalysisToSheet } from "./save-to-sheet.js";
import { sendAnalysisEmail } from "./send-report-email.js";

/**
 * Main task — trigger with: { "url": "https://www.youtube.com/watch?v=...", "recipientEmail": "optional@example.com" }
 *
 * 1. Fetch video details (YouTube Data API)   2. Fetch transcript (youtubei.js, free)
 * 3. Analyze with Gemini (free tier) — from the transcript, or by watching the video if there is none
 * 4. Save a row to Google Sheets (child task)
 * 5. Email the report via Gmail (child task)
 */
export const analyzeYoutubeVideo = schemaTask({
  id: "analyze-youtube-video",
  schema: z.object({
    url: z.string().trim().min(1, "url is required"),
    recipientEmail: z.string().trim().email().optional(),
  }),
  maxDuration: 600,
  retry: { maxAttempts: 3 },
  run: async (payload) => {
    const youtubeApiKey = requireEnv("YOUTUBE_API_KEY");
    const geminiApiKey = requireEnv("GEMINI_API_KEY");
    const geminiModel = optionalEnv("GEMINI_MODEL", "gemini-flash-latest");
    const recipientEmail = payload.recipientEmail ?? requireEnv("REPORT_RECIPIENT_EMAIL");

    // 1. Video ID + details
    const videoId = parseVideoId(payload.url);
    if (!videoId) {
      throw new AbortTaskRunError(`"${payload.url}" is not a recognizable YouTube video URL`);
    }
    logger.log("Analyzing video", { videoId });

    const metadata = await fetchMetadata(videoId, youtubeApiKey);
    if (!metadata) {
      throw new AbortTaskRunError(`Video ${videoId} was not found — it may be private, deleted, or the URL is wrong`);
    }
    logger.log("Fetched video details", { title: metadata.title, channel: metadata.channelTitle });

    // 2. Transcript (never throws — falls back to title + description)
    const transcript = await fetchTranscript(videoId);
    if (transcript.status === "available") {
      logger.log("Fetched transcript", {
        characters: transcript.text.length,
        language: transcript.language,
        truncated: transcript.truncated,
      });
    } else {
      logger.warn("Transcript unavailable — Gemini will watch the video instead", { reason: transcript.reason });
    }

    // 3. AI analysis (transcript → the video itself → title + description)
    const { analysis, source, videoError } = await analyzeWithGemini({
      apiKey: geminiApiKey,
      model: geminiModel,
      metadata,
      transcript,
    });
    if (videoError) {
      logger.warn("Gemini couldn't analyze the video itself — used title and description only", { videoError });
    }
    logger.log("Gemini analysis complete", {
      source,
      keyTakeaways: analysis.keyTakeaways.length,
      actionItems: analysis.actionItems.length,
    });

    const report: VideoReport = {
      analyzedAt: new Date().toISOString(),
      metadata,
      transcriptStatus: transcript.status,
      transcriptNote:
        transcript.status === "available"
          ? `language: ${transcript.language ?? "unknown"}${transcript.truncated ? ", truncated" : ""}`
          : transcript.reason,
      analysisSource: source,
      analysis,
    };

    // 4 + 5. Deliver. Run-scoped idempotency keys mean a retry of this task reuses a child that already
    // succeeded instead of adding a duplicate row or sending a second email.
    const sheetResult = await saveAnalysisToSheet.triggerAndWait(report, {
      idempotencyKey: await idempotencyKeys.create("save-to-sheet"),
    });
    if (!sheetResult.ok) {
      logger.error("Saving to Google Sheets failed — sending the email anyway", {
        error: describeError(sheetResult.error),
      });
    }

    const emailResult = await sendAnalysisEmail.triggerAndWait(
      { report, recipientEmail, sheetSaved: sheetResult.ok },
      { idempotencyKey: await idempotencyKeys.create("send-email") }
    );

    // The child tasks already retried on their own, so don't re-run Gemini etc. for a delivery failure.
    const failures: string[] = [];
    if (!sheetResult.ok) failures.push(`Google Sheets: ${describeError(sheetResult.error)}`);
    if (!emailResult.ok) failures.push(`Email: ${describeError(emailResult.error)}`);
    if (failures.length) {
      throw new AbortTaskRunError(`Analysis finished but delivery failed — ${failures.join(" | ")}`);
    }

    return {
      videoId,
      title: metadata.title,
      transcriptStatus: report.transcriptStatus,
      analysisSource: source,
      sheetRange: sheetResult.ok ? sheetResult.output.updatedRange : null,
      emailMessageId: emailResult.ok ? emailResult.output.messageId : null,
      analysis,
    };
  },
});
