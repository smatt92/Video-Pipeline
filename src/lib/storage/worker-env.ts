import type { WorkerEnvVar } from '../trigger/worker-env';

/**
 * The storage half of the worker's environment manifest.
 *
 * Declared here rather than in `src/lib/trigger/worker-env.ts` for the same reason
 * `storageEnvSchema` is declared here rather than in `src/lib/env.ts`: the core of the
 * application does not know which object store is behind `StorageDriver`, and naming one
 * outside this directory is what `pnpm check:vendors` refuses.
 *
 * The worker's relationship to storage is different from the web app's and that is the
 * whole point of listing it. Vercel hands out presigned URLs and never touches a byte;
 * the worker moves the bytes. So the S3 credential pair is optional for the web deployment
 * and load-bearing here.
 */
export const storageWorkerEnv: readonly WorkerEnvVar[] = [
  {
    name: 'STORAGE_DRIVER',
    required: true,
    refusedBy:
      'The storage factory, which has no default on purpose. Every stage that writes a '
      + 'byte — ingest, assemble, voice — resolves through it.',
  },
  {
    name: 'SUPABASE_STORAGE_BUCKET',
    required: true,
    refusedBy:
      'Every upload and every presign. A missing bucket is reported as a failure and not '
      + 'created, so this being wrong is a run that fails rather than one that writes '
      + 'somewhere unexpected.',
  },
  {
    name: 'SUPABASE_S3_ACCESS_KEY_ID',
    required: true,
    refusedBy:
      'SigV4 signing. These are the S3-protocol keys from the dashboard, not the '
      + 'service-role JWT — using the latter produces a 403 that reads like a permissions '
      + 'problem rather than a wrong-credential-type one.',
  },
  {
    name: 'SUPABASE_S3_SECRET_ACCESS_KEY',
    required: true,
    refusedBy: 'The other half of the pair above. Absent, every signed request is rejected.',
  },
  {
    name: 'SUPABASE_S3_REGION',
    required: false,
    refusedBy:
      'Defaults to us-east-1. Required by the signing algorithm even though the endpoint '
      + 'is fixed, so the default is a formality rather than a guess about the world.',
  },
  {
    name: 'SUPABASE_S3_ENDPOINT',
    required: false,
    refusedBy:
      'Derived from the project URL when absent, which is correct for a normal project. '
      + 'Set it only when fronting storage with a custom domain.',
  },
  {
    name: 'KILN_LOCAL_STORAGE_ROOT',
    required: false,
    refusedBy:
      'The local filesystem driver only, which exists so the harnesses can move real bytes '
      + 'without a network. Never set on a deployed worker.',
  },
];
