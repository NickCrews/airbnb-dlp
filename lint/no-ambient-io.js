// Core code receives I/O, time and randomness from the client. This rule
// fails any direct use of fetch, Date.now, new Date(), setTimeout or Math.random.
const rule = {
  meta: { type: 'problem', docs: { description: 'core code must use the injected transport, clock and random source' } },
  create(context) {
    const report = (node, what) =>
      context.report({ node, message: `${what} is not allowed in core code; use the injected transport, clock or random source` });
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'Identifier' && (c.name === 'fetch' || c.name === 'setTimeout' || c.name === 'setInterval')) report(node, c.name);
        if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
          const obj = c.object;
          const objName = obj.type === 'Identifier' ? obj.name
            : obj.type === 'MemberExpression' && obj.object.type === 'Identifier' && obj.object.name === 'globalThis' && obj.property.type === 'Identifier' ? obj.property.name
            : null;
          const prop = c.property.name;
          if (objName === 'Date' && prop === 'now') report(node, 'Date.now');
          if (objName === 'Math' && prop === 'random') report(node, 'Math.random');
          if (objName === 'globalThis' && ['fetch', 'setTimeout', 'setInterval'].includes(prop)) report(node, `globalThis.${prop}`);
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) report(node, 'new Date()');
      },
    };
  },
};

export default { meta: { name: 'airbnb-dlp' }, rules: { 'no-ambient-io': rule } };
