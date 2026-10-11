try { process.loadEnvFile('.env'); } catch {}

function snippet(t){return String(t||'').replace(/\s+/g,' ').trim().slice(0,180);}

export default async function handler(req,res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const url=process.env.APPS_SCRIPT_URL, token=process.env.APPS_SCRIPT_TOKEN;
  if(!url||!token) return res.status(500).json({error:'Vercel is missing APPS_SCRIPT_URL or APPS_SCRIPT_TOKEN.'});
  let upstream;
  try {
    upstream=await fetch(url,{method:'POST',headers:{'content-type':'text/plain;charset=utf-8'},body:JSON.stringify({...req.body,token}),redirect:'follow'});
    const body=await upstream.text();
    const isJson=/^[\[{]/.test(body.trim());
    let payload; try { payload=JSON.parse(body); } catch (_) { payload=null; }
    if(!isJson){
      const diag =
        /unauthorized|sign in|accounts\.google/i.test(body)
          ? 'Apps Script is rejecting the request: the deployment access is not set to "Anyone" (or it is an old deployment on this URL). Re-deploy as "Anyone", then update this new URL.'
          : 'Apps Script did not return JSON. Pasting the /exec URL in an incognito window shows what is happening; a login page means the access level is wrong.';
      return res.status(502).json({error:'Apps Script returned HTTP '+upstream.status+' ('+diag+') Raw body: '+snippet(body)});
    }
    return res.status(upstream.ok?200:502).json(payload);
  } catch (error) {
    return res.status(502).json({error:'Vercel could not connect to Apps Script: '+(error&&error.message?error.message:error)+'. Verify APPS_SCRIPT_URL is the deployed /exec URL, not /dev.'});
  }
}