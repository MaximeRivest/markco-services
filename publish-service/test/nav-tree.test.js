const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildNavTree, titleFromSlug } = require('../src/nav-tree');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navtree-test-'));

  const structure = {
    'mrmd.md': 'name: "Test"',
    '01-intro.md': '# Introduction',
    '02-getting-started': {
      '01-installation.md': '# Installation Guide',
      '02-configuration.md': '# Configuration',
    },
    '03-tutorials': {
      '01-basic.md': '# Basic Tutorial',
      '02-advanced.md': '# Advanced Patterns',
    },
    '_drafts': {
      'upcoming.md': '# Draft',
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

describe('titleFromSlug', () => {
  it('converts slug to title case', () => {
    assert.equal(titleFromSlug('getting-started'), 'Getting Started');
    assert.equal(titleFromSlug('intro'), 'Intro');
    assert.equal(titleFromSlug('a-b-c'), 'A B C');
  });
});

describe('buildNavTree', () => {
  it('builds correct tree structure', () => {
    const tree = buildNavTree(tmpDir, '/@test/proj');
    assert.equal(tree.length, 3);

    assert.equal(tree[0].title, 'Introduction');
    assert.equal(tree[0].slug, 'intro');
    assert.equal(tree[0].path, '/@test/proj/intro');
    assert.equal(tree[0].children, undefined);
  });

  it('includes children for directories', () => {
    const tree = buildNavTree(tmpDir, '/@test/proj');
    const gs = tree[1];

    assert.equal(gs.slug, 'getting-started');
    assert.equal(gs.path, '/@test/proj/getting-started');
    assert.ok(Array.isArray(gs.children));
    assert.equal(gs.children.length, 2);
    assert.equal(gs.children[0].title, 'Installation Guide');
    assert.equal(gs.children[0].path, '/@test/proj/getting-started/installation');
  });

  it('extracts titles from headings', () => {
    const tree = buildNavTree(tmpDir, '');
    const tutorials = tree[2];
    assert.equal(tutorials.children[0].title, 'Basic Tutorial');
    assert.equal(tutorials.children[1].title, 'Advanced Patterns');
  });

  it('excludes _drafts and .hidden', () => {
    const tree = buildNavTree(tmpDir, '');
    const slugs = tree.map(n => n.slug);
    assert.ok(!slugs.includes('drafts'));
    assert.ok(!slugs.includes('hidden'));
  });

  it('preserves numeric ordering', () => {
    const tree = buildNavTree(tmpDir, '');
    assert.equal(tree[0].slug, 'intro');
    assert.equal(tree[1].slug, 'getting-started');
    assert.equal(tree[2].slug, 'tutorials');
  });
});
