import fs from "node:fs";
import path from "node:path";
import type { ImportReceiptSummary, StateRootReadiness } from "./contracts.js";

function countReceiptRecords(filePath: string): number {
  const receipt = JSON.parse(fs.readFileSync(filePath, "utf8")) as { records?: unknown };
  return Array.isArray(receipt.records) ? receipt.records.length : 0;
}

export function getImportReceiptSummary(stateRoot: StateRootReadiness): ImportReceiptSummary {
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      receiptsDir: null,
      receiptCount: 0,
      recordCount: 0,
      receiptsRead: false,
      continuityLoaded: false,
      error: stateRoot.error,
    };
  }

  const receiptsDir = path.join(stateRoot.path, "imports", "receipts");
  if (!fs.existsSync(receiptsDir)) {
    return {
      receiptsDir,
      receiptCount: 0,
      recordCount: 0,
      receiptsRead: true,
      continuityLoaded: false,
      error: null,
    };
  }

  const receiptFiles = fs.readdirSync(receiptsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(receiptsDir, name));

  return {
    receiptsDir,
    receiptCount: receiptFiles.length,
    recordCount: receiptFiles.reduce((sum, filePath) => sum + countReceiptRecords(filePath), 0),
    receiptsRead: true,
    continuityLoaded: false,
    error: null,
  };
}
