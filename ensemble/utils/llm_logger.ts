export function log_llm_request(
    _agentId: string,
    _providerName: string,
    _model: string,
    _requestData: unknown
): string {
    return '';
}

export function log_llm_response(_requestId: string | undefined, _responseData: unknown): void {
    // no-op
}

export function log_llm_error(_requestId: string | undefined, _errorData: unknown): void {
    // no-op
}
