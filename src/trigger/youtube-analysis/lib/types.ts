export interface VideoMetadata {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  publishedAt: string; // ISO date from YouTube
  duration: string; // human readable, e.g. "1:02:03"
  durationSeconds: number | null; // null if YouTube's duration couldn't be parsed
  viewCount: number | null;
  likeCount: number | null;
  description: string;
  tags: string[];
}

export type TranscriptResult =
  | { status: "available"; text: string; language: string | null; truncated: boolean }
  | { status: "unavailable"; reason: string };

/** What Gemini based the analysis on: the transcript, the video itself (via its YouTube URL), or only title + description. */
export type AnalysisSource = "transcript" | "video" | "metadata";

export interface VideoAnalysis {
  summary: string;
  keyTakeaways: string[];
  actionItems: string[];
  topics: string[];
}

/** Everything the sheet and email child tasks need. Passed as a task payload, so it must be JSON-serializable. */
export interface VideoReport {
  analyzedAt: string; // ISO timestamp
  metadata: VideoMetadata;
  transcriptStatus: "available" | "unavailable";
  transcriptNote: string; // e.g. language, truncation, or why it was unavailable
  analysisSource: AnalysisSource;
  analysis: VideoAnalysis;
}
