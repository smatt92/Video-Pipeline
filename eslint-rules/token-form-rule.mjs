/**
 * ESLint rule: the form rule.
 *
 *   --accent*  only on interactive surfaces — buttons, links, selection, focus.
 *   --state-*  only on non-interactive labels and glyphs.
 *   Never the reverse.
 *
 * Why a rule and not a convention: the two colour systems are not reliably separable by
 * hue. The accent (teal, 195) and the "ready" state (blue, 235) are 40° apart, which is
 * not a distinction anyone makes at a glance across forty rows. What *is* reliable is
 * form — a pressable filled rectangle never reads as a 9px dot. That only holds if the
 * mapping is never violated, and a mapping maintained by good intentions is a mapping
 * that lasts about a month.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * How far it sees
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Literal strings on the element, plus **one hop** through a local variable. The board
 * writes `const tint = stateColorToken(video.state)` and then `style={{ color: tint }}`,
 * which a literal-only rule would miss entirely — and the board is the screen the rule
 * most needs to cover, so the hop is worth its cost.
 *
 * Resolution handles two shapes: a variable initialised to a string containing a token,
 * and a variable initialised by a call to a function known to return one (see
 * TOKEN_RETURNING below). Both are cheap because ESLint already has the scope.
 *
 * What it still cannot see: two or more hops, tokens assembled at runtime, values passed
 * in as props, and anything crossing a module boundary other than the named functions.
 * A passing lint means nobody violated the rule in a way this can reach — not that the
 * form rule holds everywhere.
 */

const ACCENT = /var\(\s*--accent/;
const STATE = /var\(\s*--state-/;

/**
 * Functions whose return value is a token of a known family. Resolving a call is the
 * difference between covering the board and not; keeping it to an explicit list is the
 * difference between a rule and a guess.
 */
const TOKEN_RETURNING = {
  stateColorToken: 'state',
};

/** Tags that are interactive by nature. */
const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'summary',
  'Link',
  'Button',
]);

/** Props that make an otherwise inert element interactive. */
const INTERACTIVE_PROPS = new Set(['onClick', 'onKeyDown', 'onPointerDown', 'href', 'onSelect']);

const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'switch']);

function attrName(attr) {
  return attr.type === 'JSXAttribute' && attr.name?.type === 'JSXIdentifier'
    ? attr.name.name
    : null;
}

function literalOf(attr) {
  const v = attr.value;
  if (!v) return null;
  if (v.type === 'Literal' && typeof v.value === 'string') return v.value;
  return null;
}

function isInteractive(node) {
  const nameNode = node.name;
  const tag =
    nameNode.type === 'JSXIdentifier'
      ? nameNode.name
      : nameNode.type === 'JSXMemberExpression'
        ? nameNode.property.name
        : '';

  if (INTERACTIVE_TAGS.has(tag)) return true;

  for (const attr of node.attributes) {
    const n = attrName(attr);
    if (!n) continue;
    if (INTERACTIVE_PROPS.has(n)) return true;
    if (n === 'tabIndex') return true;
    // Explicit opt-in for things that are selectable rather than clickable — a row that
    // follows the keyboard cursor is a legitimate home for the accent and is not a
    // button. Marking it is better than widening the rule until it means nothing.
    if (n === 'data-selectable') return true;
    if (n === 'role') {
      const r = literalOf(attr);
      if (r && INTERACTIVE_ROLES.has(r)) return true;
    }
  }
  return false;
}

/**
 * Resolve an identifier one hop: find its declaration in scope and report what family of
 * token, if any, it carries.
 */
function resolveIdentifier(context, node) {
  const scope = context.sourceCode.getScope(node);
  let ref = scope;
  let variable = null;
  while (ref && !variable) {
    variable = ref.variables.find((v) => v.name === node.name) ?? null;
    ref = ref.upper;
  }
  if (!variable || variable.defs.length !== 1) return { text: '', family: null };

  const def = variable.defs[0];
  const init = def.node?.init;
  if (!init) return { text: '', family: null };

  if (init.type === 'Literal' && typeof init.value === 'string') {
    return { text: init.value, family: null };
  }
  if (init.type === 'CallExpression' && init.callee.type === 'Identifier') {
    const family = TOKEN_RETURNING[init.callee.name];
    if (family) return { text: '', family };
  }
  return { text: '', family: null };
}

/**
 * Every token reference reachable from this element's attributes: literals directly, and
 * one hop through local variables.
 */
function attributeTokens(context, node) {
  const literals = [];
  const families = new Set();

  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Literal' && typeof n.value === 'string') literals.push(n.value);
    if (n.type === 'TemplateElement' && n.value?.raw) literals.push(n.value.raw);
    if (n.type === 'Identifier') {
      const { text, family } = resolveIdentifier(context, n);
      if (text) literals.push(text);
      if (family) families.add(family);
    }
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  node.attributes.forEach(walk);

  const text = literals.join('\n');
  return {
    hasAccent: ACCENT.test(text) || families.has('accent'),
    hasState: STATE.test(text) || families.has('state'),
  };
}

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Accent on interactive surfaces only; state hues on labels only.' },
    schema: [],
    messages: {
      accentOnInert:
        'The accent is on a non-interactive element. --accent* marks things you can act ' +
        'on — buttons, links, selection, focus. A label painted with it claims to be ' +
        'actionable and is not. Use a --text-* or --state-* token, or add ' +
        'data-selectable if this really is a selectable surface.',
      stateOnInteractive:
        'A --state-* hue is on an interactive element. State colours report; they do not ' +
        'invite action. A button in a status colour reads as the status itself. Use ' +
        '--accent for the action and let the state show on the adjacent label.',
    },
  },

  create(context) {
    if (/src[/\\]styles[/\\]/.test(context.filename)) return {};

    return {
      JSXOpeningElement(node) {
        const { hasAccent, hasState } = attributeTokens(context, node);
        if (!hasAccent && !hasState) return;

        const interactive = isInteractive(node);

        if (hasAccent && !interactive) {
          context.report({ node, messageId: 'accentOnInert' });
        }
        if (hasState && interactive) {
          context.report({ node, messageId: 'stateOnInteractive' });
        }
      },
    };
  },
};

export default rule;
