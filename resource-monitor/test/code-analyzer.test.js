import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCode } from '../src/code-analyzer.js';
import { bus } from '../src/events.js';

const ctx = { runtime_id: 'test-1', container_name: 'rt-test', host: 'localhost' };

describe('code-analyzer', () => {
  it('detects torch import as gpu-hint', () => {
    const events = [];
    bus.on('gpu-hint', (e) => events.push(e));
    const result = analyzeCode('import torch\nmodel = torch.nn.Linear(10, 5)', ctx);
    bus.removeAllListeners('gpu-hint');
    assert.equal(result.gpu, true);
    assert.equal(result.bigRam, false);
    assert.equal(events.length, 1);
  });

  it('detects tensorflow from-import', () => {
    const result = analyzeCode('from tensorflow.keras import layers', ctx);
    assert.equal(result.gpu, true);
  });

  it('detects jax import', () => {
    const result = analyzeCode('import jax\nimport jax.numpy as jnp', ctx);
    assert.equal(result.gpu, true);
  });

  it('detects .cuda() call', () => {
    const result = analyzeCode('model = model.cuda()', ctx);
    assert.equal(result.gpu, true);
  });

  it('detects .to("cuda")', () => {
    const result = analyzeCode('x = tensor.to("cuda")', ctx);
    assert.equal(result.gpu, true);
  });

  it('detects pd.read_csv as big-ram-hint', () => {
    const events = [];
    bus.on('big-ram-hint', (e) => events.push(e));
    const result = analyzeCode('import pandas as pd\ndf = pd.read_csv("big.csv")', ctx);
    bus.removeAllListeners('big-ram-hint');
    assert.equal(result.bigRam, true);
    assert.equal(result.gpu, false);
    assert.equal(events.length, 1);
  });

  it('detects read_parquet', () => {
    const result = analyzeCode('df = pd.read_parquet("data.parquet")', ctx);
    assert.equal(result.bigRam, true);
  });

  it('detects dask.dataframe', () => {
    const result = analyzeCode('import dask.dataframe as ddf', ctx);
    assert.equal(result.bigRam, true);
  });

  it('detects both gpu and big-ram', () => {
    const result = analyzeCode('import torch\ndf = pd.read_csv("x.csv")', ctx);
    assert.equal(result.gpu, true);
    assert.equal(result.bigRam, true);
  });

  it('returns false for plain code', () => {
    const result = analyzeCode('x = 1 + 2\nprint(x)', ctx);
    assert.equal(result.gpu, false);
    assert.equal(result.bigRam, false);
  });

  it('detects pip install torch', () => {
    const result = analyzeCode('!pip install torch torchvision', ctx);
    assert.equal(result.gpu, true);
  });

  it('detects uv pip install torch', () => {
    const result = analyzeCode('!uv pip install torch', ctx);
    assert.equal(result.gpu, true);
  });
});
