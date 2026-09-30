export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

/**
 * A newer native Codex instruction (steering) superseded the running response. Unlike other
 * cancellations its ChatGPT conversation stays valid: the next request continues in it.
 */
export class ChatGptTurnSupersededError extends ChatGptWebAdapterError {}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptTurnSupersededError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

/**
 * Nothing was sent: the page no longer shows the conversation a resumed turn depends on. Retrying
 * is safe and correct, because the launcher never reuses a tab whose turn failed, so the retry opens
 * a new conversation and sends the full context.
 */
export function chatGptRetainedConversationLostError(moment: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer on its page, so nothing was sent. Retry to resend the full context.",
    {
      status: 503,
      errorType: "server_error",
      code: "retained_conversation_lost",
      retryable: true,
      cause: new Error(`retained conversation lost ${moment}`),
    },
  );
}

/**
 * 29.09 00:08: ChatGPT ended the session server-side; every turn then failed as
 * "page.goto: net::ERR_ABORTED", because the launcher stops a turn tab from following the redirect
 * to sign-in. Retrying cannot help until someone signs in, so this is not retryable. Not a 401:
 * this is the ChatGPT browser's session, not the Codex client's credentials.
 */
export function chatGptSignInRequiredError(cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT signed this browser out. Sign in again from Feno Bridge (Setup → Sign in), then retry the task.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "chatgpt_sign_in_required",
      retryable: false,
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
