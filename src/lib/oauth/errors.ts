/**
 * An OAuth refusal with a name.
 *
 * `error` is the RFC 6749 code a client branches on; `kiln` is this server's own name for
 * the precise reason, which goes into `error_description` and onto the error page. A
 * connector that fails to connect shows the description to the person holding the phone,
 * and "invalid_request" alone sends them to read source code.
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_target'
  | 'server_error';

export class OAuthError extends Error {
  constructor(
    readonly error: OAuthErrorCode,
    /** This server's specific reason, e.g. `redirect_uri_not_allowed`. */
    readonly kiln: string,
    readonly detail: string,
    readonly status = 400,
  ) {
    super(`${kiln}: ${detail}`);
    this.name = 'OAuthError';
  }

  get description(): string {
    return `${this.kiln}: ${this.detail}`;
  }

  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}
