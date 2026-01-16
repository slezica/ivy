/**
 * Require a blank line between consecutive JSX sibling elements
 * when either one spans multiple lines.
 *
 * Good:
 *   <Text>Hello</Text>
 *   <Text>World</Text>
 *
 *   <Text>Hello</Text>
 *
 *   <View
 *     style={styles.foo}
 *   >
 *     <Child />
 *   </View>
 *
 * Bad:
 *   <Text>Hello</Text>
 *   <View
 *     style={styles.foo}
 *   >
 *     <Child />
 *   </View>
 */

module.exports = {
  meta: {
    type: 'layout',
    docs: {
      description:
        'Require blank line between consecutive JSX siblings when either is multi-line',
    },
    schema: [],
  },
  create(context) {
    const sc = context.sourceCode || context.getSourceCode()

    function isJSXElementOrFragment(node) {
      return node.type === 'JSXElement' || node.type === 'JSXFragment'
    }

    function isMultiLine(node) {
      return node.loc.start.line !== node.loc.end.line
    }

    function checkChildren(children) {
      // Filter to just JSX elements/fragments (ignore text, expressions, etc.)
      const elements = children.filter(isJSXElementOrFragment)

      for (let i = 0; i < elements.length - 1; i++) {
        const current = elements[i]
        const next = elements[i + 1]

        const currentMultiLine = isMultiLine(current)
        const nextMultiLine = isMultiLine(next)

        // Only enforce when at least one is multi-line
        if (!currentMultiLine && !nextMultiLine) continue

        const currentEndLine = current.loc.end.line
        const nextStartLine = next.loc.start.line
        const linesBetween = nextStartLine - currentEndLine

        // Need at least one blank line (2+ lines between end and start)
        if (linesBetween < 2) {
          context.report({
            node: next,
            loc: next.loc.start,
            message:
              'Add a blank line between consecutive JSX elements when either spans multiple lines',
          })
        }
      }
    }

    return {
      JSXElement(node) {
        if (node.children) {
          checkChildren(node.children)
        }
      },
      JSXFragment(node) {
        if (node.children) {
          checkChildren(node.children)
        }
      },
    }
  },
}
