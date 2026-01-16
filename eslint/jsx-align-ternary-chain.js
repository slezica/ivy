/**
 * Align chained ternaries flat (no progressive indent).
 */

module.exports = {
  meta: {
    type: 'layout',
    docs: { description: 'Align chained ternaries flat (no progressive indent)' },
    fixable: 'whitespace',
    schema: []
  },
  create(context) {
    const sc = context.getSourceCode()
    const isCond = n => n && n.type === 'ConditionalExpression'

    const firstCol = n => sc.getFirstToken(n).loc.start.column
    const isMultiline = n => sc.getFirstToken(n).loc.start.line < sc.getLastToken(n).loc.end.line

    const chainFromTop = n => {
      let top = n
      while (isCond(top.parent)) top = top.parent
      const chain = []
      let cur = top
      while (isCond(cur)) {
        chain.push(cur)
        cur = cur.alternate
      }
      return { top, chain }
    }

    const lineStartRange = line => {
      const text = sc.getText()
      let idx = 0, cur = 1
      while (cur < line) idx = text.indexOf('\n', idx) + 1, cur++
      let j = idx
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
      return [idx, j]
    }

    return {
      ConditionalExpression(node) {
        // Only act on nested links (a chain), not lone ternaries
        if (!isCond(node.parent)) return

        const { top, chain } = chainFromTop(node)
        if (!isMultiline(top) || chain.length < 2) return

        const base = firstCol(chain[0])
        const fixes = []

        for (let i = 1; i < chain.length; i++) {
          const link = chain[i]
          const tok = sc.getFirstToken(link)
          const col = tok.loc.start.column
          if (col !== base) {
            const [a, b] = lineStartRange(tok.loc.start.line)
            fixes.push(fixer => fixer.replaceTextRange([a, b], ' '.repeat(base)))
          }
        }

        // align the trailing alternate (e.g. the final "null") if it starts on a new line
        const last = chain[chain.length - 1]
        const alt = last && last.alternate
        if (alt) {
          const altTok = sc.getFirstToken(alt)
          const prevTok = sc.getTokenBefore(altTok)
          const startsNewLine = !prevTok || altTok.loc.start.line > prevTok.loc.end.line
          if (startsNewLine && altTok.loc.start.column !== base) {
            const [a, b] = lineStartRange(altTok.loc.start.line)
            fixes.push(fixer => fixer.replaceTextRange([a, b], ' '.repeat(base)))
          }
        }

        if (fixes.length) {
          context.report({
            node: top,
            message: 'Chained ternary lines must align with the first condition',
            fix(fixer) { return fixes.map(f => f(fixer)) }
          })
        }
      }
    }
  }
}
