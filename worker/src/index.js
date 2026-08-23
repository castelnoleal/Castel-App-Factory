const json = (obj, status=200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST,OPTIONS' } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ok:true});
    const url = new URL(request.url);
    if (url.pathname !== '/api/build' || request.method !== 'POST') return json({error:'Not found'},404);
    try {
      const body = await request.json();
      const required = ['appName','packageName','versionName','versionCode','sourceType'];
      for (const k of required) if (body[k] === undefined || body[k] === '') return json({error:`Missing ${k}`},400);
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(body.packageName)) return json({error:'Invalid package name'},400);
      if (!/^\d+(\.\d+){0,2}$/.test(String(body.versionName))) return json({error:'Invalid version'},400);
      if (body.sourceBase64 && body.sourceBase64.length > 8_000_000) return json({error:'Source is too large for the GitHub-backed MVP; use a hosted ZIP or website URL.'},413);
      const buildId = crypto.randomUUID();
      const input = { ...body, sourceBase64: undefined, buildId, createdAt: new Date().toISOString() };
      const token = env.GITHUB_TOKEN;
      const owner = env.GITHUB_OWNER || 'castelnoleal';
      const repo = env.GITHUB_REPO || 'castel-app-factory';
      const branch = 'main';
      const api = `https://api.github.com/repos/${owner}/${repo}`;
      const headers = { 'authorization': `Bearer ${token}`, 'accept':'application/vnd.github+json', 'content-type':'application/json', 'user-agent':'castel-app-factory-worker' };
      const put = async (path, content, message) => fetch(`${api}/contents/${path}`, {method:'PUT',headers,body:JSON.stringify({message,content,branch})});
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(input))));
      let r = await put(`build-inputs/${buildId}/manifest.json`, encoded, `Queue build ${buildId}`);
      if (!r.ok) return json({error:'Could not store build manifest',detail:await r.text()},502);
      if (body.sourceBase64) {
        r = await put(`build-inputs/${buildId}/source.bin`, body.sourceBase64, `Store source for ${buildId}`);
        if (!r.ok) return json({error:'Could not store source',detail:await r.text()},502);
      }
      r = await fetch(`${api}/actions/workflows/build-app.yml/dispatches`, {method:'POST',headers,body:JSON.stringify({ref:branch,inputs:{build_id:buildId}})});
      if (!r.ok) return json({error:'Could not dispatch build',detail:await r.text()},502);
      return json({ok:true,buildId,status:'queued'});
    } catch (e) { return json({error:e.message||'Invalid request'},400); }
  }
};
