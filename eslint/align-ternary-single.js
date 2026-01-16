/**
 * Enforce JSX ternary formatting:
 * - Condition on first line
 * - `?` on new line, indented
 * - `:` aligned with `?`
 *
 * Good:
 *   {condition
 *     ? consequent
 *     : alternate
 *   }
 *
 * Bad:
 *   {condition ? consequent : alternate}
 *   {condition ?
 *     consequent :
 *     alternate}
 */

module.exports = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Enforce ternary formatting inside JSX: ? and : on aligned new lines',
    },
    schema: [],
  },
  create(context) {
    const sc = context.sourceCode || context.getSourceCode()

    return {
      ConditionalExpression(node) {
        // Only check ternaries where both branches are JSX elements
        const isJSX = n => n.type === 'JSXElement' || n.type === 'JSXFragment'
        if (!isJSX(node.consequent) || !isJSX(node.alternate)) return

        const testToken = sc.getLastToken(node.test)
        const questionToken = sc.getTokenAfter(node.test)
        const colonToken = sc.getTokenAfter(node.consequent)

        if (!questionToken || !colonToken) return
        if (questionToken.value !== '?' || colonToken.value !== ':') return

        const testLine = testToken.loc.end.line
        const questionLine = questionToken.loc.start.line
        const colonLine = colonToken.loc.start.line
        const questionCol = questionToken.loc.start.column
        const colonCol = colonToken.loc.start.column

        // ? must be on line after condition
        if (questionLine <= testLine) {
          context.report({
            node,
            loc: questionToken.loc,
            message: 'In JSX ternaries, `?` should be on a new line after the condition',
          })
          return
        }

        // : must be on its own line
        const consequentLastToken = sc.getLastToken(node.consequent)
        if (colonLine <= consequentLastToken.loc.end.line) {
          context.report({
            node,
            loc: colonToken.loc,
            message: 'In JSX ternaries, `:` should be on a new line',
          })
          return
        }

        // ? and : must be aligned
        if (questionCol !== colonCol) {
          context.report({
            node,
            loc: colonToken.loc,
            message: `In JSX ternaries, \`:\` (column ${colonCol}) must align with \`?\` (column ${questionCol})`,
          })
        }
      },
    }
  },
}
