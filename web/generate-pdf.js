const { jsPDF } = require("jspdf");
const fs = require("fs");

function renderCoverLetterPdf(templatedText) {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageWidth   = doc.internal.pageSize.getWidth();
  const pageHeight  = doc.internal.pageSize.getHeight();
  const margin      = 57.6;                  // 0.8in
  const textWidth   = pageWidth - 2 * margin;
  const fontSize    = 11;
  const lineHeight  = fontSize * 1.35;       // explicit; jsPDF default 1.15 is too tight
  const paragraphGap = lineHeight * 0.6;     // extra space for blank source lines

  doc.setFont("Helvetica", "normal");
  doc.setFontSize(fontSize);

  let yPos = margin;
  const rawLines = templatedText.split("\n");
  for (const raw of rawLines) {
    if (raw.trim() === "") {
      yPos += paragraphGap;
      continue;
    }
    const wrapped = doc.splitTextToSize(raw, textWidth - 10);
    for (const wl of wrapped) {
      if (yPos + lineHeight > pageHeight - margin) {
        doc.addPage();
        yPos = margin;
      }
      doc.text(wl.replace(/^\s+/, ""), margin, yPos, { align: "left" });
      yPos += lineHeight;
    }
  }

  return Buffer.from(new Uint8Array(doc.output("arraybuffer")));
}

const text = "My time at Jesmond Miranda Nursing Home has already given me experience managing complex routines and high responsibility tasks in a busy environment. As an Assistant, I handle electronic medication administration with BESTMED and documentation so nurses and families can depend on what is recorded. In between medication rounds, I provide hands on care such as hygiene support and feeding, which has taught me to move efficiently while still being gentle and observant. During";

const bytes = renderCoverLetterPdf(text);
fs.writeFileSync("test-output.pdf", bytes);
console.log("PDF written to test-output.pdf, bytes:", bytes.length);
