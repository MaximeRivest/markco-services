/**
 * Generate the HTML shell for a published page.
 */

function renderHtml({ title, navTree, content, outputs }) {
  const navTreeJson = JSON.stringify(navTree);
  const contentJson = JSON.stringify(content);
  const outputsJson = JSON.stringify(outputs || {});

  const BACKTICK = '`';
  const TRIPLE = BACKTICK + BACKTICK + BACKTICK;

  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>' + escapeHtml(title) + ' \u2014 markco.dev</title>',
    '  <script src="/static/mrmd-reader.iife.js"><\/script>',
    '  <style>',
    '    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #333; }',
    '    #app { display: flex; min-height: 100vh; }',
    '    #nav { width: 240px; border-right: 1px solid #eee; padding: 16px; font-size: 14px; }',
    '    #nav ul { list-style: none; padding: 0; margin: 0; }',
    '    #nav li { padding: 6px 8px; }',
    '    #nav a { text-decoration: none; color: #555; }',
    '    #nav a:hover { color: #000; }',
    '    #editor { flex: 1; padding: 24px 40px; max-width: 800px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="app">',
    '    <nav id="nav"></nav>',
    '    <main id="editor"></main>',
    '  </div>',
    '  <script>',
    '    var navTree = ' + navTreeJson + ';',
    '    var content = ' + contentJson + ';',
    '    var outputs = ' + outputsJson + ';',
    '',
    '    // Render nav',
    '    (function() {',
    '      var nav = document.getElementById("nav");',
    '      var ul = document.createElement("ul");',
    '      navTree.forEach(function(item) {',
    '        var li = document.createElement("li");',
    '        var a = document.createElement("a");',
    '        a.href = item.path || "#";',
    '        a.textContent = item.title;',
    '        li.appendChild(a);',
    '        ul.appendChild(li);',
    '      });',
    '      nav.appendChild(ul);',
    '    })();',
    '',
    '    // Render content',
    '    (function() {',
    '      try {',
    '        if (window.mrmd && typeof mrmd.create === "function") {',
    '          mrmd.create(document.getElementById("editor"), {',
    '            doc: content,',
    '            readonly: true,',
    '            toolbar: false,',
    '          });',
    '          return;',
    '        }',
    '      } catch(e) {',
    '        console.error("mrmd.create failed:", e);',
    '      }',
    '      // Fallback: basic markdown rendering',
    '      var html = content',
    '        .replace(/^### (.+)$/gm, "<h3>$1</h3>")',
    '        .replace(/^## (.+)$/gm, "<h2>$1</h2>")',
    '        .replace(/^# (.+)$/gm, "<h1>$1</h1>")',
    '        .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")',
    '        .replace(/^- (.+)$/gm, "<li>$1</li>")',
    '        .replace(/\\n\\n/g, "<br><br>");',
    '      document.getElementById("editor").innerHTML = html;',
    '    })();',
    '  <\/script>',
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { renderHtml };
