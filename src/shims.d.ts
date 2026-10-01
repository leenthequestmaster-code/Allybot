declare module 'qrcode-terminal' {
  const qrcode: {
    generate(value: string, options?: { small?: boolean }): void
  }
  export default qrcode
}

declare module '@shuding/opentype.js' {
  const opentype: any
  export default opentype
}
