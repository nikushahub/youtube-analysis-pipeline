import { AbortTaskRunError } from "@trigger.dev/sdk";
import { JWT } from "google-auth-library";
import type { VideoReport } from "./types.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export const SHEET_HEADERS = [
  "Analyzed At (UTC)",
  "Title",
  "Channel",
  "URL",
  "Published",
  "Duration",
  "Views",
  "Transcript Status",
  "Summary",
  "Key Takeaways",
  "Action Items",
  "Topics",
];

/**
 * Copy-pasting the key into a dashboard can keep the JSON file's quotes, turn its "\n" escapes into
 * real line breaks, or drop them entirely — and without line breaks the PEM won't parse. So rebuild it:
 * take the base64 body between the BEGIN/END markers and re-wrap it at the standard 64 characters.
 */
function normalizePrivateKey(raw: string): string {
  const key = raw.replace(/\\n/g, "\n");
  const match = key.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!match) return key.trim();

  const [, label, body] = match;
  const base64 = body.replace(/[^A-Za-z0-9+/=]/g, "");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Exchanges the service account credentials for a short-lived Sheets access token. */
export async function getSheetsAccessToken(serviceAccountEmail: string, privateKey: string): Promise<string> {
  const client = new JWT({
    email: serviceAccountEmail,
    key: normalizePrivateKey(privateKey),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("no token returned");
    return token;
  } catch (error) {
    throw new AbortTaskRunError(
      `Google service account login failed (${error instanceof Error ? error.message : String(error)}). ` +
        "Check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY."
    );
  }
}

function numbered(items: string[]): string {
  return items.length ? items.map((item, i) => `${i + 1}. ${item}`).join("\n") : "—";
}

export function reportToRow(report: VideoReport): (string | number)[] {
  const { metadata, analysis } = report;
  return [
    report.analyzedAt.replace("T", " ").slice(0, 19),
    metadata.title,
    metadata.channelTitle,
    metadata.url,
    metadata.publishedAt.slice(0, 10),
    metadata.duration,
    metadata.viewCount ?? "",
    {
      transcript: "Available",
      video: `Unavailable — analyzed the video directly (${report.transcriptNote})`,
      metadata: `Unavailable — ${report.transcriptNote}`,
    }[report.analysisSource],
    analysis.summary,
    numbered(analysis.keyTakeaways),
    numbered(analysis.actionItems),
    analysis.topics.join(", "),
  ];
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

async function sheetsFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${SHEETS_API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const detail = body?.error?.message ?? response.statusText;
    if (response.status === 403) {
      throw new AbortTaskRunError(
        `Google Sheets denied access (403): ${detail}. Share the sheet with GOOGLE_SERVICE_ACCOUNT_EMAIL as an Editor, ` +
          "and make sure the Google Sheets API is enabled in your Google Cloud project."
      );
    }
    if (response.status === 404 || response.status === 400) {
      throw new AbortTaskRunError(
        `Google Sheets request failed (${response.status}): ${detail}. Check GOOGLE_SHEET_ID and that the tab named in GOOGLE_SHEET_TAB exists.`
      );
    }
    // 429 / 5xx are temporary — a normal error lets Trigger.dev retry.
    throw new Error(`Google Sheets request failed (${response.status}): ${detail}`);
  }
  return response.json();
}

/**
 * Appends one report row to the sheet, writing the header row first if the tab is empty.
 * Uses valueInputOption=RAW so text from YouTube (e.g. a title starting with "=") is never run as a formula.
 * Returns the A1 range that was written, e.g. "'Analyses'!A5:L5".
 */
export async function appendReportRow(params: {
  token: string;
  sheetId: string;
  tab: string;
  report: VideoReport;
}): Promise<string> {
  const { token, sheetId, tab, report } = params;
  const id = encodeURIComponent(sheetId);
  const tabRange = quoteTab(tab);

  const header = (await sheetsFetch(token, `${id}/values/${encodeURIComponent(`${tabRange}!A1:L1`)}`)) as {
    values?: string[][];
  };
  const rows: (string | number)[][] = [];
  if (!header.values?.length) rows.push(SHEET_HEADERS);
  rows.push(reportToRow(report));

  const result = (await sheetsFetch(
    token,
    `${id}/values/${encodeURIComponent(`${tabRange}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) }
  )) as { updates?: { updatedRange?: string } };

  return result.updates?.updatedRange ?? "unknown range";
}
