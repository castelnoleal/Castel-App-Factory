const json = (obj, status=200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ok:true});
    const url = new URL(request.url);
    if (url.pathname !== '/api/build' || !['POST','GET'].includes(request.method)) return json({error:'Not found'},404);

    try {
      const token = env.GITHUB_TOKEN;
      if (!token) return json({error:'Build service is not configured: GITHUB_TOKEN is missing.'},503);
      const owner = env.GITHUB_OWNER || 'castelnoleal';
      const repo = env.GITHUB_REPO || 'castel-app-factory';
      const branch = 'main';
      const api = `https://api.github.com/repos/${owner}/${repo}`;
      const headers = { 'authorization': `Bearer ${token}`, 'accept':'application/vnd.github+json', 'content-type':'application/json', 'user-agent':'castel-app-factory-worker' };
      const getFile = async path => fetch(`${api}/contents/${path}?ref=${branch}`, {headers});
      const put = async (path, content, message) => fetch(`${api}/contents/${path}`, {method:'PUT',headers,body:JSON.stringify({message,content,branch})});

      if (request.method === 'GET') {
        const buildId = url.searchParams.get('id');
        if (!buildId || !/^[0-9a-f-]{36}$/.test(buildId)) return json({error:'Invalid build ID'},400);
        const r = await getFile(`build-inputs/${buildId}/status.json`);
        if (r.status === 404) return json({buildId,status:'queued'});
        if (!r.ok) return json({error:'Could not read build status',detail:await r.text()},502);
        const data = await r.json();
        return json(JSON.parse(atob(data.content.replace(/\n/g,''))));
      }

      const body = await request.json();
      const required = ['appName','packageName','versionName','versionCode','sourceType'];
      for (const k of required) if (body[k] === undefined || body[k] === '') return json({error:`Missing ${k}`},400);
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(body.packageName)) return json({error:'Invalid package name'},400);
      if (!/^\d+(\.\d+){0,2}$/.test(String(body.versionName))) return json({error:'Invalid version'},400);
      if (body.sourceBase64 && body.sourceBase64.length > 8_000_000) return json({error:'Source is too large. Maximum upload size is about 6 MB.'},413);

      const buildId = crypto.randomUUID();
      const chunkSize = 700_000;
      const source = body.sourceBase64 || '';
      const chunkCount = source ? Math.ceil(source.length / chunkSize) : 0;
      const input = { ...body, sourceBase64: undefined, sourceChunkCount: chunkCount, buildId, createdAt: new Date().toISOString() };
      const encodedManifest = btoa(unescape(encodeURIComponent(JSON.stringify(input))));
      let r = await put(`build-inputs/${buildId}/manifest.json`, encodedManifest, `Queue build ${buildId}`);
      if (!r.ok) return json({error:'Could not store build manifest',detail:await r.text()},502);

      if (source) {
        for (let i=0; i<chunkCount; i++) {
          const chunk = source.slice(i * chunkSize, (i + 1) * chunkSize);
          r = await put(`build-inputs/${buildId}/source-${String(i).padStart(4,'0')}.bin`, chunk, `Store source chunk ${i + 1}/${chunkCount} for ${buildId}`);
          if (!r.ok) return json({error:`Could not store source chunk ${i + 1}`,detail:await r.text()},502);
        }
      }

      const statusPayload = btoa(unescape(encodeURIComponent(JSON.stringify({buildId,status:'queued',createdAt:input.createdAt}))));
      r = await put(`build-inputs/${buildId}/status.json`, statusPayload, `Create build status ${buildId}`);
      if (!r.ok) return json({error:'Could not create build status',detail:await r.text()},502);

      r = await fetch(`${api}/actions/workflows/build-app.yml/dispatches`, {method:'POST',headers,body:JSON.stringify({ref:branch,inputs:{build_id:buildId}})});
      if (!r.ok) return json({error:'Could not dispatch build',detail:await r.text()},502);
      return json({ok:true,buildId,status:'queued'});
    } catch (e) { return json({error:e.message||'Invalid request'},400); }
  }
};
