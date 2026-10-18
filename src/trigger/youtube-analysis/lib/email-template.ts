import type { VideoReport } from "./types.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function buildReportSubject(report: VideoReport): string {
  return `Video analysis: ${report.metadata.title}`;
}

function section(title: string, body: string): string {
  return `
    <tr><td style="padding:20px 28px 0">
      <h2 style="margin:0 0 10px;font-size:16px;color:#111827;text-transform:uppercase;letter-spacing:.04em">${title}</h2>
      ${body}
    </td></tr>`;
}

function list(items: string[], ordered: boolean, emptyText: string): string {
  if (!items.length) return `<p style="margin:0;color:#6b7280;font-size:14px">${emptyText}</p>`;
  const tag = ordered ? "ol" : "ul";
  const lis = items
    .map((item) => `<li style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#1f2937">${escapeHtml(item)}</li>`)
    .join("");
  return `<${tag} style="margin:0;padding-left:20px">${lis}</${tag}>`;
}

export function buildReportHtml(report: VideoReport, sheetUrl: string | null): string {
  const { metadata: m, analysis: a } = report;
  const badge = (bg: string, fg: string, label: string) =>
    `<span style="background:${bg};color:${fg};padding:3px 10px;border-radius:999px;font-size:12px">${label}</span>`;
  const transcriptBadge = {
    transcript: badge("#dcfce7", "#166534", "Transcript analyzed"),
    video: badge("#dbeafe", "#1e40af", "Analyzed by watching the video"),
    metadata: badge("#fef3c7", "#92400e", "Transcript unavailable — based on title &amp; description"),
  }[report.analysisSource];

  const topics = a.topics
    .map(
      (t) =>
        `<span style="display:inline-block;margin:0 6px 6px 0;background:#eef2ff;color:#3730a3;padding:4px 10px;border-radius:999px;font-size:12px">${escapeHtml(t)}</span>`
    )
    .join("");

  const sheetLink = sheetUrl
    ? ` · <a href="${escapeHtml(sheetUrl)}" style="color:#6b7280">Open the Google Sheet</a>`
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#111827;padding:24px 28px">
          <p style="margin:0 0 6px;color:#f87171;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase">YouTube Video Analysis</p>
          <h1 style="margin:0;color:#ffffff;font-size:22px;line-height:1.3">${escapeHtml(m.title)}</h1>
          <p style="margin:8px 0 0;color:#d1d5db;font-size:14px">${escapeHtml(m.channelTitle)}</p>
        </td></tr>

        <tr><td style="padding:20px 28px 0">
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#4b5563">
            <tr>
              <td style="padding-right:18px"><strong>Published</strong><br>${escapeHtml(formatDate(m.publishedAt))}</td>
              <td style="padding-right:18px"><strong>Duration</strong><br>${escapeHtml(m.duration)}</td>
              <td style="padding-right:18px"><strong>Views</strong><br>${formatNumber(m.viewCount)}</td>
              <td><strong>Likes</strong><br>${formatNumber(m.likeCount)}</td>
            </tr>
          </table>
          <p style="margin:14px 0 0">${transcriptBadge}</p>
          <p style="margin:16px 0 0"><a href="${escapeHtml(m.url)}" style="display:inline-block;background:#dc2626;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">Watch on YouTube</a></p>
        </td></tr>

        ${section("Summary", `<p style="margin:0;font-size:15px;line-height:1.6;color:#1f2937">${escapeHtml(a.summary)}</p>`)}
        ${section("Key takeaways", list(a.keyTakeaways, true, "No key takeaways identified."))}
        ${section("Action items", list(a.actionItems, false, "No specific action items for this video."))}
        ${a.topics.length ? section("Topics", topics) : ""}

        <tr><td style="padding:24px 28px;color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6">
          Analyzed ${escapeHtml(report.analyzedAt.replace("T", " ").slice(0, 16))} UTC${sheetLink}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function buildReportText(report: VideoReport, sheetUrl: string | null): string {
  const { metadata: m, analysis: a } = report;
  const bullets = (items: string[], ordered: boolean) =>
    items.length ? items.map((item, i) => `${ordered ? `${i + 1}.` : "-"} ${item}`).join("\n") : "(none)";

  return [
    `YOUTUBE VIDEO ANALYSIS`,
    ``,
    `${m.title}`,
    `${m.channelTitle} · ${formatDate(m.publishedAt)} · ${m.duration} · ${formatNumber(m.viewCount)} views`,
    `${m.url}`,
    {
      transcript: `Transcript analyzed.`,
      video: `No transcript available — Gemini analyzed the video itself.`,
      metadata: `Transcript unavailable — analysis is based on title & description only.`,
    }[report.analysisSource],
    ``,
    `SUMMARY`,
    a.summary,
    ``,
    `KEY TAKEAWAYS`,
    bullets(a.keyTakeaways, true),
    ``,
    `ACTION ITEMS`,
    bullets(a.actionItems, false),
    ``,
    `TOPICS: ${a.topics.join(", ") || "(none)"}`,
    ``,
    sheetUrl ? `Google Sheet: ${sheetUrl}` : ``,
  ].join("\n");
}
