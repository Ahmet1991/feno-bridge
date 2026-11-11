/** Expected operational states, distinct from a missing or insufficient local grant. */
export class PcOperationError extends Error {
  constructor(readonly code: "pc_focus_required" | "pc_file_not_found" | "pc_terminal_busy"
    | "pc_job_busy" | "pc_job_history_full" | "pc_sha_mismatch") {
    super(code);
    this.name = "PcOperationError";
  }
}
