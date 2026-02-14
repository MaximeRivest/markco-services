const express = require('express');
const path = require('path');
const { createPublishRouter } = require('./routes/publish');

const PORT = parseInt(process.env.PORT || '3003', 10);

// Parse --users-dir=... from argv
let usersDir = process.env.USERS_DIR || '/data/users';
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--users-dir=')) {
    usersDir = arg.split('=')[1];
  }
}

usersDir = path.resolve(usersDir);

const app = express();

// Static files (mrmd-reader bundle, etc.)
app.use('/static', express.static(path.join(__dirname, '..', 'static')));

// Publish routes
app.use('/', createPublishRouter(usersDir));

app.listen(PORT, () => {
  console.log(`publish-service listening on :${PORT} (users: ${usersDir})`);
});

module.exports = app;
