import { AbortTaskRunError } from "@trigger.dev/sdk";
import { Innertube } from "youtubei.js";
import type { TranscriptResult, VideoMetadata } from "./types.js";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ~150k characters ≈ 35-40k tokens: plenty for a multi-hour video, and well inside Gemini's free-tier limits.
const MAX_TRANSCRIPT_CHARS = 150_000;

/**
 * Extracts the 11-character video ID from any common YouTube link
 * (watch?v=, youtu.be/, /shorts/, /live/, /embed/, music./m. subdomains) or a bare ID.
 * Returns null if it can't find one.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  let candidate: string | null = null;

  if (host === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") {
      candidate = url.searchParams.get("v");
    } else {
      candidate = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/)?.[1] ?? null;
    }
  }

  return candidate && VIDEO_ID_RE.test(candidate) ? candidate : null;
}

/** Converts YouTube's ISO-8601 duration (e.g. "PT1H2M3S") to seconds, or null if it can't be parsed. */
function parseDurationSeconds(iso: string): number | null {
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, min, s] = m.map((v) => Number(v ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

/** Formats seconds as "1:02:03" (or "18:40" when under an hour). */
function formatDuration(seconds: number | null, iso: string): string {
  if (seconds === null) return iso || "unknown";
  const hours = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetches title, channel, stats, etc. from the YouTube Data API v3 (costs 1 unit of the free 10,000/day quota).
 * Returns null if the video doesn't exist or is private.
 */
export async function fetchMetadata(videoId: string, apiKey: string): Promise<VideoMetadata | null> {
  const params = new URLSearchParams({ part: "snippet,contentDetails,statistics", id: videoId });
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
    // Key goes in a header (not the URL) so it can never leak into logged URLs.
    headers: { "x-goog-api-key": apiKey },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const detail = body?.error?.message ?? response.statusText;
    if ([400, 401, 403].includes(response.status)) {
      throw new AbortTaskRunError(
        `YouTube Data API rejected the request (${response.status}): ${detail}. ` +
          "Check YOUTUBE_API_KEY, that 'YouTube Data API v3' is enabled, and that today's quota isn't used up."
      );
    }
    throw new Error(`YouTube Data API request failed (${response.status}): ${detail}`);
  }

  const data = (await response.json()) as {
    items?: {
      snippet?: { title?: string; channelTitle?: string; publishedAt?: string; description?: string; tags?: string[] };
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string; likeCount?: string };
    }[];
  };

  const item = data.items?.[0];
  if (!item) return null;

  const isoDuration = item.contentDetails?.duration ?? "";
  const durationSeconds = parseDurationSeconds(isoDuration);

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: item.snippet?.title ?? "(untitled)",
    channelTitle: item.snippet?.channelTitle ?? "(unknown channel)",
    publishedAt: item.snippet?.publishedAt ?? "",
    duration: formatDuration(durationSeconds, isoDuration),
    durationSeconds,
    viewCount: toNumber(item.statistics?.viewCount),
    likeCount: toNumber(item.statistics?.likeCount), // hidden like counts come back undefined
    description: item.snippet?.description ?? "",
    tags: item.snippet?.tags ?? [],
  };
}

function cleanText(text: string): string {
  return text.replace(/\[(?:Music|Applause|Laughter)\]/gi, " ").replace(/\s+/g, " ").trim();
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return { text, truncated: false };
  // Keep the beginning and the ending — conclusions and calls-to-action usually live at the end.
  const head = text.slice(0, Math.floor(MAX_TRANSCRIPT_CHARS * 0.8));
  const tail = text.slice(-Math.floor(MAX_TRANSCRIPT_CHARS * 0.2));
  return { text: `${head}\n[... middle of transcript omitted for length ...]\n${tail}`, truncated: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// YouTube only hands out downloadable caption tracks to its mobile-app clients (the web clients come back
// "UNPLAYABLE" without a proof-of-origin token, and the "Show transcript" endpoint rejects requests).
// We try each in order until one works.
const CAPTION_CLIENTS = ["ANDROID", "IOS"] as const;

async function fetchCaptionText(videoId: string, client: (typeof CAPTION_CLIENTS)[number]) {
  const youtube = await Innertube.create({ retrieve_player: false, lang: "en" });
  const info = await youtube.getBasicInfo(videoId, { client });

  const tracks = info.captions?.caption_tracks ?? [];
  if (!tracks.length) throw new Error(`no caption tracks (playability: ${info.playability_status?.status ?? "unknown"})`);

  // Prefer human-made English, then any human-made, then auto-generated English, then anything.
  const track =
    tracks.find((t) => t.kind !== "asr" && t.language_code.startsWith("en")) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks.find((t) => t.language_code.startsWith("en")) ??
    tracks[0];

  const response = await fetch(`${track.base_url}&fmt=json3`);
  if (!response.ok) throw new Error(`caption download failed (HTTP ${response.status})`);
  const raw = await response.text();
  if (!raw.trim()) throw new Error("caption download was empty");

  const json = JSON.parse(raw) as { events?: { segs?: { utf8?: string }[] }[] };
  const text = cleanText((json.events ?? []).flatMap((e) => e.segs ?? []).map((s) => s.utf8 ?? "").join(" "));
  if (!text) throw new Error("caption track contained no text");

  return { text, language: track.language_code };
}

/**
 * Gets the video's transcript for free using youtubei.js (open-source; reads the same captions YouTube shows).
 * Never throws — if every attempt fails (no captions, or YouTube blocks the request) it returns status "unavailable".
 */
export async function fetchTranscript(videoId: string): Promise<TranscriptResult> {
  const failures: string[] = [];

  for (const client of CAPTION_CLIENTS) {
    try {
      const { text, language } = await fetchCaptionText(videoId, client);
      return { status: "available", language, ...truncate(text) };
    } catch (error) {
      failures.push(`${client}: ${errorMessage(error)}`);
    }
  }

  return { status: "unavailable", reason: failures.join("; ") };
}
