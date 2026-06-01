const { jsPDF } = require("jspdf");

const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
const pageWidth   = doc.internal.pageSize.getWidth();
const margin      = 57.6;                  // 0.8in
const textWidth   = pageWidth - 2 * margin;

doc.setFont("Helvetica", "normal");
doc.setFontSize(11);

const text = "My time at Jesmond Miranda Nursing Home has already given me experience managing complex routines and high\u2011responsibility tasks in a busy environment. As the primary Medication Assistant, I handle electronic medication administration with BESTMed, double\u2011checking orders and documentation so nurses and families can depend on what is recorded. In between medication rounds, I provide hands\u2011on care such as hygiene support, mobility assistance, and feeding, which has taught me to move efficiently while still being gentle and observant. During";

const wrapped = doc.splitTextToSize(text, textWidth - 10);
console.log("Wrapped lines:");
console.log(JSON.stringify(wrapped, null, 2));
