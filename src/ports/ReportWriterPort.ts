/**
 * Port (interface) for persisting generated report content.
 * Implemented by adapters (e.g. local markdown files); used by use cases.
 * Deliberately thin — deciding *what* a report says is domain logic; this
 * port only knows how to write and read raw content.
 */
export interface ReportWriterPort {
  writeAnalysisReport(content: string): Promise<void>;
  writeScoutReport(content: string): Promise<void>;
  readScoutReport(): Promise<string | null>;
}
