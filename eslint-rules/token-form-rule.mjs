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
 * What this rule cannot see
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It matches token names in *literal* strings on a JSX element. A token threaded through
 * a variable — `const tint = stateColorToken(s)` then `style={{ color: tint }}` — is
 * invisible to it. That is a real hole, not a rounded corner: the board does exactly this
 * for state colours. It is still worth having, because the violation it does catch is the
 * one people actually write: reaching for `var(--accent)` to make a label look important.
 *
 * Do not read a passing lint as proof the form rule holds. Read it as proof nobody
 * violated it in the obvious way.
 */

const ACCENT = /var\(\s*--accent/;
const STATE = /var\(\s*--state-/;

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

/** Every string literal anywhere inside this element's own attributes. */
function attributeText(node) {
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Literal' && typeof n.value === 'string') found.push(n.value);
    if (n.type === 'TemplateElement' && n.value?.raw) found.push(n.value.raw);
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && v.type) walk(v);
    }
  };
  node.attributes.forEach(walk);
  return found.join('\n');
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
        const text = attributeText(node);
        if (!text) return;

        const interactive = isInteractive(node);

        if (ACCENT.test(text) && !interactive) {
          context.report({ node, messageId: 'accentOnInert' });
        }
        if (STATE.test(text) && interactive) {
          context.report({ node, messageId: 'stateOnInteractive' });
        }
      },
    };
  },
};

export default rule;
