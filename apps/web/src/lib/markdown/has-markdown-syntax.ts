// A cheap pre-check: does this text contain anything Markdown would treat
// specially? Short plain-text replies ("Done.", "Yes, that looks right.")
// are extremely common and gain nothing from going through the full
// react-markdown/remark-gfm/rehype-sanitize pipeline — this lets
// `MarkdownMessage` skip straight to plain text for them (6.5).
const MARKDOWN_SIGNAL = /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)|[*_~[\]`]|https?:\/\/|\bwww\./;

export function hasMarkdownSyntax(text: string): boolean {
  return MARKDOWN_SIGNAL.test(text);
}
