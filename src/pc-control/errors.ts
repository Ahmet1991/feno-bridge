export class PcOperationError extends Error {
  constructor(readonly code: 'pc_focus_required'|'pc_input_failed'|'pc_file_not_found'|'pc_terminal_busy'|'pc_job_busy'
    |'pc_job_history_full'|'pc_sha_mismatch'|'pc_resource_busy'|'pc_resource_coordination_required'
    |'pc_resource_recovery_required'|'pc_resource_cancelled'|'pc_resource_timeout'
    |'pc_helper_missing'|'pc_helper_untrusted'|'pc_invalid_argument'|'pc_file_too_large'
    |'pc_file_exists'|'pc_sensitive_path'|'pc_path_is_file'|'pc_desktop_unavailable'|'pc_desktop_locked'|'pc_helper_timeout'|'pc_helper_failed'|'pc_grant_changed'
    |'pc_browser_not_found'|'pc_browser_start_failed'|'pc_browser_tab_not_found'|'pc_browser_ref_stale'|'pc_browser_screenshot_stale'|'pc_browser_timeout'|'pc_browser_url_blocked',
    readonly details?:{field?:string;reason?:string;allowedValues?:readonly string[];limitBytes?:number;sizeBytes?:number}) {
    super(code); this.name='PcOperationError';
  }
}
export const invalidPcArgument=(field:string,reason:string,allowedValues?:readonly string[])=>
  new PcOperationError('pc_invalid_argument',{field,reason,...(allowedValues?{allowedValues}: {})});
