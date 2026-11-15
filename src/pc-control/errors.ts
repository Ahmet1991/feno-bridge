export class PcOperationError extends Error {
  constructor(readonly code: 'pc_focus_required'|'pc_file_not_found'|'pc_terminal_busy'|'pc_job_busy'
    |'pc_job_history_full'|'pc_sha_mismatch'|'pc_resource_busy'|'pc_resource_coordination_required'
    |'pc_resource_recovery_required'|'pc_resource_cancelled'|'pc_resource_timeout'
    |'pc_helper_missing'|'pc_helper_untrusted') {
    super(code); this.name='PcOperationError';
  }
}
