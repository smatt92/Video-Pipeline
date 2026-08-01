'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { retireRecipe, reinstateRecipe, saveRecipe, type RecipeInput } from './library';

/**
 * Library writes. Same allowlist re-check as the onboarding actions: a Server Action is an
 * HTTP endpoint, and this one decides what gets generated and what it costs.
 */

export interface LibraryState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  problems?: string[];
}

async function requireUser() {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error('Not signed in.');
  if (!checkEmail(user.email).ok) throw new Error('Not permitted.');
}

function refresh() {
  revalidatePath('/library/prompts');
}

export async function saveRecipeAction(
  _prev: LibraryState,
  formData: FormData,
): Promise<LibraryState> {
  try {
    await requireUser();
    const db = serverClient();

    const input: RecipeInput = {
      name: String(formData.get('name') ?? ''),
      driver: String(formData.get('driver') ?? ''),
      model: String(formData.get('model') ?? ''),
      template: String(formData.get('template') ?? ''),
      params: String(formData.get('params') ?? ''),
      tags: formData.getAll('tags').map(String),
      sampleOutputUrl: String(formData.get('sample_output_url') ?? ''),
      // Defaulted to the MCP session, because that is what this table is for. Anything
      // else has to be chosen deliberately, so "manual" never becomes the accidental
      // provenance on a recipe nobody actually tested.
      discoveredIn:
        (String(formData.get('discovered_in') ?? 'claude-code-mcp') as RecipeInput['discoveredIn']) ??
        'claude-code-mcp',
    };

    const result = await saveRecipe(db, input);
    refresh();

    return result.ok
      ? {
          status: 'ok',
          message:
            `Saved "${result.name}" v${result.version}. ` +
            (result.version > 1
              ? `v${result.version - 1} is retired but kept — shots reference it.`
              : 'Re-run stage 4 on a blocked script to compile against it.'),
        }
      : { status: 'error', message: 'Not saved.', problems: result.problems };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Retire, never delete. The FK from `shots` refuses a delete anyway; this is the workflow. */
export async function retireRecipeAction(
  id: string,
  _prev: LibraryState,
  formData: FormData,
): Promise<LibraryState> {
  try {
    await requireUser();
    await retireRecipe(serverClient(), id, String(formData.get('reason') ?? ''));
    refresh();
    return { status: 'ok', message: 'Retired. It stops being selected and keeps its rows.' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function reinstateRecipeAction(
  id: string,
  _prev: LibraryState,
): Promise<LibraryState> {
  try {
    await requireUser();
    await reinstateRecipe(serverClient(), id);
    refresh();
    return { status: 'ok', message: 'Reinstated.' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
