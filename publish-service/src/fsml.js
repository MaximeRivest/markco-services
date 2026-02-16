/**
 * FSML — Filesystem-to-URL mapping for markco.dev publish service.
 *
 * Rules:
 *   - Strip leading numeric prefix: "02-getting-started" -> "getting-started"
 *   - Strip .md extension
 *   - Match URL path segments to filesystem entries case-insensitively
 *   - _ prefixed entries are NOT published (except _assets/)
 *   - . prefixed entries are hidden
 */

const fs = require('fs');
const path = require('path');

const NUMERIC_PREFIX_RE = /^\d+-/;

/**
 * Strip the leading numeric prefix from a filename or dirname.
 * "02-getting-started" -> "getting-started"
 * "hello" -> "hello"
 */
function stripNumericPrefix(name) {
  return name.replace(NUMERIC_PREFIX_RE, '');
}

/**
 * Strip .md extension from a filename.
 */
function stripMdExtension(name) {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Convert a filesystem entry name to its URL slug.
 */
function toSlug(name) {
  return stripMdExtension(stripNumericPrefix(name));
}

/**
 * Returns true if the entry should be excluded from publishing.
 * Underscore-prefixed items are excluded (except _assets).
 * Dot-prefixed items are always excluded.
 */
function isExcluded(name) {
  if (name.startsWith('.')) return true;
  if (name.startsWith('_')) return true;
  return false;
}


/**
 * List visible (publishable) entries in a directory, sorted by their
 * original name (which preserves numeric-prefix ordering).
 * Returns array of { name, slug, fullPath, isDirectory }.
 */
function listEntries(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(e => !isExcluded(e.name))
    .filter(e => e.isDirectory() || e.name.endsWith('.md'))
    .filter(e => e.name !== 'mrmd.md')
    .map(e => ({
      name: e.name,
      slug: toSlug(e.name),
      fullPath: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Resolve a URL path (e.g. ["getting-started", "installation"]) to a
 * filesystem path inside projectDir.
 *
 * Returns { filePath, segments } or null if not found.
 * - filePath: absolute path to the .md file
 * - segments: matched slug segments (for breadcrumbs etc.)
 */
function resolve(projectDir, urlSegments) {
  // Filter out empty segments (trailing slashes, double slashes)
  const segments = urlSegments.filter(Boolean);

  if (segments.length === 0) {
    // Root: look for index.md or the first .md file
    const indexPath = path.join(projectDir, 'index.md');
    if (fs.existsSync(indexPath)) {
      return { filePath: indexPath, segments: [] };
    }
    // Fallback: first .md entry
    const entries = listEntries(projectDir);
    const first = entries.find(e => !e.isDirectory);
    if (first) return { filePath: first.fullPath, segments: [first.slug] };
    return null;
  }

  let currentDir = projectDir;

  for (let i = 0; i < segments.length; i++) {
    const target = segments[i].toLowerCase();
    const entries = listEntries(currentDir);
    const isLast = i === segments.length - 1;

    if (isLast) {
      // Try to match a file first
      const fileMatch = entries.find(
        e => !e.isDirectory && e.slug.toLowerCase() === target
      );
      if (fileMatch) {
        return { filePath: fileMatch.fullPath, segments };
      }

      // Try directory with index.md inside
      const dirMatch = entries.find(
        e => e.isDirectory && e.slug.toLowerCase() === target
      );
      if (dirMatch) {
        const indexPath = path.join(dirMatch.fullPath, 'index.md');
        if (fs.existsSync(indexPath)) {
          return { filePath: indexPath, segments };
        }
        // Fallback: first file in that directory
        const subEntries = listEntries(dirMatch.fullPath);
        const first = subEntries.find(e => !e.isDirectory);
        if (first) {
          return { filePath: first.fullPath, segments: [...segments, first.slug] };
        }
      }
      return null;
    }

    // Not last segment: must match a directory
    const dirMatch = entries.find(
      e => e.isDirectory && e.slug.toLowerCase() === target
    );
    if (!dirMatch) return null;
    currentDir = dirMatch.fullPath;
  }

  return null;
}

module.exports = {
  stripNumericPrefix,
  stripMdExtension,
  toSlug,
  isExcluded,
  listEntries,
  resolve,
};
