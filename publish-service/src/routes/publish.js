const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const { resolve } = require('../fsml');
const { buildNavTree } = require('../nav-tree');
const { renderHtml } = require('../html-shell');

/**
 * Create the publish router.
 * @param {string} usersDir - Path to the users data directory
 */
function createPublishRouter(usersDir) {
  const router = Router();

  /**
   * Resolve a project directory from @user/project.
   */
  function getProjectDir(user, project) {
    return path.join(usersDir, user, 'projects', project);
  }

  /**
   * Read publish config from mrmd.md in a project.
   */
  function readProjectConfig(projectDir) {
    const mrmdPath = path.join(projectDir, 'mrmd.md');
    try {
      const raw = fs.readFileSync(mrmdPath, 'utf-8');
      // Simple YAML-like parsing for the fields we need
      const nameMatch = raw.match(/name:\s*"([^"]+)"/);
      const urlMatch = raw.match(/url:\s*"([^"]+)"/);
      const visibilityMatch = raw.match(/visibility:\s*"([^"]+)"/);
      return {
        name: nameMatch ? nameMatch[1] : null,
        url: urlMatch ? urlMatch[1] : null,
        visibility: visibilityMatch ? visibilityMatch[1] : 'public',
      };
    } catch {
      return null;
    }
  }

  /**
   * Read cached outputs for a given .md file.
   * Outputs are stored in .mrmd/outputs/ mirroring the file structure.
   */
  function readOutputs(projectDir, filePath) {
    const relative = path.relative(projectDir, filePath);
    const outputPath = path.join(projectDir, '.mrmd', 'outputs', relative + '.json');
    try {
      return JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  // Serve _assets files: /@user/project/_assets/*
  router.get('/@:user/:project/_assets/*', (req, res) => {
    const { user, project } = req.params;
    const assetPath = req.params[0]; // everything after _assets/
    const projectDir = getProjectDir(user, project);

    if (!fs.existsSync(projectDir)) {
      return res.status(404).send('Project not found');
    }

    const fullPath = path.join(projectDir, '_assets', assetPath);
    const resolved = path.resolve(fullPath);

    // Prevent directory traversal
    if (!resolved.startsWith(path.resolve(projectDir, '_assets'))) {
      return res.status(403).send('Forbidden');
    }

    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      return res.status(404).send('Asset not found');
    }

    const contentType = mime.lookup(resolved) || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(resolved).pipe(res);
  });

  // Serve published pages: /@user/project/...
  router.get('/@:user/:project', handlePage);
  router.get('/@:user/:project/*', handlePage);

  function handlePage(req, res) {
    const { user, project } = req.params;
    const pagePath = req.params[0] || '';
    const projectDir = getProjectDir(user, project);

    if (!fs.existsSync(projectDir)) {
      return res.status(404).send('Project not found');
    }

    const config = readProjectConfig(projectDir);
    if (!config) {
      return res.status(404).send('Project not configured for publishing');
    }

    const urlSegments = pagePath.split('/').filter(Boolean);
    const result = resolve(projectDir, urlSegments);

    if (!result) {
      return res.status(404).send('Page not found');
    }

    const content = fs.readFileSync(result.filePath, 'utf-8');
    const outputs = readOutputs(projectDir, result.filePath);
    const basePath = `/@${user}/${project}`;
    const navTree = buildNavTree(projectDir, basePath);

    // Derive page title from first heading or config
    const headingMatch = content.match(/^#\s+(.+)$/m);
    const pageTitle = headingMatch
      ? headingMatch[1].trim()
      : config.name || project;

    const html = renderHtml({
      title: pageTitle,
      navTree,
      content,
      outputs,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  return router;
}

module.exports = { createPublishRouter };
