// Minimal declaration shim — html2pdf.js doesn't ship its own types.
// Cast to the local Html2PdfBuilder/Html2PdfFactory at the call site.
declare module "html2pdf.js" {
  const html2pdf: () => unknown;
  export default html2pdf;
}
