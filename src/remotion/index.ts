import { registerRoot } from 'remotion';

import { RemotionRoot } from './root';

/**
 * The bundle entry. `src/lib/assemble/render.ts` points `@remotion/bundler` at this file.
 *
 * Separate from `root.tsx` because `registerRoot` has a side effect at import time, and a
 * module with a side effect is one the app must never import by accident. Nothing under
 * `src/app/` or `src/lib/` imports this; the only reference is a path string in the renderer.
 */
registerRoot(RemotionRoot);
