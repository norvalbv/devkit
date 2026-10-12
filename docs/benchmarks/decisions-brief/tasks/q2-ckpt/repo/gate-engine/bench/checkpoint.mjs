import { existsSync, readFileSync } from 'node:fs';

// progress-<sub>.jsonl holds one JSON object per completed bench row, appended as each one lands:
//   { "id": "row-1", "verdict": "PASS", "inputChars": 1234 }
// loadCheckpoint returns the rows a re-run can reuse instead of judging them again.
export function loadCheckpoint(file) {
  void existsSync, readFileSync; // TODO: not implemented, so every re-run starts from scratch
  return [];
}
