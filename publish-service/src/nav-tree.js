/**
 * Build a navigation tree from a project directory.
 *
 * Each node: { title, slug, path, children? }
 * - title: human-readable (slug with dashes replaced by spaces, title-cased)
 * - slug: URL segment
 * - path: full URL path from project root (e.g. "/getting-started/installation")
 * - children: array of child nodes (directories only)
 */

const path = require('path');
const fs = require('fs');
const { listEntries, toSlug } = require('./fsml');

/**
 * Derive a display title from a slug.
 * "getting-started" -> "Getting Started"
 */
function titleFromSlug(slug) {
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Try to extract a title from frontmatter or first heading in a markdown file.
 * Returns null if not found.
 */
function extractTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Check for first # heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim();
  } catch {
    // ignore
  }
  return null;
}

/**
 * Build the navigation tree for a project directory.
 * @param {string} projectDir - Absolute path to the project root
 * @param {string} basePath - URL base path (e.g. "/@maxime/my-project")
 * @returns {Array} Array of tree nodes
 */
function buildNavTree(projectDir, basePath = '') {
  return buildTreeRecursive(projectDir, basePath);
}

function buildTreeRecursive(dir, parentPath) {
  const entries = listEntries(dir);
  const nodes = [];

  for (const entry of entries) {
    const urlPath = parentPath + '/' + entry.slug;

    if (entry.isDirectory) {
      const children = buildTreeRecursive(entry.fullPath, urlPath);
      // Try to get title from index.md in the directory
      const indexPath = path.join(entry.fullPath, 'index.md');
      const title = (fs.existsSync(indexPath) && extractTitle(indexPath))
        || titleFromSlug(entry.slug);

      nodes.push({
        title,
        slug: entry.slug,
        path: urlPath,
        children,
      });
    } else {
      const title = extractTitle(entry.fullPath) || titleFromSlug(entry.slug);
      nodes.push({
        title,
        slug: entry.slug,
        path: urlPath,
      });
    }
  }

  return nodes;
}

module.exports = { buildNavTree, titleFromSlug, extractTitle };
