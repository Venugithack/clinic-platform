/**
 * The two tablet lint rules from TABLET.md §8.
 *
 * These exist because both rules describe failures that are invisible in
 * development and obvious in the clinic. A 32px button is perfectly clickable
 * with a mouse and a genuine problem for a pharmacist's finger next to "cancel
 * prescription"; a hover-revealed action simply does not exist on a device with
 * no cursor. Neither is caught by a type checker or by a test, so they are
 * caught here.
 */

/** Tailwind spacing steps are 0.25rem, so 44px is step 11. */
const MIN_TARGET_PX = 44;
const REM_PX = 16;

const INTERACTIVE_ELEMENTS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'summary',
  'Link',
  'Button',
]);

const HIDING_CLASSES = new Set(['hidden', 'invisible', 'opacity-0', 'sr-only']);
const REVEALING_PREFIXES = [
  'block',
  'flex',
  'grid',
  'inline',
  'inline-block',
  'inline-flex',
  'visible',
  'opacity-',
];

function classNamesOf(node) {
  const attr = node.attributes.find(
    (a) => a.type === 'JSXAttribute' && a.name?.name === 'className',
  );
  if (!attr) return null;
  if (attr.value?.type === 'Literal' && typeof attr.value.value === 'string') {
    return { text: attr.value.value, node: attr.value };
  }
  // Template literals and clsx() calls: read the static string parts only.
  if (attr.value?.type === 'JSXExpressionContainer') {
    const expr = attr.value.expression;
    if (expr.type === 'TemplateLiteral') {
      return { text: expr.quasis.map((q) => q.value.raw).join(' '), node: expr };
    }
  }
  return null;
}

function attributeValue(node, name) {
  const attr = node.attributes.find(
    (a) => a.type === 'JSXAttribute' && a.name?.name === name,
  );
  if (attr?.value?.type === 'Literal') return attr.value.value;
  return undefined;
}

function isInteractive(node) {
  const name = node.name?.name;
  if (typeof name === 'string' && INTERACTIVE_ELEMENTS.has(name)) return true;
  const role = attributeValue(node, 'role');
  if (role === 'button' || role === 'link' || role === 'checkbox') return true;
  return node.attributes.some(
    (a) => a.type === 'JSXAttribute' && a.name?.name === 'onClick',
  );
}

/** The pixel size a Tailwind height utility resolves to, or null if unknown. */
function heightInPx(token) {
  const arbitrary = /^(?:min-)?(?:h|size)-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(token);
  if (arbitrary) {
    const value = Number(arbitrary[1]);
    return arbitrary[2] === 'rem' ? value * REM_PX : value;
  }

  const step = /^(?:min-)?(?:h|size)-(\d+(?:\.\d+)?)$/.exec(token);
  if (step) return Number(step[1]) * 4;

  if (/^(?:min-)?(?:h|size)-px$/.test(token)) return 1;

  return null;
}

const minTouchTarget = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Interactive elements must be at least 44px on their smallest side (TABLET.md §2 rule 2).',
    },
    schema: [],
    messages: {
      tooSmall:
        '"{{token}}" is {{px}}px. A touch target is at least {{min}}px — 56px for anything destructive or primary (TABLET.md §2 rule 2).',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!isInteractive(node)) return;
        const classes = classNamesOf(node);
        if (!classes) return;

        for (const token of classes.text.split(/\s+/).filter(Boolean)) {
          // Responsive and state variants keep their utility after the colon.
          const bare = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token;
          const px = heightInPx(bare);
          if (px !== null && px < MIN_TARGET_PX) {
            context.report({
              node: classes.node,
              messageId: 'tooSmall',
              data: { token: bare, px: String(px), min: String(MIN_TARGET_PX) },
            });
          }
        }
      },
    };
  },
};

const noHoverOnlyAffordance = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Nothing may depend on hover: there is no cursor (TABLET.md §2 rule 1).',
    },
    schema: [],
    messages: {
      hoverOnly:
        'This element is hidden by "{{hider}}" and revealed only by "{{revealer}}". On a tablet there is no hover, so the affordance is simply invisible (TABLET.md §2 rule 1).',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const classes = classNamesOf(node);
        if (!classes) return;

        const tokens = classes.text.split(/\s+/).filter(Boolean);
        const hider = tokens.find((t) => HIDING_CLASSES.has(t));
        if (!hider) return;

        const revealer = tokens.find((t) => {
          if (!t.startsWith('hover:') && !t.includes(':hover:')) return false;
          const utility = t.slice(t.lastIndexOf(':') + 1);
          return REVEALING_PREFIXES.some((p) =>
            p.endsWith('-') ? utility.startsWith(p) : utility === p,
          );
        });
        if (!revealer) return;

        context.report({
          node: classes.node,
          messageId: 'hoverOnly',
          data: { hider, revealer },
        });
      },
    };
  },
};

export default {
  rules: {
    'min-touch-target': minTouchTarget,
    'no-hover-only-affordance': noHoverOnlyAffordance,
  },
};
