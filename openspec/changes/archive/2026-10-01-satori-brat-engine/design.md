# Design: Satori Brat Cover Generator

## 1. Typography & Binary Search Font Fitting
- **Font**: `assets/fonts/Arimo-Regular.ttf` loaded and parsed via `@shuding/opentype.js`.
- **Measurement**:
  `measureWord(word, fontSize)` computes character advance width with `-2px` letter-spacing adjustment, estimating emoji width as `fontSize`.
- **Line Fitting**:
  `layoutLines(words, fontSize, maxW)` packs words into lines using `otFont.getAdvanceWidth(' ', fontSize) - 2`.
- **Binary Search**:
  Range `[16, 280]`. Evaluates whether total height (`lines.length * (fontSize * 0.95)`) fits inside 660px (720px - 2 * 30px padding).

## 2. Flexbox Justification in Satori
Each line is rendered as:
```ts
{
  type: 'div',
  props: {
    style: {
      display: 'flex',
      flexDirection: 'row',
      width: '100%',
      justifyContent: isLast || isSingle ? 'flex-start' : 'space-between',
      gap: isLast && !isSingle ? `${Math.round(fontSize * 0.28)}px` : '0px',
      lineHeight: 0.95,
    },
    children: lineWords.map(...)
  }
}
```

## 3. Gaussian Blur & 2x PNG Export
- Injects `<defs><filter id="brat-blur"><feGaussianBlur stdDeviation="3"/></filter></defs>` into the Satori SVG header.
- Wraps the text `<g>` container with `filter="url(#brat-blur)"`.
- Compiles via `new Resvg(blurredSvg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng()` producing a crisp 1440x1440 PNG.
