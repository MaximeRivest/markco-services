const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  stripNumericPrefix,
  stripMdExtension,
  toSlug,
  isExcluded,
  listEntries,
  resolve,
} = require('../src/fsml');

// Create a temporary project structure for testing
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsml-test-'));

  // Build test filesystem
  const structure = {
    'mrmd.md': 'name: "Test"',
    '01-intro.md': '# Intro',
    '02-getting-started': {
      '01-installation.md': '# Installation',
      '02-configuration.md': '# Configuration',
    },
    '03-tutorials': {
      '01-basic.md': '# Basic Tutorial',
      'index.md': '# Tutorials',
    },
    '_drafts': {
      'upcoming.md': '# Draft',
    },
    '_assets': {
      'screenshot.png': 'fake-image',
    },
    '_lib': {
      'helpers.py': 'print("hi")',
    },
    '.hidden': {
      'secret.md': '# Secret',
    },
  };

  function createStructure(dir, obj) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(obj)) {
      const full = path.join(dir, name);
      if (typeof content === 'string') {
        fs.writeFileSync(full, content);
      } else {
        createStructure(full, content);
      }
    }
  }
  createStructure(tmpDir, structure);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('stripNumericPrefix', () => {
  it('strips leading digits-dash', () => {
    assert.equal(stripNumericPrefix('02-getting-started'), 'getting-started');
    assert.equal(stripNumericPrefix('1-intro'), 'intro');
    assert.equal(stripNumericPrefix('100-advanced'), 'advanced');
  });

  it('leaves names without prefix unchanged', () => {
    assert.equal(stripNumericPrefix('hello'), 'hello');
    assert.equal(stripNumericPrefix('no-prefix'), 'no-prefix');
  });
});

describe('stripMdExtension', () => {
  it('strips .md', () => {
    assert.equal(stripMdExtension('hello.md'), 'hello');
  });

  it('leaves non-.md unchanged', () => {
    assert.equal(stripMdExtension('hello.txt'), 'hello.txt');
    assert.equal(stripMdExtension('hello'), 'hello');
  });
});

describe('toSlug', () => {
  it('strips both prefix and extension', () => {
    assert.equal(toSlug('02-getting-started.md'), 'getting-started');
    assert.equal(toSlug('01-intro.md'), 'intro');
  });

  it('handles directories (no extension)', () => {
    assert.equal(toSlug('02-getting-started'), 'getting-started');
  });
});

describe('isExcluded', () => {
  it('excludes _ prefixed', () => {
    assert.equal(isExcluded('_drafts'), true);
    assert.equal(isExcluded('_lib'), true);
  });

  it('excludes _assets from navigation', () => {
    assert.equal(isExcluded('_assets'), true);
  });

  it('excludes . prefixed', () => {
    assert.equal(isExcluded('.hidden'), true);
    assert.equal(isExcluded('.git'), true);
  });

  it('does not exclude normal entries', () => {
    assert.equal(isExcluded('hello'), false);
    assert.equal(isExcluded('02-intro.md'), false);
  });
});

describe('listEntries', () => {
  it('lists publishable entries sorted by name', () => {
    const entries = listEntries(tmpDir);
    const slugs = entries.map(e => e.slug);
    assert.deepEqual(slugs, ['intro', 'getting-started', 'tutorials']);
  });

  it('excludes _drafts, _lib, .hidden, mrmd.md', () => {
    const entries = listEntries(tmpDir);
    const names = entries.map(e => e.name);
    assert.ok(!names.includes('_drafts'));
    assert.ok(!names.includes('_lib'));
    assert.ok(!names.includes('.hidden'));
    assert.ok(!names.includes('mrmd.md'));
  });

  it('returns empty for non-existent dir', () => {
    const entries = listEntries('/nonexistent/path');
    assert.deepEqual(entries, []);
  });
});

describe('resolve', () => {
  it('resolves a top-level file', () => {
    const result = resolve(tmpDir, ['intro']);
    assert.ok(result);
    assert.ok(result.filePath.endsWith('01-intro.md'));
  });

  it('resolves a nested file', () => {
    const result = resolve(tmpDir, ['getting-started', 'installation']);
    assert.ok(result);
    assert.ok(result.filePath.endsWith('01-installation.md'));
  });

  it('resolves case-insensitively', () => {
    const result = resolve(tmpDir, ['Getting-Started', 'Installation']);
    assert.ok(result);
    assert.ok(result.filePath.endsWith('01-installation.md'));
  });

  it('resolves directory with index.md', () => {
    const result = resolve(tmpDir, ['tutorials']);
    assert.ok(result);
    assert.ok(result.filePath.endsWith('index.md'));
  });

  it('resolves empty segments to first file', () => {
    const result = resolve(tmpDir, []);
    assert.ok(result);
    assert.ok(result.filePath.endsWith('01-intro.md'));
  });

  it('returns null for non-existent path', () => {
    const result = resolve(tmpDir, ['nonexistent']);
    assert.equal(result, null);
  });

  it('returns null for excluded paths', () => {
    const result = resolve(tmpDir, ['drafts', 'upcoming']);
    assert.equal(result, null);
  });
});
