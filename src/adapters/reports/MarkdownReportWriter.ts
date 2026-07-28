import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ReportWriterPort } from "../../ports/ReportWriterPort.js";

const REPORTS_DIR = "reports";
const ANALYSIS_REPORT_FILE = "reports/REPO_ANALYSIS.md";
const SCOUT_REPORT_FILE = "reports/REPO_SCOUT_RESULTS.md";

export class MarkdownReportWriter implements ReportWriterPort {
  async writeAnalysisReport(content: string): Promise<void> {
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(ANALYSIS_REPORT_FILE, content, "utf8");
  }

  async writeScoutReport(content: string): Promise<void> {
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(SCOUT_REPORT_FILE, content, "utf8");
  }

  async readScoutReport(): Promise<string | null> {
    try {
      return await readFile(SCOUT_REPORT_FILE, "utf8");
    } catch {
      return null;
    }
  }
}
