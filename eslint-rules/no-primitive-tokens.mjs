/**
 * ESLint rule: components may not reference design primitives directly.
 *
 * The token system has three layers — primitives (`--k-*`, raw OKLCH ramps), semantic
 * (`--accent`, `--surface-1`, `--state-generating`), and component. Components are
 * allowed the second and third. They are not allowed the first.
 *
 * Without enforcement this collapses within a month. Someone needs a colour, the semantic
 * layer has no name for it, and `var(--k-neutral-4)` is right there. Do that forty times
 * and swapping the accent stops being a one-line change — which was the entire reason for
 * the layers.
 *
 * When this fires, the fix is almost never to pick a different primitive. It is that the
 * semantic layer is missing a name. Add the name in src/styles/tokens.css, then use it.
 *
 * Also catches raw `oklch(...)` / hex literals in component files, which are the same
 * mistake wearing a different hat.
 */

const PRIMITIVE_REF = /--k-[a-z]/;
const RAW_COLOUR = /\boklch\(|\brgba?\(|#[0-9a-fA-F]{3,8}\b/;

/** Files permitted to define and reference primitives. */
const TOKEN_FILE = /src[/\\]styles[/\\]/;

function checkText(context, node, text) {
  if (PRIMITIVE_REF.test(text)) {
    context.report({
      node,
      messageId: 'primitive',
      data: { match: text.match(/--k-[a-z0-9-]+/)?.[0] ?? '--k-*' },
    });
    return;
  }
  if (RAW_COLOUR.test(text)) {
    context.report({ node, messageId: 'rawColour' });
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow design primitives and raw colour values outside the token layer.',
    },
    schema: [],
    messages: {
      primitive:
        'Component references the primitive token "{{match}}" directly. Components may ' +
        'only use semantic tokens (--accent, --surface-1, --state-*). If none fits, the ' +
        'semantic layer is missing a name — add it in src/styles/tokens.css.',
      rawColour:
        'Raw colour value in a component. Colour belongs in src/styles/tokens.css, ' +
        'behind a semantic name, so that changing it is one edit rather than forty.',
    },
  },

  create(context) {
    if (TOKEN_FILE.test(context.filename)) return {};

    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(context, node, node.value);
      },
      TemplateElement(node) {
        if (node.value?.raw) checkText(context, node, node.value.raw);
      },
      JSXText(node) {
        if (node.value) checkText(context, node, node.value);
      },
    };
  },
};

export default rule;
