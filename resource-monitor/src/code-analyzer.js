import { pushEvent } from './events.js';

const GPU_PATTERNS = [
  /import\s+torch/, /from\s+torch/, /import\s+tensorflow/,
  /from\s+tensorflow/, /import\s+jax/, /import\s+cupy/,
  /import\s+rapids/, /\.cuda\(\)/, /\.to\(["']cuda["']\)/,
  /pip\s+install\s+torch/, /pip\s+install\s+tensorflow/,
  /uv\s+pip\s+install\s+torch/,
];

const BIG_RAM_PATTERNS = [
  /pd\.read_csv\(/, /read_parquet\(/, /read_feather\(/,
  /\.read_json\(.*lines/, /dask\.dataframe/,
];

/**
 * Analyze code cells before execution and emit hints.
 * @param {string} code - Source code to analyze
 * @param {{ runtime_id: string, container_name: string, host: string }} context
 * @returns {{ gpu: boolean, bigRam: boolean }} detected hints
 */
function analyzeCode(code, context) {
  const result = { gpu: false, bigRam: false };

  for (const pattern of GPU_PATTERNS) {
    if (pattern.test(code)) {
      result.gpu = true;
      break;
    }
  }

  for (const pattern of BIG_RAM_PATTERNS) {
    if (pattern.test(code)) {
      result.bigRam = true;
      break;
    }
  }

  const base = {
    runtime_id: context.runtime_id,
    container_name: context.container_name,
    host: context.host,
    timestamp: new Date().toISOString(),
  };

  if (result.gpu) {
    pushEvent({ ...base, type: 'gpu-hint' });
  }
  if (result.bigRam) {
    pushEvent({ ...base, type: 'big-ram-hint' });
  }

  return result;
}

export { analyzeCode, GPU_PATTERNS, BIG_RAM_PATTERNS };
