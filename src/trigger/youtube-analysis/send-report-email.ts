import { AbortTaskRunError, logger, task } from "@trigger.dev/sdk";
import nodemailer from "nodemailer";
import { requireEnv } from "./lib/env.js";
import { buildReportHtml, buildReportSubject, buildReportText } from "./lib/email-template.js";
import type { VideoReport } from "./lib/types.js";

export interface SendReportPayload {
  report: VideoReport;
  recipientEmail: string;
  sheetSaved: boolean;
}

/** Child task: emails the formatted report through Gmail SMTP. Retries on its own, independent of the sheet. */
export const sendAnalysisEmail = task({
  id: "send-analysis-email",
  retry: { maxAttempts: 3 },
  run: async ({ report, recipientEmail, sheetSaved }: SendReportPayload) => {
    const gmailUser = requireEnv("GMAIL_USER");
    // Google shows App Passwords as "abcd efgh ijkl mnop" — the spaces are not part of the password.
    const gmailAppPassword = requireEnv("GMAIL_APP_PASSWORD").replace(/\s+/g, "");
    const sheetId = requireEnv("GOOGLE_SHEET_ID");

    const sheetUrl = sheetSaved ? `https://docs.google.com/spreadsheets/d/${sheetId}` : null;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailAppPassword },
    });

    try {
      const info = await transporter.sendMail({
        from: `"YouTube Analysis" <${gmailUser}>`,
        to: recipientEmail,
        subject: buildReportSubject(report),
        html: buildReportHtml(report, sheetUrl),
        text: buildReportText(report, sheetUrl),
      });

      logger.log("Report email sent", { videoId: report.metadata.videoId, messageId: info.messageId });
      return { messageId: info.messageId };
    } catch (error) {
      // Wrong user / app password will never fix itself on retry.
      if (error && typeof error === "object" && "code" in error && error.code === "EAUTH") {
        throw new AbortTaskRunError(
          "Gmail rejected the login. Check GMAIL_USER and GMAIL_APP_PASSWORD (it must be a 16-character App Password, " +
            "not your normal Gmail password, and 2-Step Verification must be on)."
        );
      }
      throw error;
    }
  },
});
