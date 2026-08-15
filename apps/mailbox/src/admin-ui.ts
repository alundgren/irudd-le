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
  errorEl.textContent = '';
  try {
    await api('/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: 1,
        id: document.getElementById('channelId').value.trim(),
        name: document.getElementById('channelName').value.trim(),
      }),
    });
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
</script>
</body>
</html>
`;
