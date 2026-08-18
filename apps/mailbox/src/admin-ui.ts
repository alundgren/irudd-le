/**
 * A single static page, no build step and no framework, in keeping with the
 * "narrow admin web UI" scope of #32: an admin pastes their admin bearer
 * token in, then creates channels, creates/lists/revokes tokens. It is
 * served as-is by the mailbox itself so the Docker image needs no separate
 * static-asset pipeline.
 */
export const ADMIN_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Mailbox admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1rem; margin-top: 2rem; }
  label { display: block; margin-top: 0.5rem; font-size: 0.85rem; }
  input, select { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-top: 0.15rem; }
  button { margin-top: 0.75rem; padding: 0.4rem 0.9rem; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.85rem; }
  th, td { text-align: left; border-bottom: 1px solid #ddd; padding: 0.35rem 0.4rem; }
  .error { color: #b00020; white-space: pre-wrap; }
  .success { color: #0a5d24; white-space: pre-wrap; }
  .secret { background: #fff8dc; border: 1px solid #e0c840; padding: 0.6rem; margin-top: 0.5rem; word-break: break-all; }
  .revoked { color: #999; }
</style>
</head>
<body>
<h1>Mailbox admin</h1>

<label for="adminToken">Admin bearer token</label>
<input id="adminToken" type="password" placeholder="adm_..." autocomplete="off" />

<h2>Create channel</h2>
<label for="channelId">Channel id (lowercase slug)</label>
<input id="channelId" placeholder="main" />
<label for="channelName">Channel name</label>
<input id="channelName" placeholder="Main channel" />
<button id="createChannelBtn">Create channel</button>
<div id="channelSuccess" class="success" role="status" aria-live="polite"></div>
<div id="channelError" class="error"></div>

<h2>Create token</h2>
<label for="tokenKind">Kind</label>
<select id="tokenKind">
  <option value="publisher">publisher</option>
  <option value="reader">reader</option>
  <option value="admin">admin</option>
</select>
<label for="tokenChannel">Channel (required for publisher/reader)</label>
<input id="tokenChannel" placeholder="main" />
<label for="tokenLabel">Label</label>
<input id="tokenLabel" placeholder="Guide bot" />
<button id="createTokenBtn">Create token</button>
<div id="tokenError" class="error"></div>
<div id="newSecret"></div>

<h2>Tokens</h2>
<button id="refreshBtn">Refresh</button>
<table id="tokenTable">
  <thead><tr><th>Label</th><th>Kind</th><th>Channel</th><th>Created</th><th>Status</th><th></th></tr></thead>
  <tbody></tbody>
</table>

<h2>Pending targets</h2>
<p>A pending target's pairing code is shown only on its own overlay screen. Ask
whoever is looking at the device for the code before pairing.</p>
<button id="refreshTargetsBtn">Refresh</button>
<table id="targetTable">
  <thead><tr><th>Client</th><th>Content box</th><th>Code expires</th><th>Pair into</th><th></th></tr></thead>
  <tbody></tbody>
</table>
<div id="targetError" class="error"></div>

<h2>Revision history</h2>
<p>Roll back an accidental publication by picking an older retained revision.
Only the latest 20 revisions per channel are kept.</p>
<label for="historyChannel">Channel id</label>
<input id="historyChannel" placeholder="main" />
<button id="loadHistoryBtn">Load history</button>
<div id="historyError" class="error"></div>
<table id="historyTable">
  <thead><tr><th>Title</th><th>Id</th><th>Published by</th><th>Created</th><th>Current</th><th></th></tr></thead>
  <tbody></tbody>
</table>

<script>
function adminToken() { return document.getElementById('adminToken').value.trim(); }

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken(), ...(options && options.headers) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.message) || (res.status + ' ' + res.statusText));
  return body;
}

document.getElementById('createChannelBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('channelError');
  const successEl = document.getElementById('channelSuccess');
  errorEl.textContent = '';
  successEl.textContent = '';
  try {
    const created = await api('/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: 1,
        id: document.getElementById('channelId').value.trim(),
        name: document.getElementById('channelName').value.trim(),
      }),
    });
    successEl.textContent = \`Created channel '\${created.id}' (\${created.name}).\`;
  } catch (e) {
    errorEl.textContent = String(e.message || e);
  }
});

document.getElementById('createTokenBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('tokenError');
  const secretEl = document.getElementById('newSecret');
  errorEl.textContent = '';
  secretEl.innerHTML = '';
  const kind = document.getElementById('tokenKind').value;
  const channel = document.getElementById('tokenChannel').value.trim();
  try {
    const created = await api('/v1/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: 1,
        kind,
        channel: kind === 'admin' ? undefined : channel,
        label: document.getElementById('tokenLabel').value.trim(),
      }),
    });
    secretEl.innerHTML =
      '<div class="secret">Shown once — save it now:<br><strong>' + created.secret + '</strong></div>';
    await loadTokens();
  } catch (e) {
    errorEl.textContent = String(e.message || e);
  }
});

document.getElementById('refreshBtn').addEventListener('click', loadTokens);

async function loadTokens() {
  const tbody = document.querySelector('#tokenTable tbody');
  tbody.innerHTML = '';
  let data;
  try {
    data = await api('/v1/admin/tokens', { method: 'GET' });
  } catch (e) {
    return;
  }
  for (const t of data.tokens) {
    const tr = document.createElement('tr');
    if (t.revokedAt) tr.className = 'revoked';
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    };
    tr.appendChild(cell(t.label));
    tr.appendChild(cell(t.kind));
    tr.appendChild(cell(t.channel || ''));
    tr.appendChild(cell(new Date(t.createdAt).toISOString()));
    tr.appendChild(cell(t.revokedAt ? 'revoked' : 'active'));
    const actionCell = document.createElement('td');
    if (!t.revokedAt) {
      const btn = document.createElement('button');
      btn.textContent = 'Revoke';
      btn.addEventListener('click', async () => {
        await api('/v1/admin/tokens/' + encodeURIComponent(t.id), { method: 'DELETE' });
        await loadTokens();
      });
      actionCell.appendChild(btn);
    }
    tr.appendChild(actionCell);
    tbody.appendChild(tr);
  }
}

document.getElementById('refreshTargetsBtn').addEventListener('click', loadTargets);

async function loadTargets() {
  const tbody = document.querySelector('#targetTable tbody');
  const errorEl = document.getElementById('targetError');
  tbody.innerHTML = '';
  errorEl.textContent = '';
  let data;
  try {
    data = await api('/v1/admin/targets', { method: 'GET' });
  } catch (e) {
    errorEl.textContent = String(e.message || e);
    return;
  }
  for (const t of data.targets) {
    const tr = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    };
    tr.appendChild(cell(t.clientName));
    tr.appendChild(cell(t.profile.contentBox.width + '×' + t.profile.contentBox.height));
    tr.appendChild(cell(t.pairingCodeExpiresAt ? new Date(t.pairingCodeExpiresAt).toISOString() : ''));

    const pairCell = document.createElement('td');
    const channelIdInput = document.createElement('input');
    channelIdInput.placeholder = 'channel id';
    const channelNameInput = document.createElement('input');
    channelNameInput.placeholder = 'channel name';
    const codeInput = document.createElement('input');
    codeInput.placeholder = 'pairing code';
    pairCell.appendChild(channelIdInput);
    pairCell.appendChild(channelNameInput);
    pairCell.appendChild(codeInput);
    tr.appendChild(pairCell);

    const actionCell = document.createElement('td');
    const btn = document.createElement('button');
    btn.textContent = 'Pair';
    btn.addEventListener('click', async () => {
      errorEl.textContent = '';
      try {
        await api('/v1/admin/targets/' + encodeURIComponent(t.id) + '/pair', {
          method: 'POST',
          body: JSON.stringify({
            protocolVersion: 1,
            pairingCode: codeInput.value.trim(),
            channelId: channelIdInput.value.trim(),
            channelName: channelNameInput.value.trim(),
          }),
        });
        await loadTargets();
        await loadTokens();
      } catch (e) {
        errorEl.textContent = String(e.message || e);
      }
    });
    actionCell.appendChild(btn);
    tr.appendChild(actionCell);
    tbody.appendChild(tr);
  }
}

document.getElementById('loadHistoryBtn').addEventListener('click', loadHistory);

let historyCurrentRevisionId = null;

async function loadHistory() {
  const channel = document.getElementById('historyChannel').value.trim();
  const tbody = document.querySelector('#historyTable tbody');
  const errorEl = document.getElementById('historyError');
  tbody.innerHTML = '';
  errorEl.textContent = '';
  historyCurrentRevisionId = null;
  if (!channel) {
    errorEl.textContent = 'Enter a channel id first.';
    return;
  }
  let data;
  try {
    data = await api('/v1/channels/' + encodeURIComponent(channel) + '/revisions', { method: 'GET' });
  } catch (e) {
    errorEl.textContent = String(e.message || e);
    return;
  }
  for (const r of data.revisions) {
    if (r.current) historyCurrentRevisionId = r.id;
    const tr = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      return td;
    };
    tr.appendChild(cell(r.title));
    tr.appendChild(cell(r.id));
    tr.appendChild(cell(r.publishedByLabel || r.publishedBy || ''));
    tr.appendChild(cell(new Date(r.createdAt).toISOString()));
    tr.appendChild(cell(r.current ? 'current' : ''));

    const actionCell = document.createElement('td');
    if (!r.current) {
      const btn = document.createElement('button');
      btn.textContent = 'Roll back to this';
      btn.addEventListener('click', async () => {
        errorEl.textContent = '';
        try {
          await api(
            '/v1/channels/' + encodeURIComponent(channel) + '/revisions/' + encodeURIComponent(r.id) + '/rollback',
            {
              method: 'POST',
              body: JSON.stringify({
                protocolVersion: 1,
                // Not crypto.randomUUID(): that requires a secure context, and this
                // admin UI may be reached over plain HTTP on a LAN. A collision just
                // surfaces as a 409 the admin can retry, so Math.random() is enough.
                newRevisionId: 'rollback-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10),
                expectedCurrentRevisionId: historyCurrentRevisionId,
              }),
            }
          );
          await loadHistory();
        } catch (e) {
          errorEl.textContent = String(e.message || e);
        }
      });
      actionCell.appendChild(btn);
    }
    tr.appendChild(actionCell);
    tbody.appendChild(tr);
  }
}
</script>
</body>
</html>
`;
