import { logger, task } from "@trigger.dev/sdk";
import { requireEnv } from "./lib/env.js";
import { appendReportRow, getSheetsAccessToken } from "./lib/sheets.js";
import type { VideoReport } from "./lib/types.js";

/** Child task: appends one analysis row to the Google Sheet. Retries on its own, independent of the email. */
export const saveAnalysisToSheet = task({
  id: "save-analysis-to-sheet",
  retry: { maxAttempts: 3 },
  run: async (report: VideoReport) => {
    const serviceAccountEmail = requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    const privateKey = requireEnv("GOOGLE_PRIVATE_KEY");
    const sheetId = requireEnv("GOOGLE_SHEET_ID");
    const tab = requireEnv("GOOGLE_SHEET_TAB");

    const token = await getSheetsAccessToken(serviceAccountEmail, privateKey);
    const updatedRange = await appendReportRow({ token, sheetId, tab, report });

    logger.log("Saved analysis to Google Sheet", { videoId: report.metadata.videoId, updatedRange });
    return { updatedRange };
  },
});
