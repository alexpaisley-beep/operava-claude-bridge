/**
 * Minimal, dependency-free consent page for the built-in OAuth server.
 * The operator (a human) enters BRIDGE_OPERATOR_KEY to approve a client
 * (typically a ChatGPT connector) connecting to the bridge.
 */

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderConsentPage(params: {
  clientName: string;
  redirectHost: string;
  pendingId: string;
  errorMessage?: string;
}): string {
  const client = escapeHtml(params.clientName);
  const host = escapeHtml(params.redirectHost);
  const pendingId = escapeHtml(params.pendingId);
  const error = params.errorMessage ? `<p class="error">${escapeHtml(params.errorMessage)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Operava Claude Bridge — authorize connection</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f1115; color:#e8e8e8; display:flex; justify-content:center; padding:4rem 1rem; }
  .card { background:#1a1d24; border:1px solid #2c3040; border-radius:12px; padding:2rem; max-width:26rem; width:100%; }
  h1 { font-size:1.1rem; margin:0 0 1rem; }
  p { color:#b9bec9; font-size:.92rem; line-height:1.5; }
  code { background:#242836; padding:.1rem .35rem; border-radius:4px; }
  input[type=password] { width:100%; box-sizing:border-box; padding:.6rem .7rem; border-radius:8px; border:1px solid #3a3f52; background:#12141a; color:#fff; margin:.75rem 0 1rem; }
  .row { display:flex; gap:.75rem; }
  button { flex:1; padding:.6rem; border-radius:8px; border:0; font-weight:600; cursor:pointer; }
  .approve { background:#4f8cff; color:#fff; }
  .deny { background:#2c3040; color:#cfd3dd; }
  .error { color:#ff7a7a; font-size:.9rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize connection to Operava Claude Bridge</h1>
    <p><strong>${client}</strong> is requesting access. After approval it will be able to
    start Claude engineering tasks, run workflows, and read task results through this bridge.</p>
    <p>Redirects back to <code>${host}</code>.</p>
    ${error}
    <form method="post" action="/oauth/consent">
      <input type="hidden" name="pending_id" value="${pendingId}">
      <label for="operator_key">Operator key</label>
      <input id="operator_key" type="password" name="operator_key" autocomplete="current-password" required>
      <div class="row">
        <button class="approve" type="submit" name="action" value="approve">Approve</button>
        <button class="deny" type="submit" name="action" value="deny">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}
