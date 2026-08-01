import 'server-only';

import { serverClient } from '../db/server';
import { INTEGRATION_CATALOG, type IntegrationDescriptor } from '../drivers/catalog';
import { describeSecrets, type SecretDescriptor } from '../integrations/vault';
import { integrationForStep } from './step-integration';

/**
 * Everything a wizard step needs to render, read once on the server.
 *
 * The three states are derived here rather than in the component, because the derivation is
 * the part worth getting right and a component that computes it inline will disagree with
 * the next component that does.
 *
 *   never_run   nothing has been attempted
 *   failed      attempted, and not verified since
 *   verified    attempted and accepted
 *
 * `last_verified_at >= last_checked_at` rather than "verified is not null": an integration
 * that worked in March and failed this morning is *failed*, and a check that only asked
 * whether it had ever worked would show a green tick over a broken credential.
 */

export type CheckState = 'never_run' | 'failed' | 'verified';

export interface StepIntegrationView {
  slug: string;
  label: string;
  descriptor: IntegrationDescriptor;
  state: CheckState;
  lastCheckedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  isEnabled: boolean;
  /** Write-only fields: what is configured, never what it is. */
  secrets: SecretDescriptor[];
  /** Latest result per named check. */
  checks: { name: string; passed: boolean; detail: string; checkedAt: string }[];
  /** Non-secret facts the last probe learned — model list, plan tier, motion count. */
  config: Record<string, unknown>;
}

function stateOf(row: {
  last_checked_at: string | null;
  last_verified_at: string | null;
}): CheckState {
  if (!row.last_checked_at) return 'never_run';
  if (!row.last_verified_at) return 'failed';
  return row.last_verified_at >= row.last_checked_at ? 'verified' : 'failed';
}

export async function integrationView(slug: string): Promise<StepIntegrationView | null> {
  const descriptor = INTEGRATION_CATALOG.find((i) => i.slug === slug);
  if (!descriptor) return null;

  // Service-role: `integration_secrets` and the checks are not readable with the anon key,
  // by design (0007). Nothing secret crosses back — `describeSecrets` returns last_4 and
  // timestamps and that is the whole surface.
  const db = serverClient();

  const { data: integration } = await db
    .from('integrations')
    .select('id, is_enabled, last_checked_at, last_verified_at, last_error, config')
    .eq('slug', slug)
    .maybeSingle();

  if (!integration) return null;

  const [secrets, checksResult] = await Promise.all([
    describeSecrets(db, integration.id),
    db
      .from('integration_checks')
      .select('check_name, passed, detail, checked_at')
      .eq('integration_id', integration.id)
      .order('check_name'),
  ]);

  return {
    slug,
    label: descriptor.label,
    descriptor,
    state: stateOf(integration),
    lastCheckedAt: integration.last_checked_at,
    lastVerifiedAt: integration.last_verified_at,
    lastError: integration.last_error,
    isEnabled: integration.is_enabled,
    secrets,
    checks: (checksResult.data ?? []).map((c) => ({
      name: c.check_name,
      passed: c.passed,
      detail: c.detail ?? '',
      checkedAt: c.checked_at,
    })),
    config:
      integration.config && typeof integration.config === 'object' && !Array.isArray(integration.config)
        ? (integration.config as Record<string, unknown>)
        : {},
  };
}

/** The integration a wizard step configures, if it configures one. */
export async function stepIntegrationView(
  stepNumber: number,
): Promise<StepIntegrationView | null> {
  const slug = integrationForStep(stepNumber);
  return slug ? integrationView(slug) : null;
}

/** Every integration in the catalogue, for the settings screen. */
export async function allIntegrationViews(): Promise<StepIntegrationView[]> {
  const views = await Promise.all(INTEGRATION_CATALOG.map((d) => integrationView(d.slug)));
  return views.filter((v): v is StepIntegrationView => v !== null);
}
